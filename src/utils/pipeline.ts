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
 */
import { ScreencastError } from "./errors.js";
import { atempoChain, cropFilter, redactSteps, scaleFilter, scaledSize, type RedactRegion, type RedactOptions } from "./media.js";
import { calloutSteps, type Callout, type CalloutAssets } from "./callout.js";
import { ASPECT_DIMS, exportPresetParts, reframeFilter, type Aspect, type Platform, type ReframeFit } from "./produce.js";
import { keyframesToViews, zoomFilter, DEFAULT_TRANSITION_SEC, type ZoomKeyframe } from "./zoom.js";
import { resolveQuality, type Quality } from "./targets.js";
import type { AnimExportOptions } from "./animExport.js";

export const MAX_PIPELINE_STEPS = 30;

export type PipelineStep =
  | { op: "trim"; start: number; end?: number; duration?: number }
  | { op: "crop"; x: number; y: number; width: number; height: number }
  | { op: "scale"; width?: number; height?: number }
  | { op: "speed"; factor: number }
  | ({ op: "redact"; regions: RedactRegion[] } & RedactOptions)
  | { op: "callout"; items: Callout[]; fontFile?: string }
  | { op: "reframe"; aspect: Aspect; fit?: ReframeFit }
  | { op: "zoom"; keyframes: ZoomKeyframe[]; transitionSec?: number }
  | { op: "export_preset"; platform: Platform; fit?: ReframeFit }
  | ({ op: "export_gif" } & AnimExportOptions);

export interface SourceInfo {
  width: number;
  height: number;
  fps: number;
  durationSec: number | null;
  hasAudio: boolean;
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
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Plan the fused command. `assets[i]` holds the files callout step i needs. */
export function planPipeline(
  input: string,
  output: string,
  steps: PipelineStep[],
  src: SourceInfo,
  assets: Record<number, CalloutAssets> = {},
  quality: Quality = "standard",
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
        break;
      }
      case "crop":
        chain(cropFilter(s, { width: W, height: H }));
        W = s.width;
        H = s.height;
        summary.push(`crop to ${W}x${H}`);
        break;
      case "scale": {
        const f = scaleFilter(s);
        ({ width: W, height: H } = scaledSize(W, H, s));
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
        W = dim.w;
        H = dim.h;
        summary.push(`reframe to ${s.aspect} (${s.fit ?? "pad"})`);
        break;
      }
      case "zoom": {
        const views = keyframesToViews(s.keyframes, W, H);
        chain(zoomFilter(views, { width: W, height: H, fps }, s.transitionSec ?? DEFAULT_TRANSITION_SEC));
        summary.push(`zoom ${s.keyframes.length} keyframe(s)`);
        break;
      }
      case "export_preset": {
        const p = exportPresetParts(s.platform, s.fit ?? "pad", tag);
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
  if (graph.length > 0) {
    if (src.hasAudio && audio.length > 0) graph.push(`[0:a]${audio.join(",")}[aout]`);
    args.push("-filter_complex", graph.join(";"), "-map", cur);
  } else {
    args.push("-map", "0:v");
  }
  if (src.hasAudio) args.push("-map", audio.length > 0 && graph.length > 0 ? "[aout]" : "0:a");
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
  args.push(output);
  return { args, width: W, height: H, fps, durationSec: dur === null ? null : r3(dur), gif, summary };
}
