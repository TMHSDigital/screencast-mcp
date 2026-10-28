/**
 * Transcript-based editing (#173): cut a narrated recording by quoting its
 * transcript, naming cue indexes, or asking for filler words ("um", "uh") to
 * go. The cuts reuse cut_idle's select/aselect machinery (buildCutIdleArgs),
 * and the transcript is re-timed to the cut video so burn_subtitles still
 * lines up.
 *
 * Timing is only as fine as the SRT. transcribe { words: true } asks whisper
 * for one word per cue (max_len=1, which turns on whisper.cpp's token
 * timestamps), so a quote or a filler maps to exact word times. With
 * sentence-level cues, a quote that covers part of a cue is placed by
 * interpolating on character position inside the cue (reported as
 * exact: false), and a filler inside a longer cue is skipped rather than
 * guessed, since a wrong guess clips a real word. A filler with its own cue
 * is cut along with the pause around it. Pure.
 */
import { ScreencastError } from "./errors.js";
import type { Cue } from "./captions.js";
import type { Interval } from "./idle.js";

/** Filler words removed by `fillers: true`, matched as whole words. Whisper
 * often leaves disfluencies out of its transcript altogether; only fillers
 * the transcript contains can be cut. */
export const FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "hm", "mm", "mhm"];

/** Seconds of the pause on each side of a filler cut along with it. */
export const FILLER_REACH = 0.5;

/** One whitespace-separated token of a cue, with its estimated time span. */
export interface Word {
  cue: number;
  /** The token as written, punctuation included. */
  raw: string;
  /** Lowercased letters and digits only; "" for pure punctuation. */
  norm: string;
  start: number;
  end: number;
  /** First / last token of its cue, so the cue edge is a real timestamp. */
  first: boolean;
  last: boolean;
}

export interface TranscriptCut extends Interval {
  text: string;
  /** False when an edge was interpolated inside a cue rather than taken from
   * a timestamp. */
  exact: boolean;
}

export const normWord = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const r3 = (n: number) => Number(n.toFixed(3));

/** Split cues into tokens, spreading each cue's time over its tokens by
 * character position. Pure. */
export function cueWords(cues: Cue[]): Word[] {
  const out: Word[] = [];
  cues.forEach((c, ci) => {
    const text = c.text.replace(/\s+/g, " ").trim();
    const toks = [...text.matchAll(/\S+/g)];
    const len = text.length || 1;
    const dur = c.end - c.start;
    toks.forEach((m, k) => {
      const at = m.index;
      out.push({
        cue: ci,
        raw: m[0],
        norm: normWord(m[0]),
        start: k === 0 ? c.start : c.start + (at / len) * dur,
        end: k === toks.length - 1 ? c.end : c.start + ((at + m[0].length) / len) * dur,
        first: k === 0,
        last: k === toks.length - 1,
      });
    });
  });
  return out;
}

/** Indexes into `words` of the spoken (non-punctuation) tokens. */
const spoken = (words: Word[]) => words.flatMap((w, i) => (w.norm ? [i] : []));

/** Word-index ranges [from, to] (inclusive, into `words`) where `quote`
 * occurs, ignoring case, punctuation and line breaks. Pure. */
export function findQuote(words: Word[], quote: string): Array<[number, number]> {
  const q = quote.split(/\s+/).map(normWord).filter(Boolean);
  if (q.length === 0) throw new ScreencastError(`Quote "${quote}" has no words to match.`);
  const idx = spoken(words);
  const hits: Array<[number, number]> = [];
  for (let i = 0; i + q.length <= idx.length; i++) {
    if (q.every((w, k) => words[idx[i + k]!]!.norm === w)) hits.push([idx[i]!, idx[i + q.length - 1]!]);
  }
  return hits;
}

/** A word range as a cut. Its edges are exact when they fall on cue edges;
 * punctuation trailing the last word in the same cue goes with it. */
function rangeCut(words: Word[], from: number, to: number): TranscriptCut {
  let end = to;
  while (words[end + 1] && !words[end + 1]!.norm && words[end + 1]!.cue === words[to]!.cue) end++;
  const a = words[from]!;
  const b = words[end]!;
  return {
    start: r3(a.start),
    end: r3(b.end),
    text: words.slice(from, end + 1).map((w) => w.raw).join(" "),
    exact: a.first && b.last,
  };
}

export interface CutRequest {
  /** 1-based cue numbers or quoted transcript text. */
  remove?: Array<number | string>;
  fillers?: boolean;
}

export interface CutPlan {
  cuts: TranscriptCut[];
  /** Fillers found inside a longer cue and left in (no word timing). */
  skippedFillers: number;
}

/** Merge cuts that overlap or touch (within 10 ms), sorted by start. Pure. */
export function mergeCuts(cuts: TranscriptCut[]): TranscriptCut[] {
  const sorted = [...cuts].filter((c) => c.end - c.start > 0.001).sort((a, b) => a.start - b.start);
  const out: TranscriptCut[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.start <= prev.end + 0.01) {
      if (c.end > prev.end) {
        prev.end = c.end;
        prev.text = `${prev.text} ${c.text}`;
      }
      prev.exact &&= c.exact;
    } else out.push({ ...c });
  }
  return out;
}

/** The spans to cut for a request. Unknown cue numbers, missing quotes and
 * ambiguous quotes are errors, so a cut never lands somewhere unintended. */
export function planTranscriptCuts(cues: Cue[], req: CutRequest): CutPlan {
  const words = cueWords(cues);
  const cuts: TranscriptCut[] = [];
  for (const r of req.remove ?? []) {
    if (typeof r === "number") {
      const c = cues[r - 1];
      if (!Number.isInteger(r) || !c) throw new ScreencastError(`No cue ${r}: the transcript has cues 1-${cues.length}.`);
      cuts.push({ start: r3(c.start), end: r3(c.end), text: c.text.replace(/\s+/g, " "), exact: true });
      continue;
    }
    const hits = findQuote(words, r);
    if (hits.length === 0) throw new ScreencastError(`Quote not found in the transcript: "${r}".`);
    if (hits.length > 1) {
      throw new ScreencastError(`Quote "${r}" occurs ${hits.length} times; quote more words or use cue numbers.`);
    }
    cuts.push(rangeCut(words, ...hits[0]!));
  }
  let skippedFillers = 0;
  if (req.fillers) {
    const fill = new Set(FILLERS);
    words.forEach((w) => {
      if (!fill.has(w.norm)) return;
      // Exact only when the filler is its cue's only spoken word.
      const alone = words.every((o) => o.cue !== w.cue || o === w || !o.norm);
      if (!alone) {
        skippedFillers++;
        return;
      }
      // Whisper times a filler tightly, so its tail and the pause around it
      // survive a cut at its cue edges ("uh," became "But,"); take the gap to
      // the neighbouring words too, up to FILLER_REACH on each side.
      const cue = cues[w.cue]!;
      const start = Math.max(cues[w.cue - 1]?.end ?? 0, cue.start - FILLER_REACH);
      const end = Math.min(cues[w.cue + 1]?.start ?? Infinity, cue.end + FILLER_REACH);
      cuts.push({ start: r3(Math.min(start, cue.start)), end: r3(Math.max(end, cue.end)), text: words.filter((o) => o.cue === w.cue).map((o) => o.raw).join(" "), exact: true });
    });
  }
  return { cuts: mergeCuts(cuts), skippedFillers };
}

/** Where time `t` of the source lands in the cut video. Pure. */
export function mapTime(t: number, cuts: Interval[]): number {
  let shift = 0;
  for (const c of cuts) {
    if (t <= c.start) break;
    shift += Math.min(t, c.end) - c.start;
  }
  return t - shift;
}

/** The transcript re-timed to the cut video: cut words are removed, cues
 * left empty are dropped, and the rest move back by the time cut before
 * them. Pure. */
export function retimeCues(cues: Cue[], cuts: Interval[]): Cue[] {
  const words = cueWords(cues);
  const inCut = (w: Word) => cuts.some((c) => w.start >= c.start - 0.0005 && w.end <= c.end + 0.0005);
  const out: Cue[] = [];
  cues.forEach((c, ci) => {
    const own = words.filter((w) => w.cue === ci);
    const kept = own.filter((w) => !inCut(w));
    if (!kept.some((w) => w.norm)) return;
    const text = kept.length === own.length ? c.text : kept.map((w) => w.raw).join(" ");
    const start = r3(mapTime(c.start, cuts));
    const end = r3(mapTime(c.end, cuts));
    if (end > start) out.push({ start, end, text });
  });
  return out;
}
