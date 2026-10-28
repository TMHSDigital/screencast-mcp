/**
 * pipeline (#125): run a chain of edits as ONE ffmpeg process instead of one
 * re-encode (and one intermediate file) per tool call.
 *
 * Each step contributes filter-graph steps over the current video label, built
 * by the same helpers as the standalone tools, so a pipeline step behaves like
 * its tool. Frame size, fps, and duration are tracked through the chain so each
 * step is validated against the frame it actually receives, and times inside a
 * step (callout from/to, redact start/end, zoom keyframes) are on the timeline
 * as it is at that step (after an earlier trim or speed change).
 *
 * A leading trim becomes an input seek, the cheapest form. export_preset and
 * export_gif can only be the last step: export_preset sets the encoder; an
 * export_gif tail renders the chain to a temporary high-quality mp4 first and
 * then runs the size-budget ladder, so it is two stages. All of this is pure.
 *
 * Polish steps (#244) need passes over the media first: cut_idle uses idle
 * stretches scanned on the source and moved onto its timeline; zoom
 * follow:"clicks" moves logged clicks through earlier timing changes, crops and
 * scales; audio (loudness, noise floor) and burn_subtitles (a transcript, or a
 * file re-timed off the source's clock) come back as `pending` probes that hear
 * the audio as it reaches the step, and the caller re-plans with the results.
 * cut_idle adds a "cut" timeOp, so markers, keystroke badges, clicks and cues
 * after it land on the cut timeline.
 */
import { ScreencastError } from "./errors.js";
import { atempoChain, cropFilter, redactSteps, scaleFilter, scaledSize, type RedactRegion, type RedactOptions } from "./media.js";
import { calloutSteps, type Callout, type CalloutAssets } from "./callout.js";
import { ASPECT_DIMS, exportPresetParts, reframeFilter, type Aspect, type Platform, type ReframeFit } from "./produce.js";
import { keyframesToViews, planClickZoom, zoomFilter, DEFAULT_TRANSITION_SEC, type ClickPoint, type ZoomKeyframe } from "./zoom.js";
import { resolveQuality, type Quality } from "./targets.js";
import type { AnimExportOptions } from "./animExport.js";
import type { TimeOp } from "./chapters.js";
import { backdropSteps, type BackdropOptions } from "./backdrop.js";
import { groupBadges, keystrokeSteps, retimeBadges, type Badge, type BadgePlanOptions, type BadgeStyle, type KeystrokeAssets } from "./keystrokes.js";
import { cutFilters, cutsFor, DEFAULT_KEEP_SEC, DEFAULT_MIN_IDLE_SEC } from "./idle.js";
import { denoiseFilter, loudnessTarget, loudnormFilter, type DenoiseStrength, type LoudnessMeasurement, type LoudnessPreset } from "./audio.js";
import { subtitlesFilter, type CaptionStyle } from "./captions.js";
import { mapSpans, mapTime, type Span } from "./timeline.js";
import { cursorSteps, transformCursor, type CursorPlan, type CursorPlanOptions, type CursorStyle } from "./cursor.js";

/** What a cursor step needs (#170): the cursor planned from the event log on
 * the source's clock and pixels (moved here through earlier timing changes,
 * crops and scales), the sprite, and where its sendcmd script will be. */
export interface CursorStepAssets {
  plan: CursorPlan;
  sprite: string;
  commandsFile: string;
}

/** What a keystroke_overlay step needs: the badges planned from the event log
 * on the source's clock (retimed here through earlier trims and speed
 * changes), the font, and a text file per label. */
export interface KeystrokeStepAssets extends KeystrokeAssets {
  badges: Badge[];
}

export const MAX_PIPELINE_STEPS = 30;

export type PipelineStep =
  | { op: "trim"; start: number; end?: number; duration?: number }
  | { op: "crop"; x: number; y: number; width: number; height: number }
  | { op: "scale"; width?: number; height?: number }
  | { op: "speed"; factor: number }
  | ({ op: "redact"; regions: RedactRegion[] } & RedactOptions)
  | { op: "callout"; items: Callout[]; fontFile?: string }
  | { op: "reframe"; aspect: Aspect; fit?: ReframeFit }
  | {
      op: "zoom";
      keyframes?: ZoomKeyframe[];
      /** Plan the keyframes from the event log's clicks (#244). */
      follow?: "clicks";
      maxZoom?: number;
      holdSec?: number;
      transitionSec?: number;
    }
  | { op: "cut_idle"; minIdleSec?: number; keepSec?: number }
  | { op: "audio"; normalize?: LoudnessPreset | number; denoise?: DenoiseStrength }
  | { op: "burn_subtitles"; subtitles?: string; transcribe?: boolean; style?: CaptionStyle }
  | ({ op: "backdrop" } & BackdropOptions)
  | ({ op: "keystroke_overlay"; events?: string; fontFile?: string } & BadgePlanOptions & BadgeStyle)
  | ({ op: "cursor"; events?: string } & CursorPlanOptions & CursorStyle)
  | { op: "export_preset"; platform: Platform; fit?: ReframeFit }
  | ({ op: "export_gif" } & AnimExportOptions);

export interface SourceInfo {
  width: number;
  height: number;
  fps: number;
  durationSec: number | null;
  hasAudio: boolean;
}

/** Data a step needs that only a pass over the media can give (#244): the
 * noise floor or loudness of the audio as it reaches an `audio` step, a
 * transcript of it, or a subtitle file moved onto that step's timeline. `seek`
 * and `audio` rebuild that audio (input seek, filters so far); `ops` are the
 * timing changes before the step. */
export interface PipelinePending {
  step: number;
  kind: "noisefloor" | "loudness" | "transcribe" | "subtitles";
  seek: string[];
  audio: string[];
  ops: TimeOp[];
}

/** Probe results for an `audio` step. */
export interface AudioMeasurements {
  floorDb?: number | null;
  loudness?: LoudnessMeasurement;
  /** The audio measured silent: nothing to normalize. */
  silent?: boolean;
}

export interface PipelineOptions {
  /** An FFMETADATA file whose chapters the output gets (#174). */
  chaptersFile?: string;
  keystrokes?: Record<number, KeystrokeStepAssets>;
  cursor?: Record<number, CursorStepAssets>;
  /** Idle stretches (frozen, and silent when scanned with audio) on the source's clock, for cut_idle. */
  idle?: Span[];
  /** Logged clicks on the source's clock and pixels, per zoom step that follows them. */
  clicks?: Record<number, ClickPoint[]>;
  audio?: Record<number, AudioMeasurements>;
  /** A subtitle file already on the step's timeline, per burn_subtitles step ("" = no cues: skip). */
  subtitles?: Record<number, string>;
  /** Where libass finds the bundled fonts. */
  fontsDir?: string;
}

export interface PipelinePlan {
  /** The fused ffmpeg command. For an export_gif tail it writes `output` as a
   * temporary mp4 that the animation stage then reads. */
  args: string[];
  width: number;
  height: number;
  fps: number;
  durationSec: number | null;
  /** Set when the last step is export_gif. */
  gif?: AnimExportOptions;
  /** One line per step: what it became. */
  summary: string[];
  /** The trims, speed changes and cuts, in order, to re-time markers (#174). */
  timeOps: TimeOp[];
  /** Probes still to run, in step order; until then the plan uses stand-ins. */
  pending: PipelinePending[];
  /** Files the command reads that the plan wrote the text of (cursor sendcmd
   * scripts): the caller writes them before running it. */
  files: Array<{ path: string; content: string }>;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A probe's ffmpeg args (an audio measurement or transcript built by its own
 * helper) made to hear the audio as it reaches the pending step: the input
 * seek goes before -i and the earlier audio filters before its -af. Pure. */
export function probeArgs(args: string[], p: Pick<PipelinePending, "seek" | "audio">): string[] {
  const out = [...args];
  const af = out.indexOf("-af");
  if (af !== -1 && p.audio.length > 0) out[af + 1] = `${p.audio.join(",")},${out[af + 1]}`;
  out.splice(out.indexOf("-i"), 0, ...p.seek);
  return out;
}

/** Plan the fused command. `assets[i]` holds the files callout step i needs. */
export function planPipeline(
  input: string,
  output: string,
  steps: PipelineStep[],
  src: SourceInfo,
  assets: Record<number, CalloutAssets> = {},
  quality: Quality = "standard",
  opts: PipelineOptions = {},
): PipelinePlan {
  if (steps.length === 0) throw new ScreencastError("Give at least one step.");
  if (steps.length > MAX_PIPELINE_STEPS) throw new ScreencastError(`At most ${MAX_PIPELINE_STEPS} steps.`);
  steps.forEach((s, i) => {
    if ((s.op === "export_preset" || s.op === "export_gif") && i !== steps.length - 1) {
      throw new ScreencastError(`${s.op} must be the last step (it is step ${i + 1} of ${steps.length}).`);
    }
  });
  // A zoom moves the content within the frame over time, so a fixed redact
  // box after it would slide off the secret (#204).
  const zoomAt = steps.findIndex((s) => s.op === "zoom");
  const lateRedact = zoomAt === -1 ? -1 : steps.findIndex((s, i) => i > zoomAt && s.op === "redact");
  if (lateRedact !== -1) {
    throw new ScreencastError(
      `step ${lateRedact + 1}: redact comes after zoom (step ${zoomAt + 1}), which moves the content under a fixed box. ` +
        "Put redact before zoom, in the source's coordinates.",
    );
  }
  const redacts = steps.some((s) => s.op === "redact");
  if (steps.filter((s) => s.op === "cut_idle").length > 1) throw new ScreencastError("Use at most one cut_idle step.");

  let W = src.width;
  let H = src.height;
  let fps = src.fps;
  let dur = src.durationSec;
  const inputArgs: string[] = [];
  const extraInputs: string[] = [];
  let nextInput = 1;
  const graph: string[] = [];
  const audio: string[] = [];
  let audioReencode = false;
  let cur = "[0:v]";
  let encode: string[] | null = null;
  let gif: AnimExportOptions | undefined;
  const summary: string[] = [];
  const timeOps: TimeOp[] = [];
  const pending: PipelinePending[] = [];
  const files: PipelinePlan["files"] = [];
  // Source pixels -> current pixels (x * sx + ox), while only crops and scales
  // have changed the frame; null once a zoom, reframe or backdrop has.
  let geo: { sx: number; sy: number; ox: number; oy: number } | null = { sx: 1, sy: 1, ox: 0, oy: 0 };

  const trimRange = (s: { start: number; end?: number; duration?: number }, at: number) => {
    if (!Number.isFinite(s.start) || s.start < 0) throw new ScreencastError(`step ${at}: trim start must be a non-negative number.`);
    if ((s.end === undefined) === (s.duration === undefined)) {
      throw new ScreencastError(`step ${at}: trim takes end OR duration.`);
    }
    const end = s.end ?? s.start + s.duration!;
    if (!(end > s.start)) throw new ScreencastError(`step ${at}: trim end must be after start.`);
    if (dur !== null && s.start >= dur) {
      throw new ScreencastError(`step ${at}: trim starts at ${s.start}s, but the video is ${r3(dur)}s long at that point.`);
    }
    return { start: s.start, end: dur !== null ? Math.min(end, dur) : end };
  };

  steps.forEach((s, i) => {
    const at = i + 1;
    const tag = `p${i}`;
    const out = `[${tag}]`;
    const chain = (filter: string) => {
      graph.push(`${cur}${filter}${out}`);
      cur = out;
    };
    const pend = (kind: PipelinePending["kind"]) =>
      pending.push({ step: i, kind, seek: [...inputArgs], audio: [...audio], ops: [...timeOps] });
    switch (s.op) {
      case "trim": {
        const { start, end } = trimRange(s, at);
        if (i === 0) {
          inputArgs.push("-ss", String(start), "-t", String(r3(end - start)));
          summary.push(`trim ${start}-${r3(end)}s: input seek`);
        } else {
          chain(`trim=start=${start}:end=${r3(end)},setpts=PTS-STARTPTS`);
          audio.push(`atrim=start=${start}:end=${r3(end)},asetpts=PTS-STARTPTS`);
          summary.push(`trim ${start}-${r3(end)}s: trim filter`);
        }
        audioReencode = true;
        dur = end - start;
        timeOps.push({ op: "trim", start, end });
        break;
      }
      case "crop":
        chain(cropFilter(s, { width: W, height: H }));
        if (geo) geo = { ...geo, ox: geo.ox - s.x, oy: geo.oy - s.y };
        W = s.width;
        H = s.height;
        summary.push(`crop to ${W}x${H}`);
        break;
      case "scale": {
        const f = scaleFilter(s);
        const [w0, h0] = [W, H];
        ({ width: W, height: H } = scaledSize(W, H, s));
        if (geo) geo = { sx: (geo.sx * W) / w0, sy: (geo.sy * H) / h0, ox: (geo.ox * W) / w0, oy: (geo.oy * H) / h0 };
        chain(f);
        summary.push(`scale to ${W}x${H}`);
        break;
      }
      case "speed":
        if (!Number.isFinite(s.factor) || s.factor <= 0) throw new ScreencastError(`step ${at}: speed factor must be positive.`);
        chain(`setpts=PTS/${s.factor}`);
        audio.push(atempoChain(s.factor));
        audioReencode = true;
        if (dur !== null) dur /= s.factor;
        timeOps.push({ op: "speed", factor: s.factor });
        summary.push(`speed x${s.factor}`);
        break;
      case "redact": {
        const { steps: st, out: o } = redactSteps(s.regions, s, { width: W, height: H }, cur, tag);
        graph.push(...st);
        cur = o;
        summary.push(`redact ${s.regions.length} region(s), ${s.style ?? "box"}`);
        break;
      }
      case "callout": {
        const a = assets[i];
        if (!a) throw new ScreencastError(`Internal: missing callout assets for step ${at}.`);
        const { steps: st, out: o, extraInputs: ex } = calloutSteps(s.items, a, cur, nextInput, tag);
        graph.push(...st);
        extraInputs.push(...ex);
        nextInput += ex.length / 4;
        cur = o;
        summary.push(`callout ${s.items.length} item(s)`);
        break;
      }
      case "reframe": {
        const dim = ASPECT_DIMS[s.aspect];
        if (!dim) throw new ScreencastError(`step ${at}: unknown aspect "${s.aspect}".`);
        chain(`${reframeFilter(dim.w, dim.h, s.fit ?? "pad")},format=yuv420p`);
        geo = null;
        W = dim.w;
        H = dim.h;
        summary.push(`reframe to ${s.aspect} (${s.fit ?? "pad"})`);
        break;
      }
      case "zoom": {
        const transition = s.transitionSec ?? DEFAULT_TRANSITION_SEC;
        let kfs = s.keyframes;
        let from = "";
        if (s.follow === "clicks") {
          if (kfs) throw new ScreencastError(`step ${at}: zoom takes keyframes or follow, not both.`);
          if (!geo) {
            throw new ScreencastError(
              `step ${at}: zoom follow "clicks" must come before reframe, backdrop or another zoom; the logged click positions no longer match the frame.`,
            );
          }
          const g = geo;
          const logged = opts.clicks?.[i];
          if (!logged) throw new ScreencastError(`Internal: missing clicks for step ${at}.`);
          // Clicks are on the source's clock and pixels; move them onto this step's.
          const clicks = logged.flatMap((c) => {
            const t = mapTime(c.t, timeOps);
            const x = c.x * g.sx + g.ox;
            const y = c.y * g.sy + g.oy;
            return t !== null && x >= 0 && x < W && y >= 0 && y < H ? [{ t, x, y }] : [];
          });
          kfs = planClickZoom(clicks, W, H, { holdSec: s.holdSec, maxZoom: s.maxZoom, transition });
          from = ` from ${clicks.length} click(s)`;
        } else if (!kfs || kfs.length === 0) {
          throw new ScreencastError(`step ${at}: zoom needs keyframes, or follow: "clicks".`);
        }
        if (kfs.length === 0) {
          summary.push("zoom: no clicks in this part of the video; skipped");
          break;
        }
        chain(zoomFilter(keyframesToViews(kfs, W, H), { width: W, height: H, fps }, transition));
        geo = null;
        summary.push(`zoom ${kfs.length} keyframe(s)${from}`);
        break;
      }
      case "cut_idle": {
        if (!opts.idle) throw new ScreencastError(`Internal: missing idle scan for step ${at}.`);
        const cuts = cutsFor(mapSpans(opts.idle, timeOps), s.minIdleSec ?? DEFAULT_MIN_IDLE_SEC, s.keepSec ?? DEFAULT_KEEP_SEC);
        if (cuts.length === 0) {
          summary.push("cut_idle: no idle stretches here; nothing cut");
          break;
        }
        const f = cutFilters(cuts);
        chain(f.video);
        audio.push(f.audio);
        audioReencode = true;
        const removed = cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
        if (dur !== null) dur -= removed;
        timeOps.push({ op: "cut", spans: cuts });
        summary.push(`cut_idle ${cuts.length} stretch(es), ${r3(removed)}s removed`);
        break;
      }
      case "audio": {
        if (s.normalize === undefined && s.denoise === undefined) throw new ScreencastError(`step ${at}: audio needs normalize and/or denoise.`);
        if (!src.hasAudio) {
          summary.push("audio: the input has no audio; skipped");
          break;
        }
        const m = opts.audio?.[i];
        const did: string[] = [];
        if (s.denoise !== undefined) {
          if (m?.floorDb === undefined) pend("noisefloor");
          audio.push(denoiseFilter(s.denoise, m?.floorDb ?? null));
          did.push(`denoise ${s.denoise}`);
        }
        if (s.normalize !== undefined && m?.silent) did.push("silent, not normalized");
        else if (s.normalize !== undefined) {
          const t = loudnessTarget(s.normalize);
          if (!m?.loudness) pend("loudness");
          // loudnorm works at 192 kHz internally; set the rate back.
          audio.push(loudnormFilter(t, m?.loudness), "aresample=48000");
          did.push(`normalize to ${t.i} LUFS${m?.loudness ? ` (measured ${m.loudness.input_i})` : ""}`);
        }
        audioReencode = true;
        summary.push(`audio: ${did.join(", ")}`);
        break;
      }
      case "burn_subtitles": {
        if (!s.subtitles === !s.transcribe) throw new ScreencastError(`step ${at}: burn_subtitles takes subtitles (a path) or transcribe: true.`);
        if (s.transcribe && !src.hasAudio) throw new ScreencastError(`step ${at}: transcribe needs audio, and the input has none.`);
        const file = opts.subtitles?.[i];
        if (file === "") {
          summary.push("burn_subtitles: no cues in this part of the video; skipped");
          break;
        }
        if (file === undefined) pend(s.transcribe ? "transcribe" : "subtitles");
        const ass = !!s.subtitles && /\.(ass|ssa)$/i.test(s.subtitles);
        const style = s.style ?? (ass ? null : "clean");
        chain(subtitlesFilter(file ?? "<subtitles.srt>", opts.fontsDir ?? "<fonts>", style));
        summary.push(`burn_subtitles ${s.transcribe ? "from a transcript" : "from a file"}, ${style ?? "file"} style`);
        break;
      }
      case "backdrop": {
        const { op: _op, ...bo } = s;
        const { steps: st, out: o, extraInputs: ex, layout } = backdropSteps(bo, { width: W, height: H }, cur, nextInput, tag);
        geo = null;
        graph.push(...st);
        extraInputs.push(...ex);
        nextInput += ex.length / 2;
        cur = o;
        W = layout.canvasW;
        H = layout.canvasH;
        summary.push(`backdrop to ${W}x${H}`);
        break;
      }
      case "keystroke_overlay": {
        const k = opts.keystrokes?.[i];
        if (!k) throw new ScreencastError(`Internal: missing keystroke badges for step ${at}.`);
        // Badges are on the source's clock; move them past earlier trims and speed changes.
        const badges = retimeBadges(k.badges, timeOps);
        if (badges.length === 0) {
          summary.push("keystroke_overlay: no badges in this part of the video");
          break;
        }
        const { steps: st, out: o } = keystrokeSteps(groupBadges(badges), k, s, { height: H }, cur, tag);
        graph.push(...st);
        cur = o;
        summary.push(`keystroke_overlay ${badges.length} badge(s)`);
        break;
      }
      case "cursor": {
        // Like zoom follow:"clicks": logged positions only match the frame
        // until a zoom, reframe or backdrop moves the content. Before a zoom,
        // the zoom then moves the drawn cursor with everything else.
        if (!geo) {
          throw new ScreencastError(
            `step ${at}: cursor must come before zoom, reframe or backdrop; the logged positions no longer match the frame after them.`,
          );
        }
        const c = opts.cursor?.[i];
        if (!c) throw new ScreencastError(`Internal: missing cursor plan for step ${at}.`);
        const moved = transformCursor(c.plan, timeOps, geo);
        if (moved.path.length === 0 || moved.visible.length === 0) {
          summary.push("cursor: no cursor movement in this part of the video");
          break;
        }
        const { steps: st, out: o, extraInputs: ex, commands } = cursorSteps(moved, s, { width: W, height: H }, cur, nextInput, tag, c.sprite, c.commandsFile);
        graph.push(...st);
        extraInputs.push(...ex);
        nextInput += ex.length / 2;
        cur = o;
        files.push({ path: c.commandsFile, content: commands });
        summary.push(`cursor ${moved.path.length} segment(s), ${moved.clicks.length} click(s)${s.spotlight ? ", spotlight" : ""}`);
        break;
      }
      case "export_preset": {
        const p = exportPresetParts(s.platform, s.fit ?? "pad", tag);
        geo = null;
        chain(p.vf);
        if (p.af) audio.push(p.af);
        encode = p.encode;
        W = p.width;
        H = p.height;
        fps = 30;
        audioReencode = true;
        summary.push(`export_preset ${s.platform}`);
        break;
      }
      case "export_gif": {
        const { op: _op, ...opts } = s;
        gif = opts;
        summary.push(`export_gif (${opts.format ?? "gif"}): second stage, size-budget ladder`);
        break;
      }
    }
  });

  const args = ["-y", ...inputArgs, "-i", input, ...extraInputs];
  // Chapters come from their own input, after every other one (#174).
  const chaptersInput = opts.chaptersFile ? args.filter((a) => a === "-i").length : -1;
  if (opts.chaptersFile) args.push("-f", "ffmetadata", "-i", opts.chaptersFile);
  // Audio filters run even when no step touched the picture (an audio-only pipeline).
  const audioGraph = src.hasAudio && audio.length > 0;
  if (audioGraph) graph.push(`[0:a]${audio.join(",")}[aout]`);
  if (graph.length > 0) args.push("-filter_complex", graph.join(";"));
  args.push("-map", cur === "[0:v]" ? "0:v" : cur);
  if (src.hasAudio) args.push("-map", audioGraph ? "[aout]" : "0:a");
  // Assigned inside the forEach above, which TypeScript does not track.
  const finalEncode = encode as string[] | null;
  if (finalEncode) {
    args.push(...finalEncode);
  } else {
    // An export_gif tail reads this file once, so give it more quality; a
    // redaction gets it too, like redact_region, so its edges stay crisp (#204).
    args.push(...resolveQuality(gif || redacts ? "high" : quality));
    if (src.hasAudio) args.push(...(audioReencode ? ["-c:a", "aac", "-b:a", "160k"] : ["-c:a", "copy"]));
    args.push("-movflags", "+faststart");
  }
  if (chaptersInput !== -1) args.push("-map_chapters", String(chaptersInput));
  args.push(output);
  return { args, width: W, height: H, fps, durationSec: dur === null ? null : r3(dur), gif, summary, timeOps, pending, files };
}
