/**
 * Searchable text timeline for a recording (#245).
 *
 * index_recording cuts a video into segments at its scene changes (plus evenly
 * spread fill points so no stretch goes unread for long), OCRs one keyframe per
 * segment, and attaches the input events, markers, and transcript cues that
 * fall inside each one. The result is a JSON sidecar, `<video>.index.json`,
 * that search_recording scores in process: agents find "when did the error
 * appear" as text with timecodes instead of pulling frames as images.
 *
 * The sidecar keeps the raw OCR text (so a secret scan can run over the whole
 * timeline); search results mask secrets with bug_report's pattern before they
 * are returned. Everything here is pure except fingerprintFile, readIndex,
 * writeIndex, and resolveRecording. The segment/attach helpers are generic
 * enough to reuse for any other timeline built from the same sources.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ScreencastError } from "./errors.js";
import { pickSceneFrames, type SceneChange } from "./media.js";
import { normalizeForMatch, regexRanges, MAX_QUERY_LENGTH } from "./ocr.js";
import { maskSecrets, DEFAULT_SECRET_PATTERN } from "./bugReport.js";
import { eventPaths, whenFinalized, type InputEvent } from "./events.js";
import { readMarkers, type Marker } from "./chapters.js";
import type { Cue } from "./captions.js";
import { assertOutputAllowed } from "./paths.js";
import { getStore } from "../context.js";

export const INDEX_VERSION = 1;
/** Scene threshold for indexing: lower than sample_frames' default, since a
 * small dialog appearing is exactly the change worth a keyframe. */
export const DEFAULT_INDEX_THRESHOLD = 0.03;
export const DEFAULT_INDEX_FRAMES = 120;
export const MAX_INDEX_FRAMES = 600;
/** No stretch of video longer than this goes without a keyframe, while the
 * frame cap allows. */
export const MAX_SEGMENT_SEC = 10;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
/** Longest snippet returned per match. */
export const MAX_SNIPPET = 200;
/** Matches listed per hit. */
export const MAX_MATCHES_PER_HIT = 5;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface TimedText {
  /** Video seconds. */
  t: number;
  text: string;
}

export interface IndexSegment {
  start: number;
  end: number;
  /** OCR lines of the segment's keyframe. */
  ocr: string[];
  events?: TimedText[];
  markers?: TimedText[];
  transcript?: TimedText[];
}

export interface Fingerprint {
  size: number;
  mtimeMs: number;
  /** sha1 of the first and last 64 KB: cheap, and catches a rewrite in place. */
  sample: string;
}

export interface RecordingIndex {
  version: number;
  video: string;
  fingerprint: Fingerprint;
  durationSec: number;
  createdAt: string;
  sceneThreshold: number;
  maxFrames: number;
  /** Keyframes OCR'd (0 when OCR was unavailable). */
  framesRead: number;
  ocr: boolean;
  segments: IndexSegment[];
}

export type HitSource = "screen" | "event" | "marker" | "transcript";

export interface SearchMatch {
  source: HitSource;
  t: number;
  text: string;
}

export interface SearchHit {
  start: number;
  end: number;
  /** Time of the first match (a cue, marker, or event can be more precise
   * than the segment start). */
  t: number;
  score: number;
  matches: SearchMatch[];
}

/** `<video minus extension>.index.json`, next to the recording. */
export function indexSidecarPath(video: string): string {
  return `${video.replace(/\.[^./\\]+$/, "")}.index.json`;
}

/** Where the index goes when the recording's folder is outside the allowed
 * output dirs: SCREENCAST_HOME/edits/indexes, keyed by the full path. */
export function fallbackIndexPath(video: string, editsDir: string): string {
  const key = createHash("sha1").update(resolve(video).toLowerCase()).digest("hex").slice(0, 12);
  const name = basename(video).replace(/\.[^.]+$/, "");
  return join(editsDir, "indexes", `${name}-${key}.index.json`);
}

/** The sidecar when it may be written there, else the fallback. */
export function indexWritePath(video: string, editsDir: string): string {
  const sidecar = indexSidecarPath(video);
  try {
    assertOutputAllowed(sidecar);
    return sidecar;
  } catch {
    return fallbackIndexPath(video, editsDir);
  }
}

/** The existing index for a video (sidecar first), or null. */
export function findIndex(video: string, editsDir: string): string | null {
  for (const p of [indexSidecarPath(video), fallbackIndexPath(video, editsDir)]) if (existsSync(p)) return p;
  return null;
}

/**
 * Keyframe times: the opening frame and the strongest scene changes (within
 * maxFrames), then, while the cap allows, the longest gap (including the run
 * to the end) is halved until none is longer than maxGap. Sorted. Pure.
 */
export function planKeyframes(changes: SceneChange[], durationSec: number, maxFrames: number, maxGap = MAX_SEGMENT_SEC): number[] {
  const times = pickSceneFrames(
    changes.filter((c) => c.timeSec < durationSec),
    maxFrames,
  ).map(r3);
  while (times.length < maxFrames) {
    let best = -1;
    let gap = 0;
    for (let i = 0; i < times.length; i++) {
      const g = (times[i + 1] ?? durationSec) - times[i]!;
      if (g > gap) {
        gap = g;
        best = i;
      }
    }
    if (best === -1 || gap <= maxGap) break;
    times.splice(best + 1, 0, r3(times[best]! + gap / 2));
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

/** Segments from keyframe starts, each running to the next (the last to the
 * end). Pure. */
export function segmentsFrom(starts: number[], durationSec: number): Array<{ start: number; end: number }> {
  return starts.map((start, i) => ({ start, end: r3(starts[i + 1] ?? durationSec) }));
}

/** Where to grab a segment's keyframe: just inside it (a seek exactly onto a
 * change can land on the frame before), never past its end. Pure. */
export function keyframeTime(seg: { start: number; end: number }): number {
  return r3(seg.start + Math.min(0.25, (seg.end - seg.start) / 2));
}

/** Join neighbouring segments that read the same text: a static stretch cut
 * by fill points or a cursor blink becomes one segment. Pure. */
export function mergeSegments(segments: IndexSegment[]): IndexSegment[] {
  const out: IndexSegment[] = [];
  for (const seg of segments) {
    const prev = out.at(-1);
    if (prev && prev.ocr.join("\n") === seg.ocr.join("\n") && !seg.events && !seg.markers && !seg.transcript) {
      prev.end = seg.end;
    } else {
      out.push({ ...seg, ocr: [...seg.ocr] });
    }
  }
  return out;
}

/** Input events as searchable text: clicks, shortcuts, typing bursts, scrolls,
 * and log gaps. Moves and button-ups are noise for search. Pure. */
export function eventTexts(events: InputEvent[]): TimedText[] {
  const out: TimedText[] = [];
  for (const e of events) {
    const at = `at ${Math.round(e.x)},${Math.round(e.y)}`;
    let text: string | null = null;
    if (e.type === "down") text = `click ${e.button ?? "left"} ${at}`;
    else if (e.type === "key") text = `shortcut ${e.keys ?? "key"}`;
    else if (e.type === "typing") text = `typing ${r3(e.durationSec ?? 0)} s`;
    else if (e.type === "wheel") text = `scroll ${(e.delta ?? 0) > 0 ? "up" : "down"} ${at}`;
    else if (e.type === "gap") text = `event gap (${e.reason ?? "unknown"})`;
    if (text) out.push({ t: r3(e.t), text });
  }
  return out;
}

export function markerTexts(markers: readonly Marker[]): TimedText[] {
  return markers.map((m) => ({ t: r3(m.t), text: m.label }));
}

export function cueTexts(cues: readonly Cue[]): TimedText[] {
  return cues.map((c) => ({ t: r3(c.start), text: c.text.replace(/\s+/g, " ").trim() })).filter((c) => c.text);
}

/** Put each item in the segment that holds its time (the last segment also
 * takes anything at or past its end). Returns new segments. Pure. */
export function attach(segments: IndexSegment[], items: TimedText[], field: "events" | "markers" | "transcript"): IndexSegment[] {
  const out = segments.map((s) => {
    const { [field]: _old, ...rest } = s;
    return rest as IndexSegment;
  });
  if (out.length === 0) return out;
  for (const item of [...items].sort((a, b) => a.t - b.t)) {
    let i = out.findIndex((s) => item.t >= s.start && item.t < s.end);
    if (i === -1) i = item.t < out[0]!.start ? 0 : out.length - 1;
    const seg = out[i]!;
    (seg[field] ??= []).push(item);
  }
  return out;
}

/** Fingerprint a file without reading all of it. */
export function fingerprintFile(path: string): Fingerprint {
  const st = statSync(path);
  const hash = createHash("sha1");
  const chunk = 64 * 1024;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(chunk);
    for (const pos of st.size > chunk ? [0, st.size - chunk] : [0]) {
      const n = readSync(fd, buf, 0, chunk, pos);
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs), sample: hash.digest("hex") };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.sample === b.sample;
}

/** Parse an index file's text; null when it is not a current index. Pure. */
export function parseIndex(text: string): RecordingIndex | null {
  try {
    const data = JSON.parse(text) as RecordingIndex;
    if (data?.version !== INDEX_VERSION || !Array.isArray(data.segments) || !data.fingerprint) return null;
    return data;
  } catch {
    return null;
  }
}

export function readIndex(path: string): RecordingIndex | null {
  try {
    return parseIndex(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Write atomically (temp + rename). */
export function writeIndex(path: string, index: RecordingIndex): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, path);
}

function snippet(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > MAX_SNIPPET ? `${s.slice(0, MAX_SNIPPET - 1)}…` : s;
}

interface Item extends SearchMatch {
  seg: number;
}

function itemsOf(index: RecordingIndex): Item[] {
  const items: Item[] = [];
  index.segments.forEach((s, seg) => {
    for (const text of s.ocr) items.push({ seg, source: "screen", t: s.start, text });
    for (const [source, list] of [["event", s.events], ["marker", s.markers], ["transcript", s.transcript]] as const) {
      for (const it of list ?? []) items.push({ seg, source, t: it.t, text: it.text });
    }
  });
  return items;
}

/**
 * Search the index. A plain query matches through OCR misreads
 * (normalizeForMatch); a segment whose items hold the whole phrase scores 2 per
 * matching item, and one that only holds every word of it (spread over lines)
 * scores 1. A regex query scores 2 per matching item. Hits come back best
 * first, then earliest, with secrets in the snippets masked. Pure.
 */
export function searchIndex(
  index: RecordingIndex,
  query: string,
  opts: { regex?: boolean; limit?: number; secretPattern?: string | null } = {},
): { hits: SearchHit[]; total: number } {
  if (query.trim().length === 0) throw new ScreencastError("query must not be empty.");
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ScreencastError(`The query is ${query.length} characters; at most ${MAX_QUERY_LENGTH} are allowed.`);
  }
  const items = itemsOf(index);
  const matched = new Map<number, { score: number; matches: Item[] }>();
  const add = (item: Item, score: number) => {
    const entry = matched.get(item.seg) ?? { score: 0, matches: [] };
    entry.score += score;
    entry.matches.push(item);
    matched.set(item.seg, entry);
  };
  if (opts.regex) {
    const ranges = regexRanges(items.map((i) => i.text), query);
    items.forEach((item, i) => {
      if ((ranges[i] ?? []).length > 0) add(item, 2);
    });
  } else {
    const needle = normalizeForMatch(query.trim());
    const words = needle.split("_").filter(Boolean);
    const norm = items.map((i) => normalizeForMatch(i.text));
    items.forEach((item, i) => {
      if (norm[i]!.includes(needle)) add(item, 2);
    });
    if (words.length > 1) {
      const bySeg = new Map<number, number[]>();
      items.forEach((item, i) => bySeg.set(item.seg, [...(bySeg.get(item.seg) ?? []), i]));
      for (const [seg, idx] of bySeg) {
        if (matched.has(seg)) continue;
        if (!words.every((w) => idx.some((i) => norm[i]!.includes(w)))) continue;
        for (const i of idx) if (words.some((w) => norm[i]!.includes(w))) add(items[i]!, 0);
        matched.get(seg)!.score = 1;
      }
    }
  }
  const ranked = [...matched.entries()]
    .map(([seg, m]) => ({ seg, ...m }))
    .sort((a, b) => b.score - a.score || index.segments[a.seg]!.start - index.segments[b.seg]!.start);
  const chosen = ranked.slice(0, opts.limit ?? DEFAULT_SEARCH_LIMIT);
  const pattern = opts.secretPattern === undefined ? DEFAULT_SECRET_PATTERN : opts.secretPattern;
  const shown = chosen.flatMap((c) => c.matches.slice(0, MAX_MATCHES_PER_HIT));
  const masked = pattern ? maskSecrets(shown.map((m) => m.text), pattern) : shown.map((m) => m.text);
  let k = 0;
  const hits = chosen.map((c) => {
    const seg = index.segments[c.seg]!;
    const matches = c.matches.slice(0, MAX_MATCHES_PER_HIT).map((m) => ({ source: m.source, t: m.t, text: snippet(masked[k++] ?? "") }));
    return { start: seg.start, end: seg.end, t: Math.min(...c.matches.map((m) => m.t)), score: c.score, matches };
  });
  return { hits, total: matched.size };
}

export interface RecordingSource {
  path: string;
  eventsPath: string | null;
  markers: Marker[];
}

/** A recording from a sessionId (stopped, finalized) or a file path, with its
 * event log and markers when there are any. */
export async function resolveRecording(args: { input?: string; sessionId?: string }): Promise<RecordingSource> {
  if ((args.input === undefined) === (args.sessionId === undefined)) {
    throw new ScreencastError("Provide exactly one of: input (a recording path) or sessionId.");
  }
  if (args.sessionId !== undefined) {
    const record = getStore().get(args.sessionId);
    if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
    if (record.status === "recording") throw new ScreencastError("The recording is still running; stop_recording it first.");
    await whenFinalized(record.id);
    if (!existsSync(record.outputPath)) throw new ScreencastError(`The session's recording is missing: ${record.outputPath}`);
    const events = record.events?.path;
    const markers = record.markers?.length ? record.markers : readMarkers(record.outputPath);
    return { path: record.outputPath, eventsPath: events && existsSync(events) ? events : null, markers };
  }
  const path = args.input!;
  if (!existsSync(path)) throw new ScreencastError(`Input file not found: ${path}`);
  const { jsonl } = eventPaths(path);
  return { path, eventsPath: existsSync(jsonl) ? jsonl : null, markers: readMarkers(path) };
}
