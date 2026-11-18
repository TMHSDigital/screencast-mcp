/**
 * Dead-air removal (#122). Recordings of an agent at work are full of long
 * still stretches while it thinks. A scan finds frozen video (freezedetect)
 * and silent audio (silencedetect); idle time is where the picture is frozen
 * and, if there is audio, it is also silent. Each idle stretch is cut except
 * for a short pad at both edges, in one select/aselect pass. Pure helpers.
 */
import { z } from "zod";
import { ScreencastError } from "./errors.js";
import { type Quality } from "./targets.js";
import { encodeTail } from "./encode.js";
import { sumExpr } from "./expr.js";

export interface Interval {
  start: number;
  end: number;
}

export const DEFAULT_MIN_IDLE_SEC = 2;
export const DEFAULT_KEEP_SEC = 0.4;
/** Cap on cut intervals, keeping the select expression a sane length. */
export const MAX_CUTS = 200;

/** freezedetect noise tolerance (#353): strict (the old default) needs a
 * truly still frame; loose lets a blinking caret, spinner or clock count as idle. */
export const IDLE_SENSITIVITY_DB = { strict: -60, normal: -50, loose: -40 } as const;
export type IdleSensitivity = keyof typeof IDLE_SENSITIVITY_DB;
export const IDLE_BASES = ["screen", "events", "both"] as const;
export type IdleBasis = (typeof IDLE_BASES)[number];

const rect = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() });
export type IdleRect = z.infer<typeof rect>;
export const MAX_IGNORE_REGIONS = 8;

/** Options cut_idle and the pipeline step share (#353); the step's copy is
 * undescribed, like its other fields, to keep tools/list small. */
export const idleOptionFields = {
  sensitivity: z.enum(["strict", "normal", "loose"]).optional(),
  ignoreRegions: z.array(rect).max(MAX_IGNORE_REGIONS).optional(),
  basis: z.enum(IDLE_BASES).optional(),
};
export const describedIdleOptionFields = {
  sensitivity: idleOptionFields.sensitivity.describe("Freeze tolerance: strict (default), normal, loose (a caret or spinner still counts as idle)."),
  ignoreRegions: idleOptionFields.ignoreRegions.describe("Rectangles (a clock) left out of the freeze check."),
  basis: idleOptionFields.basis.describe("screen (default), events (no input in .events.jsonl), or both."),
};

export interface IdleScanOptions {
  sensitivity?: IdleSensitivity;
  ignoreRegions?: IdleRect[];
}

/** Scan for freezes (and silences, when the file has audio); the reports go
 * to stderr at info level. Ignored regions are filled black first. */
export function buildIdleScanArgs(input: string, minIdleSec: number, withAudio: boolean, opts: IdleScanOptions = {}): string[] {
  if (!(minIdleSec > 0)) throw new ScreencastError("minIdleSec must be positive.");
  const mask = (opts.ignoreRegions ?? []).map((r) => `drawbox=x=${Math.round(r.x)}:y=${Math.round(r.y)}:w=${Math.round(r.width)}:h=${Math.round(r.height)}:color=black:t=fill`);
  return [
    "-hide_banner", "-nostats", "-v", "info", "-i", input,
    "-vf", [...mask, `freezedetect=n=${IDLE_SENSITIVITY_DB[opts.sensitivity ?? "strict"]}dB:d=${minIdleSec}`].join(","),
    ...(withAudio ? ["-af", `silencedetect=n=-40dB:d=${minIdleSec}`] : ["-an"]),
    "-f", "null", "-",
  ];
}

/** Pair start/end markers from the scan. An open interval (the stretch runs to
 * the end of the file) is closed at `duration`. Pure. */
function pairs(stderr: string, startRe: RegExp, endRe: RegExp, duration: number): Interval[] {
  const out: Interval[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(startRe);
    if (s) {
      open = Number(s[1]);
      continue;
    }
    const e = line.match(endRe);
    if (e && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null && duration > open) out.push({ start: open, end: duration });
  return out;
}

export function parseFreezes(stderr: string, duration: number): Interval[] {
  return pairs(stderr, /freeze_start:\s*([\d.]+)/, /freeze_end:\s*([\d.]+)/, duration);
}

export function parseSilences(stderr: string, duration: number): Interval[] {
  return pairs(stderr, /silence_start:\s*([\d.]+)/, /silence_end:\s*([\d.]+)/, duration);
}

/** Idle by the event log (#353): stretches of at least `minIdleSec` with no
 * click, wheel, key or typing. A gap in the log counts as activity, since
 * what happened then is unknown; pointer moves alone do not. Pure. */
export function eventIdle(
  events: ReadonlyArray<{ t: number; type: string; durationSec?: number }>,
  duration: number,
  minIdleSec: number,
): Interval[] {
  const busy = events
    .filter((e) => e.type !== "move" && e.type !== "focus")
    .map((e) => ({ start: e.t, end: e.t + (e.durationSec ?? 0) }))
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  let from = 0;
  for (const b of [...busy, { start: duration, end: duration }]) {
    const end = Math.min(b.start, duration);
    if (end - from >= minIdleSec) out.push({ start: from, end });
    from = Math.max(from, b.end);
  }
  return out;
}

/** Overlap of two sorted interval lists. Pure. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (true) {
    const x = a[i];
    const y = b[j];
    if (!x || !y) break;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

/** Idle stretches (at least minIdleSec long) shrunk by `keep` at each edge,
 * i.e. the spans that will actually be removed. Pure. */
export function cutsFor(idle: Interval[], minIdleSec: number, keep: number): Interval[] {
  return idle
    .filter((r) => r.end - r.start >= minIdleSec)
    .map((r) => ({ start: r.start + keep, end: r.end - keep }))
    .filter((r) => r.end - r.start > 0.05)
    .map((r) => ({ start: Number(r.start.toFixed(3)), end: Number(r.end.toFixed(3)) }));
}

/** The video and audio filters that remove `cuts`; shared by cut_idle and
 * pipeline (#244). Pure. */
export function cutFilters(cuts: Interval[]): { video: string; audio: string } {
  if (cuts.length === 0) throw new ScreencastError("Nothing to cut.");
  if (cuts.length > MAX_CUTS) throw new ScreencastError(`Too many idle stretches (${cuts.length}); raise minIdleSec.`);
  // Grouped, since ffmpeg rejects a flat sum of 100+ terms (#225).
  const drop = sumExpr(cuts.map((c) => `between(t,${c.start},${c.end})`));
  // Each kept frame moves back by the cut time before it, rather than being
  // renumbered at a constant rate, so variable-frame-rate video stays as long
  // as its audio (#186).
  const removed = sumExpr(cuts.map((c) => `clip(T-${c.start},0,${Number((c.end - c.start).toFixed(3))})`));
  return {
    video: `select='not(${drop})',setpts='(T-(${removed}))/TB'`,
    // aselect keeps or drops whole frames (1024 samples, ~21 ms, for AAC), so
    // small frames keep each cut within a few ms of the video's (#244).
    audio: `asetnsamples=n=256:p=0,aselect='not(${drop})',asetpts=N/SR/TB`,
  };
}

export interface SpeedRange extends Interval {
  /** How many times faster the range plays (> 1). */
  factor: number;
}

/** Fastest a range may play. */
export const MAX_RANGE_FACTOR = 100;

/** One fast-forward range, as speed and pipeline take it (#320). */
export const speedRangeSchema = z.object({ start: z.number().min(0), end: z.number().positive(), factor: z.number().gt(1).max(MAX_RANGE_FACTOR) });

/** cut_idle's fast-forward default. */
export const DEFAULT_IDLE_FACTOR = 8;

/** Check ranged speed changes: sorted, not overlapping, inside the video, and
 * faster than real time. Returns them rounded. Pure. */
export function checkSpeedRanges(ranges: SpeedRange[], durationSec: number | null): SpeedRange[] {
  if (ranges.length === 0) throw new ScreencastError("segments needs at least one range.");
  if (ranges.length > MAX_CUTS) throw new ScreencastError(`Too many ranges (${ranges.length}); at most ${MAX_CUTS}.`);
  const out = [...ranges]
    .sort((a, b) => a.start - b.start)
    .map((r) => ({ start: Number(r.start.toFixed(3)), end: Number(r.end.toFixed(3)), factor: r.factor }));
  out.forEach((r, i) => {
    if (!(r.end > r.start) || r.start < 0) throw new ScreencastError(`Range ${r.start}-${r.end}s: end must be after start, from 0.`);
    if (!(r.factor > 1) || r.factor > MAX_RANGE_FACTOR) {
      throw new ScreencastError(`Range ${r.start}-${r.end}s: factor must be above 1 and at most ${MAX_RANGE_FACTOR} (for slow motion, use factor on the whole clip).`);
    }
    if (durationSec !== null && r.start >= durationSec) throw new ScreencastError(`Range ${r.start}-${r.end}s starts after the video ends (${durationSec}s).`);
    const prev = out[i - 1];
    if (prev && r.start < prev.end) throw new ScreencastError(`Ranges ${prev.start}-${prev.end}s and ${r.start}-${r.end}s overlap.`);
  });
  return out;
}

/** Seconds ranged speed changes save. Pure. */
export function rangesSavedSec(ranges: readonly SpeedRange[]): number {
  return ranges.reduce((s, r) => s + (r.end - r.start) * (1 - 1 / r.factor), 0);
}

/**
 * Fast-forward ranges (#320) in one linear pass, like cutFilters: each video
 * frame moves back by the time the ranges before it save, so a range plays
 * `factor` times faster, and `fps` thins the packed frames back to the
 * source's rate. Audio in a range keeps its first 1/factor at normal pitch
 * (a sped-up stretch is usually idle or silent; pitched-up speech helps no
 * one), so it stays as long as the video. Pure.
 */
export function speedRangeFilters(ranges: readonly SpeedRange[], fps: number | null): { video: string; audio: string } {
  if (ranges.length === 0) throw new ScreencastError("Nothing to speed up.");
  const k = (r: SpeedRange) => Number((1 - 1 / r.factor).toFixed(6));
  const shift = sumExpr(ranges.map((r) => `clip(T-${r.start},0,${Number((r.end - r.start).toFixed(3))})*${k(r)}`));
  const kept = (r: SpeedRange) => Number((r.start + (r.end - r.start) / r.factor).toFixed(3));
  const drop = sumExpr(ranges.map((r) => `between(t,${kept(r)},${r.end})`));
  return {
    video: `setpts='(T-(${shift}))/TB'` + (fps ? `,fps=${Number(fps.toFixed(3))}` : ""),
    audio: `asetnsamples=n=256:p=0,aselect='not(${drop})',asetpts=N/SR/TB`,
  };
}

/** Speed up ranges of video (and audio) in one pass. Pure. */
export function buildSpeedRangesArgs(
  input: string,
  output: string,
  ranges: readonly SpeedRange[],
  opts: { withAudio: boolean; fps: number | null; quality?: Quality },
): string[] {
  const f = speedRangeFilters(ranges, opts.fps);
  return [
    "-y", "-i", input,
    "-vf", f.video,
    ...(opts.withAudio ? ["-af", f.audio] : ["-an"]),
    ...encodeTail({ quality: opts.quality ?? "standard", audio: opts.withAudio ? "aac" : "omit" }),
    output,
  ];
}

/** Remove the cut spans from video (and audio) in one pass. Timestamps are
 * regenerated so the result plays continuously. Pure. */
export function buildCutIdleArgs(
  input: string,
  output: string,
  cuts: Interval[],
  withAudio: boolean,
  quality: Quality = "standard",
): string[] {
  const f = cutFilters(cuts);
  return [
    "-y", "-i", input,
    "-vf", f.video,
    ...(withAudio ? ["-af", f.audio] : ["-an"]),
    ...encodeTail({ quality, audio: withAudio ? "aac" : "omit" }),
    output,
  ];
}
