/**
 * Dead-air removal (#122). Recordings of an agent at work are full of long
 * still stretches while it thinks. A scan finds frozen video (freezedetect)
 * and silent audio (silencedetect); idle time is where the picture is frozen
 * and, if there is audio, it is also silent. Each idle stretch is cut except
 * for a short pad at both edges, in one select/aselect pass. Pure helpers.
 */
import { ScreencastError } from "./errors.js";
import { resolveQuality, type Quality } from "./targets.js";
import { sumExpr } from "./expr.js";

export interface Interval {
  start: number;
  end: number;
}

export const DEFAULT_MIN_IDLE_SEC = 2;
export const DEFAULT_KEEP_SEC = 0.4;
/** Cap on cut intervals, keeping the select expression a sane length. */
export const MAX_CUTS = 200;

/** Scan for freezes (and silences, when the file has audio); the reports go
 * to stderr at info level. */
export function buildIdleScanArgs(input: string, minIdleSec: number, withAudio: boolean): string[] {
  if (!(minIdleSec > 0)) throw new ScreencastError("minIdleSec must be positive.");
  return [
    "-hide_banner", "-nostats", "-v", "info", "-i", input,
    "-vf", `freezedetect=n=-60dB:d=${minIdleSec}`,
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

/** Overlap of two sorted interval lists. Pure. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
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

/** Remove the cut spans from video (and audio) in one pass. Timestamps are
 * regenerated so the result plays continuously. Pure. */
export function buildCutIdleArgs(
  input: string,
  output: string,
  cuts: Interval[],
  withAudio: boolean,
  quality: Quality = "standard",
): string[] {
  if (cuts.length === 0) throw new ScreencastError("Nothing to cut.");
  if (cuts.length > MAX_CUTS) throw new ScreencastError(`Too many idle stretches (${cuts.length}); raise minIdleSec.`);
  // Grouped, since ffmpeg rejects a flat sum of 100+ terms (#225).
  const drop = sumExpr(cuts.map((c) => `between(t,${c.start},${c.end})`));
  // Each kept frame moves back by the cut time before it, rather than being
  // renumbered at a constant rate, so variable-frame-rate video stays as long
  // as its audio (#186).
  const removed = sumExpr(cuts.map((c) => `clip(T-${c.start},0,${Number((c.end - c.start).toFixed(3))})`));
  return [
    "-y", "-i", input,
    "-vf", `select='not(${drop})',setpts='(T-(${removed}))/TB'`,
    ...(withAudio ? ["-af", `aselect='not(${drop})',asetpts=N/SR/TB`] : ["-an"]),
    ...resolveQuality(quality),
    ...(withAudio ? ["-c:a", "aac", "-b:a", "160k"] : []),
    output,
  ];
}
