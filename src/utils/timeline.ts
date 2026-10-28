/**
 * Moving times through a pipeline's timing changes (#174, #244): a trim keeps
 * [start, end) and shifts it to 0, a speed change divides every time by its
 * factor, and a cut (cut_idle) removes spans, so a time inside a removed span
 * lands where the span was. Markers, keystroke badges, clicks, subtitle cues
 * and idle stretches recorded on the source's clock all go through here.
 * Everything is pure.
 */
import type { TimeOp } from "./chapters.js";
import type { Cue } from "./captions.js";

export interface Span {
  start: number;
  end: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Seconds that sorted cut spans remove before time t. */
export function cutShift(t: number, spans: readonly Span[]): number {
  let removed = 0;
  for (const s of spans) {
    if (t <= s.start) break;
    removed += Math.min(t, s.end) - s.start;
  }
  return removed;
}

/** A point in time after `ops`, or null when a trim drops it. */
export function mapTime(t: number, ops: readonly TimeOp[]): number | null {
  let v = t;
  for (const op of ops) {
    if (op.op === "trim") {
      if (v < op.start || v >= op.end) return null;
      v -= op.start;
    } else if (op.op === "speed") v /= op.factor;
    else v -= cutShift(v, op.spans);
  }
  return v;
}

/** A window [from, to) after `ops`, clipped by trims; null when nothing of it is left. */
export function mapWindow(from: number, to: number, ops: readonly TimeOp[]): [number, number] | null {
  let a = from;
  let b = to;
  for (const op of ops) {
    if (op.op === "trim") {
      a = Math.max(a, op.start) - op.start;
      b = Math.min(b, op.end) - op.start;
    } else if (op.op === "speed") {
      a /= op.factor;
      b /= op.factor;
    } else {
      a -= cutShift(a, op.spans);
      b -= cutShift(b, op.spans);
    }
    if (b <= a) return null;
  }
  return [a, b];
}

/** Spans (e.g. idle stretches) after `ops`. */
export function mapSpans(spans: readonly Span[], ops: readonly TimeOp[]): Span[] {
  return spans.flatMap((s) => {
    const w = mapWindow(s.start, s.end, ops);
    return w ? [{ start: r3(w[0]), end: r3(w[1]) }] : [];
  });
}

/** Subtitle cues after `ops`; a cue left shorter than 50 ms is dropped. */
export function retimeCues(cues: readonly Cue[], ops: readonly TimeOp[]): Cue[] {
  return cues.flatMap((c) => {
    const w = mapWindow(c.start, c.end, ops);
    return w && w[1] - w[0] >= 0.05 ? [{ ...c, start: r3(w[0]), end: r3(w[1]) }] : [];
  });
}

const ASS_TIME = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/;
const assSec = (s: string): number | null => {
  const m = s.trim().match(ASS_TIME);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : null;
};
const assTime = (sec: number): string => {
  const cs = Math.round(sec * 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(cs / 360_000)}:${pad(Math.floor((cs % 360_000) / 6000))}:${pad(Math.floor((cs % 6000) / 100))}.${pad(cs % 100)}`;
};

/** An .ass/.ssa script with every Dialogue line moved through `ops` (a line
 * left with nothing on screen is removed); styles and the rest are kept. */
export function retimeAss(text: string, ops: readonly TimeOp[]): string {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const m = line.match(/^(Dialogue:\s*[^,]*,)([^,]*),([^,]*),(.*)$/);
      if (!m) return [line];
      const [, head, s, e, rest] = m as unknown as [string, string, string, string, string];
      const a = assSec(s);
      const b = assSec(e);
      if (a === null || b === null) return [line];
      const w = mapWindow(a, b, ops);
      return w && w[1] - w[0] >= 0.05 ? [`${head}${assTime(w[0])},${assTime(w[1])},${rest}`] : [];
    })
    .join("\n");
}
