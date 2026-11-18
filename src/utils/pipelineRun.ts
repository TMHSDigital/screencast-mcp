/**
 * The pipeline tool's phases (#368), in the order the handler runs them:
 * resolveRequest (args, recipe, fromEdit), checkSteps (files and filters the
 * steps need, and the clicks a zoom follows), scanIdle, resolveSecrets,
 * prepareAssets, resolvePending (probes and transcripts, re-planning after
 * each), addChapters, and writeSidecars after the render. The handler owns
 * the temporary folder; each phase takes what it needs.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { editOutput, requireInput } from "./editTool.js";
import { ScreencastError } from "./errors.js";
import { probeMedia, hasFilter, runCapture, runFfmpeg, scriptLongFilters } from "./ffmpeg.js";
import { jobTimeoutMs } from "./jobs.js";
import { planPipeline, probeArgs, sidecarCues, MAX_PIPELINE_STEPS, type AudioMeasurements, type CursorStepAssets, type KeystrokeStepAssets, type PipelinePlan, type SourceInfo } from "./pipeline.js";
import type { PipelineStep, PipelineStepInput } from "./pipelineStep.js";
import { calloutFonts, prepareCalloutAssets } from "./calloutAssets.js";
import type { CalloutAssets } from "./callout.js";
import type { MediaInfo } from "./media.js";
import type { Quality } from "./targets.js";
import { buildChapters, ffmetadata, markerPoints, markersOrChapters, retimeMarkers, writeMarkers, type Chapter, type Marker } from "./chapters.js";
import { cursorSpritePath, loadCursor } from "./cursor.js";
import { type ClickPoint, readClicks } from "./zoom.js";
import { DEFAULT_MIN_IDLE_SEC } from "./idle.js";
import { findIdle } from "./idleScan.js";
import { buildLoudnessMeasureArgs, buildNoiseFloorArgs, loudnessTarget, parseLoudnorm, parseNoiseFloor } from "./audio.js";
import { buildTranscribeArgs, formatSrt, normalizeCues, parseSrt, resolveWhisperModel, type Cue } from "./captions.js";
import { eventPaths } from "./events.js";
import { bundledFontPath } from "./fonts.js";
import { retimeAss, retimeCues, type Span } from "./timeline.js";
import { applyOverrides, recipeSteps, type Recipe } from "./recipes.js";
import { readEditSpec, sourceChange } from "./editSpec.js";
import { samePath } from "./recordingIndex.js";
import { assertArgPaths } from "./argPaths.js";
import { DEFAULT_SCAN_FRAMES, scanMatches, scanVideoFrames } from "./ocrScan.js";
import { DEFAULT_SECRET_PATTERN } from "./bugReport.js";
import { loadBadges, prepareKeystrokeAssets } from "./keystrokes.js";
import { writeRetimedSidecars } from "./sidecarRetime.js";

export interface PipelineArgs {
  input?: string;
  fromEdit?: string;
  steps?: PipelineStepInput[];
  recipe?: Recipe;
  quality?: Quality;
  dryRun?: boolean;
  output?: string;
  overwrite?: boolean;
  chapters?: boolean;
}

/** What a call asks for, once args, a recipe and an edit spec are merged. */
export interface PipelineRequest {
  input: string;
  info: MediaInfo;
  src: SourceInfo;
  /** The steps as asked (recipe expanded, spec overrides applied): what an
   * edit spec keeps. */
  steps: PipelineStepInput[];
  /** The recipe to record in the edit spec (the call's, else the spec's). */
  recipe?: string;
  quality: Quality;
  chapters: boolean;
  output: string;
  /** Where a transcript made for captions goes, next to an mp4 result. */
  srtPath: string;
  /** The last step is export_gif: the chain renders to a temporary mp4 first. */
  gif: boolean;
  timeoutMs: number;
  warnings: string[];
}

/** Why a recipe cannot transcribe captions here, or null when it can. */
function transcribeBlocker(): string | null {
  if (!hasFilter("whisper")) return "this ffmpeg has no whisper filter (FFmpeg 8 with whisper.cpp).";
  try {
    resolveWhisperModel(undefined);
    return null;
  } catch {
    return "no whisper model (set SCREENCAST_WHISPER_MODEL).";
  }
}

/** Merge the call's args with a recipe (#244) and an edit spec (#340): given
 * steps replace their same-op steps. Probes the input and picks the output. */
export async function resolveRequest(args: PipelineArgs): Promise<PipelineRequest> {
  const spec = args.fromEdit ? readEditSpec(args.fromEdit) : null;
  if (spec) {
    // The spec's source and step files come from disk, after the per-call
    // check ran: hold them to the same rules.
    assertArgPaths({ input: spec.source.path, steps: spec.steps });
    if (args.recipe) throw new ScreencastError("fromEdit already has its steps; leave recipe out.");
    if (args.input && !samePath(args.input, spec.source.path)) throw new ScreencastError(`The spec is for ${spec.source.path}, not ${args.input}.`);
    const changed = sourceChange(spec);
    if (changed) throw new ScreencastError(`Cannot re-render ${args.fromEdit}: ${changed}.`, "Run pipeline on the source again with steps instead.");
  }
  const input = args.input ?? spec?.source.path;
  if (!input) throw new ScreencastError("Pass input (or fromEdit).");
  requireInput(input);
  const info = await probeMedia(input);
  const hasAudio = info.audioCodec !== null;
  const warnings: string[] = [];
  let steps = args.steps ?? [];
  if (spec) steps = applyOverrides(spec.steps, steps);
  if (args.recipe) {
    const logged = readClicks(eventPaths(input).jsonl);
    const r = recipeSteps(args.recipe, {
      hasAudio,
      hasClicks: !!logged && logged.length > 0,
      transcribeBlocker: hasAudio ? transcribeBlocker() : null,
    });
    steps = applyOverrides(r.steps, steps);
    warnings.push(...r.notes);
  }
  const last = steps.at(-1);
  if (!last) throw new ScreencastError("Give steps, a recipe, or both.");
  if (steps.length > MAX_PIPELINE_STEPS) throw new ScreencastError(`At most ${MAX_PIPELINE_STEPS} steps.`);
  if (!info.width || !info.height) throw new ScreencastError(`Could not read the size of ${input}.`);
  const gif = last.op === "export_gif";
  const output = editOutput(args.output, "pipeline", gif ? `.${last.format ?? "gif"}` : ".mp4", { overwrite: args.overwrite, anyContainer: gif });
  // A transcript made for captions goes next to an mp4 result; like the
  // output, an existing file there is only replaced with overwrite (#256).
  const srtPath = output.replace(/\.[^./\\]+$/, "") + ".srt";
  const transcribes = !gif && steps.some((s) => s.op === "burn_subtitles" && s.transcribe);
  if (transcribes && !args.overwrite && existsSync(srtPath)) {
    throw new ScreencastError(`Output already exists: ${srtPath}. Pass overwrite: true to replace it.`);
  }
  const recipe = args.recipe ?? spec?.recipe;
  return {
    input,
    info,
    src: { width: info.width, height: info.height, fps: info.fps ?? 30, durationSec: info.durationSec, hasAudio },
    steps,
    ...(recipe && { recipe }),
    quality: args.quality ?? spec?.quality ?? "standard",
    chapters: args.chapters ?? spec?.chapters ?? false,
    output,
    srtPath,
    gif,
    timeoutMs: jobTimeoutMs(info.durationSec),
    warnings,
  };
}

/** Check the files and ffmpeg filters the steps need before any work, and
 * read the clicks each zoom follow:"clicks" step plans from. */
export function checkSteps(steps: readonly PipelineStepInput[], input: string): Record<number, ClickPoint[]> {
  const clicks: Record<number, ClickPoint[]> = {};
  for (const [i, s] of steps.entries()) {
    if (s.op === "burn_subtitles") {
      if (!hasFilter("subtitles")) {
        throw new ScreencastError("This ffmpeg has no subtitles filter (it needs libass).", "Install a full ffmpeg build, e.g. `winget install Gyan.FFmpeg`.");
      }
      if (s.subtitles && !existsSync(s.subtitles)) throw new ScreencastError(`step ${i + 1}: subtitles file not found: ${s.subtitles}`);
      if (s.transcribe) {
        if (!hasFilter("whisper")) throw new ScreencastError(`step ${i + 1}: transcribe needs FFmpeg 8 built with whisper.cpp (no whisper filter here).`);
        resolveWhisperModel(undefined);
      }
    } else if (s.op === "music" && !existsSync(s.music)) {
      throw new ScreencastError(`step ${i + 1}: music file not found: ${s.music}`);
    } else if (s.op === "backdrop" && s.image && !existsSync(s.image)) {
      throw new ScreencastError(`step ${i + 1}: background image not found: ${s.image}`);
    } else if (s.op === "zoom" && s.follow === "clicks") {
      const path = eventPaths(input).jsonl;
      const logged = readClicks(path);
      if (!logged) throw new ScreencastError(`step ${i + 1}: no event log at ${path}; record with start_recording events: true.`);
      clicks[i] = logged;
    }
  }
  return clicks;
}

/** cut_idle: scan the source once for idle stretches; planPipeline moves them
 * onto the step's timeline. Undefined without a cut_idle step. */
export async function scanIdle(ffmpeg: string, req: PipelineRequest, signal?: AbortSignal): Promise<Span[] | undefined> {
  const at = req.steps.findIndex((s) => s.op === "cut_idle");
  const step = req.steps[at];
  if (step?.op !== "cut_idle") return undefined;
  const total = req.info.durationSec;
  if (total === null) throw new ScreencastError(`Could not read the duration of ${req.input}.`);
  // A stretch minIdleSec long at the step is longer in the source after a speed-up.
  const speedUp = req.steps.slice(0, at).reduce((f, x) => (x.op === "speed" && x.factor ? f * x.factor : f), 1);
  const { idle } = await findIdle(ffmpeg, req.input, {
    minIdleSec: (step.minIdleSec ?? DEFAULT_MIN_IDLE_SEC) * speedUp,
    useAudio: req.src.hasAudio,
    duration: total,
    sensitivity: step.sensitivity,
    ignoreRegions: step.ignoreRegions,
    basis: step.basis,
    timeoutMs: req.timeoutMs,
    signal,
  });
  return idle;
}

/** Secrets (#341): OCR the source for on-screen secrets and give each hit a
 * timed region on its redact step's timeline (shifted by an earlier trim).
 * Returns the steps ready to plan; a redact left with no regions is dropped. */
export async function resolveSecrets(req: PipelineRequest, dryRun: boolean, signal?: AbortSignal): Promise<PipelineStep[]> {
  let found = 0;
  let scanned = false;
  const out: PipelineStep[] = [];
  for (const [i, s] of req.steps.entries()) {
    if (s.op !== "redact") {
      out.push(s);
      continue;
    }
    const regions = [...(s.regions ?? [])];
    if (s.secrets) {
      const before = req.steps.slice(0, i);
      if (before.some((x) => x.op === "speed" || x.op === "cut_idle")) {
        throw new ScreencastError(`step ${i + 1}: put a redact with secrets before speed and cut_idle; it scans the source's clock.`);
      }
      const offset = before.reduce((o, x) => (x.op === "trim" ? o + x.start : o), 0);
      if (dryRun) {
        req.warnings.push(`Step ${i + 1}: the secret scan runs when rendering, not in a dry run.`);
      } else {
        scanned = true;
        const scanDir = mkdtempSync(join(tmpdir(), "screencast-secrets-"));
        try {
          const total = req.info.durationSec ?? 0;
          const scan = await scanVideoFrames(
            req.input,
            { everySec: Math.max(1, Math.ceil(total / DEFAULT_SCAN_FRAMES)), maxFrames: DEFAULT_SCAN_FRAMES },
            scanDir,
            signal,
          );
          const pattern = typeof s.secrets === "string" ? s.secrets : DEFAULT_SECRET_PATTERN;
          for (const r of scanMatches(scan, pattern, true).redactRegions) {
            if (r.end - offset <= 0) continue;
            const box = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
            regions.push({ ...box, start: Math.max(0, r.start - offset), end: r.end - offset });
            found++;
          }
        } finally {
          rmSync(scanDir, { recursive: true, force: true });
        }
      }
    } else if (regions.length === 0) {
      throw new ScreencastError(`step ${i + 1}: redact needs regions, or secrets: true to find them.`);
    }
    if (regions.length > 0) out.push({ ...s, regions });
  }
  if (scanned) req.warnings.push(found > 0 ? `Blurred ${found} on-screen secret region(s).` : "No on-screen secrets found.");
  if (out.length === 0) throw new ScreencastError("Nothing to render: the only step was a redact that found no secrets.");
  return out;
}

export interface PipelineAssets {
  callouts: Record<number, CalloutAssets>;
  fallbackFonts: Array<{ step: number; item: number; fontFile: string }>;
  keystrokes: Record<number, KeystrokeStepAssets>;
  cursor: Record<number, CursorStepAssets>;
}

const stepWarning = (i: number, w: string) => `Step ${i}, ${w.charAt(0).toLowerCase()}${w.slice(1)}`;

/** Files the drawing steps need, written under `work` (a dry run plans with
 * placeholder paths). Fonts are chosen either way, so a dry run reports
 * missing glyphs too (#231). Keystroke badges and the cursor (#170) are
 * planned on the source's clock; planPipeline moves them through earlier
 * timing changes, crops and scales. */
export async function prepareAssets(steps: readonly PipelineStep[], req: PipelineRequest, work: string, dryRun: boolean): Promise<PipelineAssets> {
  const a: PipelineAssets = { callouts: {}, fallbackFonts: [], keystrokes: {}, cursor: {} };
  for (const [i, s] of steps.entries()) {
    if (s.op === "callout") {
      const c = dryRun
        ? {
            fontFile: "<font>",
            textFiles: s.items.map((c) => (c.type === "text" ? "<text>" : null)),
            arrowFiles: s.items.map((c) => (c.type === "arrow" ? "<arrow.png>" : null)),
            ...calloutFonts(s.items, s.fontFile),
          }
        : await prepareCalloutAssets(s.items, work, `s${i}_`, s.fontFile);
      a.callouts[i] = c;
      a.fallbackFonts.push(...c.fallbackFonts.map((f) => ({ step: i, ...f })));
      req.warnings.push(...c.warnings.map((w) => stepWarning(i, w)));
    } else if (s.op === "keystroke_overlay") {
      const { badges } = loadBadges(req.input, s.events, s);
      const labels = [...new Set(badges.map((b) => b.label))];
      const k = prepareKeystrokeAssets(labels, dryRun ? null : work, `s${i}_`, s.fontFile);
      a.keystrokes[i] = { badges, fontFile: k.fontFile, textFiles: k.textFiles };
      req.warnings.push(...k.warnings.map((w) => stepWarning(i, w)));
    } else if (s.op === "cursor") {
      a.cursor[i] = {
        plan: loadCursor(req.input, s.events, s, req.info.durationSec),
        sprite: cursorSpritePath(),
        commandsFile: dryRun ? `<cursor ${i}.cmd>` : join(work, `s${i}_cursor.cmd`),
      };
    }
  }
  return a;
}

/** Plans the steps; `chaptersFile` adds an FFMETADATA input. */
export type Planner = (chaptersFile?: string) => PipelinePlan;

/** A planner over the steps and assets, with the probe results it is given
 * so far (filled in by resolvePending). */
export function makePlanner(
  steps: PipelineStep[],
  req: PipelineRequest,
  assets: PipelineAssets,
  measured: { idle?: Span[]; clicks: Record<number, ClickPoint[]>; audio: Record<number, AudioMeasurements>; subtitles: Record<number, string> },
  target: string,
): Planner {
  const fontsDir = dirname(bundledFontPath("regular"));
  return (chaptersFile) =>
    planPipeline(req.input, target, steps, req.src, assets.callouts, req.quality, {
      keystrokes: assets.keystrokes,
      cursor: assets.cursor,
      idle: measured.idle,
      clicks: measured.clicks,
      audio: measured.audio,
      subtitles: measured.subtitles,
      fontsDir,
      chaptersFile,
    });
}

/** A transcript's cues, on its burn_subtitles step's timeline, and how many
 * timing changes came before that step. */
export interface Transcript {
  cues: Cue[];
  opsBefore: number;
}

/** Run the plan's pending probes in step order, re-planning after each, since
 * each one hears the audio as the earlier steps leave it. Fills `audio` and
 * `subtitles` (which the planner reads) and returns the final plan and the
 * transcript made for captions, if any. */
export async function resolvePending(
  ffmpeg: string,
  steps: readonly PipelineStep[],
  req: PipelineRequest,
  plan: Planner,
  out: { audio: Record<number, AudioMeasurements>; subtitles: Record<number, string> },
  work: string,
  signal?: AbortSignal,
): Promise<{ plan: PipelinePlan; transcript?: Transcript }> {
  let current = plan();
  let transcript: Transcript | undefined;
  for (let n = 0; current.pending.length > 0; n++) {
    const p = current.pending[0]!;
    if (n > steps.length * 3) throw new ScreencastError(`Internal: step ${p.step + 1} ${p.kind} did not resolve.`);
    const s = steps[p.step];
    const capture = async (base: string[]) => {
      const sc = scriptLongFilters(probeArgs(base, p));
      try {
        const r = await runCapture(ffmpeg, sc.args, req.timeoutMs, { signal });
        if (r.code !== 0) throw new ScreencastError(`step ${p.step + 1} ${p.kind} scan failed (exit ${r.code}): ${r.stderr.trim().slice(-400)}`);
        return r;
      } finally {
        sc.cleanup();
      }
    };
    if (p.kind === "noisefloor") {
      out.audio[p.step] = { ...out.audio[p.step], floorDb: parseNoiseFloor((await capture(buildNoiseFloorArgs(req.input))).stdout) };
    } else if (p.kind === "loudness" && s?.op === "audio") {
      const r = await capture(buildLoudnessMeasureArgs(req.input, loudnessTarget(s.normalize)));
      try {
        out.audio[p.step] = { ...out.audio[p.step], loudness: parseLoudnorm(r.stderr) };
      } catch {
        req.warnings.push(`Step ${p.step + 1}: the audio is silent; not normalized.`);
        out.audio[p.step] = { ...out.audio[p.step], silent: true };
      }
    } else if (p.kind === "transcribe" && s?.op === "burn_subtitles") {
      const raw = join(work, `s${p.step}_raw.srt`);
      await runFfmpeg(probeArgs(buildTranscribeArgs(req.input, resolveWhisperModel(undefined), raw), p), req.timeoutMs, { signal });
      const cues = existsSync(raw) ? normalizeCues(parseSrt(readFileSync(raw, "utf8"))) : [];
      const file = join(work, `s${p.step}.srt`);
      out.subtitles[p.step] = cues.length > 0 ? file : "";
      if (cues.length > 0) {
        transcript = { cues, opsBefore: p.ops.length };
        writeFileSync(file, formatSrt(cues));
      } else req.warnings.push(`Step ${p.step + 1}: no speech was recognised; no captions.`);
    } else if (p.kind === "subtitles" && s?.op === "burn_subtitles" && s.subtitles) {
      // The file is on the source's clock; move it past earlier trims, speed and cuts.
      if (p.ops.length === 0) out.subtitles[p.step] = s.subtitles;
      else {
        const text = readFileSync(s.subtitles, "utf8");
        const ass = /\.(ass|ssa)$/i.test(s.subtitles);
        const moved = ass ? retimeAss(text, p.ops) : formatSrt(retimeCues(normalizeCues(parseSrt(text)), p.ops));
        const file = join(work, `s${p.step}${ass ? ".ass" : ".srt"}`);
        writeFileSync(file, moved);
        out.subtitles[p.step] = ass || moved.trim() ? file : "";
      }
    } else {
      throw new ScreencastError(`Internal: step ${p.step + 1} cannot resolve ${p.kind}.`);
    }
    current = plan();
  }
  return { plan: current, ...(transcript && { transcript }) };
}

/** Chapters (#174): the input's markers, re-timed through the plan's trims and
 * speed changes, muxed from an FFMETADATA input. Returns the re-planned plan
 * when chapters were added. */
export async function addChapters(
  plan: PipelinePlan,
  planner: Planner,
  req: PipelineRequest,
  work: string,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<{ plan: PipelinePlan; chapters: Chapter[]; markers: Marker[] }> {
  const none = { plan, chapters: [], markers: [] };
  const found = plan.gif ? null : await markersOrChapters(req.input, signal);
  if (!found) {
    req.warnings.push("chapters: a GIF/WebP cannot hold chapters; none written.");
    return none;
  }
  if (found.markers.length === 0) {
    req.warnings.push("chapters: the input has no markers (add_marker) or chapters; none written.");
    return none;
  }
  const markers = retimeMarkers(found.markers, plan.timeOps);
  const chapters = plan.durationSec ? buildChapters(markerPoints(markers), plan.durationSec) : [];
  if (chapters.length === 0) {
    req.warnings.push("chapters: no marker falls inside the result; none written.");
    return none;
  }
  const file = dryRun ? "<chapters.txt>" : join(work, "chapters.txt");
  if (!dryRun) writeFileSync(file, ffmetadata(chapters));
  return { plan: planner(file), chapters, markers };
}

/** After an mp4 render: the transcript (moved onto the output's timeline),
 * the re-timed markers, and the input's event, log and perf sidecars (#352)
 * next to the output. Each is best effort. */
export function writeSidecars(
  req: PipelineRequest,
  plan: PipelinePlan,
  transcript: Transcript | undefined,
  markers: Marker[],
): { subtitlesPath?: string; markersPath?: string; eventsPath?: string; logsPath?: string; perfPath?: string } {
  const out: ReturnType<typeof writeSidecars> = {};
  if (transcript) {
    try {
      const cues = sidecarCues(transcript.cues, plan.timeOps, transcript.opsBefore);
      if (cues.length > 0) {
        writeFileSync(req.srtPath, formatSrt(cues));
        out.subtitlesPath = req.srtPath;
      }
    } catch {
      /* best effort */
    }
  }
  if (markers.length > 0) {
    try {
      out.markersPath = writeMarkers(req.output, markers.filter((m) => m.t < (plan.durationSec ?? Infinity)));
    } catch {
      /* best effort: the chapters are in the file */
    }
  }
  const { note, ...sidecars } = writeRetimedSidecars(req.input, req.output, plan);
  if (note) req.warnings.push(note);
  return { ...out, ...sidecars };
}
