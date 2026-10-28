/**
 * Markers and chapters (#174).
 *
 * add_marker stamps a labelled moment on a recording's video clock. Markers
 * live in the session record and in a `<video>.markers.json` sidecar next to
 * the file, so a tool given only the path (chapters, pipeline, the review
 * player) finds them too. The chapters tool turns markers, scene changes, or
 * transcript sections into chapters: an FFMETADATA file muxed into the
 * mp4/mkv/mov with stream copy (no re-encode), plus YouTube chapter text.
 * pipeline re-times markers through its trims and speed changes.
 *
 * Everything here is pure except the sidecar read/write and probeChapters.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ScreencastError } from "./errors.js";
import { requireFfmpeg, runCapture } from "./ffmpeg.js";
import type { SceneChange } from "./media.js";
import type { Cue } from "./captions.js";

export interface Marker {
  /** Video seconds. */
  t: number;
  label: string;
  /** Wall-clock time it was added (ISO), when stamped live. */
  at?: string;
}

export interface ChapterPoint {
  start: number;
  title: string;
}

export interface Chapter {
  start: number;
  end: number;
  title: string;
}

/** A timing change a pipeline step makes: a trim keeps [start, end) and
 * shifts it to 0; a speed change divides every time by the factor. */
export type TimeOp = { op: "trim"; start: number; end: number } | { op: "speed"; factor: number };

export const MAX_MARKERS = 500;
export const MAX_LABEL = 200;
/** YouTube's rules for chapters in a description: the first at 0:00, at least
 * three, each at least ten seconds long. */
export const YOUTUBE_MIN_CHAPTERS = 3;
export const YOUTUBE_MIN_CHAPTER_SEC = 10;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The sidecar holding a video's markers. */
export function markersPath(video: string): string {
  return `${video.replace(/\.[^./\\]+$/, "")}.markers.json`;
}

/** A live marker's video time: seconds since the first captured frame. */
export function markerTimeSec(videoStartMs: number, nowMs: number): number {
  return Math.max(0, r3((nowMs - videoStartMs) / 1000));
}

/** One line, collapsed whitespace, bounded length. */
export function cleanLabel(label: string, max = MAX_LABEL): string {
  const s = label.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Add a marker in time order (after any at the same time). Pure. */
export function insertMarker(list: readonly Marker[], marker: Marker): Marker[] {
  if (list.length >= MAX_MARKERS) {
    throw new ScreencastError(`A recording holds at most ${MAX_MARKERS} markers.`);
  }
  const label = cleanLabel(marker.label);
  if (!label) throw new ScreencastError("A marker needs a non-empty label.");
  if (!Number.isFinite(marker.t) || marker.t < 0) throw new ScreencastError("A marker time must be a non-negative number of seconds.");
  const m: Marker = { ...marker, t: r3(marker.t), label };
  const i = list.findIndex((x) => x.t > m.t);
  return i === -1 ? [...list, m] : [...list.slice(0, i), m, ...list.slice(i)];
}

function isMarker(v: unknown): v is Marker {
  const m = v as Marker;
  return !!m && typeof m.t === "number" && Number.isFinite(m.t) && m.t >= 0 && typeof m.label === "string";
}

/** Parse a sidecar's text; entries that are not markers are skipped. Pure. */
export function parseMarkerSidecar(text: string): Marker[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data as { markers?: unknown })?.markers;
  return Array.isArray(list) ? list.filter(isMarker).sort((a, b) => a.t - b.t) : [];
}

/** A video's markers from its sidecar, or [] when there is none. */
export function readMarkers(video: string): Marker[] {
  const path = markersPath(video);
  if (!existsSync(path)) return [];
  try {
    return parseMarkerSidecar(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/** Write a video's markers sidecar atomically (temp + rename). */
export function writeMarkers(video: string, markers: readonly Marker[], sessionId?: string): string {
  const path = markersPath(video);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...(sessionId ? { sessionId } : {}), markers }, null, 2));
  renameSync(tmp, path);
  return path;
}

/**
 * Re-time markers through trims and speed changes, in order. A trim drops the
 * markers outside what it keeps, except that the last marker before the kept
 * range moves to its start (unless one is already there): the chapter it opens
 * is still running when the kept range begins. Pure.
 */
export function retimeMarkers(markers: readonly Marker[], ops: readonly TimeOp[]): Marker[] {
  let cur = [...markers].sort((a, b) => a.t - b.t);
  for (const op of ops) {
    if (op.op === "speed") {
      cur = cur.map((m) => ({ ...m, t: r3(m.t / op.factor) }));
      continue;
    }
    const inside = cur.filter((m) => m.t >= op.start && m.t < op.end).map((m) => ({ ...m, t: r3(m.t - op.start) }));
    const carried = cur.filter((m) => m.t < op.start).at(-1);
    cur = carried && !inside.some((m) => m.t < 0.001) ? [{ ...carried, t: 0 }, ...inside] : inside;
  }
  return cur;
}

/**
 * Turn points into chapters that cover [0, duration): sorted, clamped, and
 * spaced at least `minChapterSec` apart (a later point too close to the one
 * before is dropped). A first point within `minChapterSec` of 0 moves to 0;
 * otherwise an `introTitle` chapter opens the video. A last chapter shorter
 * than `minChapterSec` merges into the one before. Pure.
 */
export function buildChapters(
  points: readonly ChapterPoint[],
  durationSec: number,
  opts: { minChapterSec?: number; introTitle?: string } = {},
): Chapter[] {
  const min = Math.max(0.001, opts.minChapterSec ?? 1);
  const sorted = points
    .filter((p) => Number.isFinite(p.start) && p.start >= 0 && p.start < durationSec)
    .map((p, i) => ({ start: r3(p.start), title: cleanLabel(p.title, 100) || `Chapter ${i + 1}` }))
    .sort((a, b) => a.start - b.start);
  const kept: ChapterPoint[] = [];
  for (const p of sorted) {
    const last = kept.at(-1);
    if (!last) {
      if (p.start < min) kept.push({ ...p, start: 0 });
      else kept.push({ start: 0, title: opts.introTitle ?? "Intro" }, p);
    } else if (p.start - last.start >= min) {
      kept.push(p);
    }
  }
  const lastKept = kept.at(-1);
  if (kept.length > 1 && lastKept && durationSec - lastKept.start < min) kept.pop();
  return kept.map((p, i) => ({ start: p.start, end: r3(kept[i + 1]?.start ?? durationSec), title: p.title }));
}

/** `M:SS`, or `H:MM:SS` for a video an hour or longer (seconds floored). */
export function youtubeTimestamp(sec: number, long: boolean): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return long ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

/** YouTube chapter text for a description, and the rules it breaks. Pure. */
export function youtubeChapters(chapters: readonly Chapter[], durationSec: number): { text: string; issues: string[] } {
  const long = durationSec >= 3600;
  const text = chapters.map((c) => `${youtubeTimestamp(c.start, long)} ${c.title}`).join("\n");
  const issues: string[] = [];
  if (chapters.length < YOUTUBE_MIN_CHAPTERS) {
    issues.push(`YouTube needs at least ${YOUTUBE_MIN_CHAPTERS} chapters; there are ${chapters.length}.`);
  }
  if (chapters[0] && chapters[0].start !== 0) issues.push("YouTube needs the first chapter at 0:00.");
  const short = chapters.filter((c) => c.end - c.start < YOUTUBE_MIN_CHAPTER_SEC);
  if (short.length > 0) {
    issues.push(
      `YouTube needs every chapter to be at least ${YOUTUBE_MIN_CHAPTER_SEC} s long; ${short.length} ` +
        `${short.length === 1 ? "is" : "are"} shorter (${short.map((c) => `"${c.title}"`).join(", ")}). ` +
        `Raise minChapterSec to ${YOUTUBE_MIN_CHAPTER_SEC} to merge them.`,
    );
  }
  return { text, issues };
}

/** Escape a value for an FFMETADATA file: `=`, `;`, `#`, `\`, and newlines. */
export function escapeFfmetadata(value: string): string {
  return value.replace(/[=;#\\\n]/g, (c) => `\\${c}`);
}

/** The FFMETADATA file ffmpeg reads with `-f ffmetadata`, times in ms. Pure. */
export function ffmetadata(chapters: readonly Chapter[]): string {
  const lines = [";FFMETADATA1"];
  for (const c of chapters) {
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${Math.round(c.start * 1000)}`,
      `END=${Math.round(c.end * 1000)}`,
      `title=${escapeFfmetadata(c.title)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Markers as chapter points. */
export function markerPoints(markers: readonly Marker[]): ChapterPoint[] {
  return markers.map((m) => ({ start: m.t, title: m.label }));
}

/** Chapter points at the strongest scene changes, at least `minChapterSec`
 * from each other and from 0, at most `maxChapters` including the opening
 * one; titled Scene 1, Scene 2, ... in time order. Pure. */
export function scenePoints(scenes: readonly SceneChange[], minChapterSec: number, maxChapters: number): ChapterPoint[] {
  const picked: number[] = [0];
  for (const s of [...scenes].sort((a, b) => b.score - a.score)) {
    if (picked.length >= maxChapters) break;
    if (picked.every((t) => Math.abs(t - s.timeSec) >= minChapterSec)) picked.push(s.timeSec);
  }
  return picked.sort((a, b) => a - b).map((t, i) => ({ start: t, title: `Scene ${i + 1}` }));
}

/** First words of a cue, for a chapter title: one line, cut at a word. */
function cueTitle(text: string, max = 60): string {
  const s = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Transcript sections: a new section starts at a cue that follows a pause of
 * at least `gapSec`, once the current section is `minChapterSec` long; each is
 * titled by its first words. Pure. */
export function transcriptPoints(cues: readonly Cue[], opts: { gapSec?: number; minChapterSec?: number } = {}): ChapterPoint[] {
  const gap = opts.gapSec ?? 2;
  const min = opts.minChapterSec ?? 30;
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const out: ChapterPoint[] = [];
  let prevEnd = -Infinity;
  for (const c of sorted) {
    const last = out.at(-1);
    if (!last || (c.start - prevEnd >= gap && c.start - last.start >= min)) {
      out.push({ start: c.start, title: cueTitle(c.text) });
    }
    prevEnd = Math.max(prevEnd, c.end);
  }
  return out;
}

export type ChapterContainer = ".mp4" | ".mkv" | ".mov";

/**
 * Mux chapters (and optionally a soft subtitle track) into a copy of the
 * video with stream copy: input 1 is the FFMETADATA file, input 2 the
 * subtitles. Global metadata stays the source's; chapters come only from the
 * file. A new subtitle track replaces the source's subtitle tracks; it is
 * mov_text in mp4/mov and copied as is into mkv. Pure.
 */
export function buildChaptersMuxArgs(
  input: string,
  metaFile: string,
  output: string,
  opts: { container: ChapterContainer; subtitles?: string; language?: string },
): string[] {
  const subs = opts.subtitles;
  return [
    "-y",
    "-i", input,
    "-f", "ffmetadata", "-i", metaFile,
    ...(subs ? ["-i", subs] : []),
    "-map", "0:v", "-map", "0:a?",
    ...(subs ? ["-map", "2:s:0"] : ["-map", "0:s?"]),
    "-map_metadata", "0",
    "-map_chapters", "1",
    "-c", "copy",
    ...(subs ? ["-c:s", opts.container === ".mkv" ? "copy" : "mov_text"] : []),
    ...(subs && opts.language ? ["-metadata:s:s:0", `language=${opts.language}`] : []),
    ...(opts.container === ".mkv" ? [] : ["-movflags", "+faststart"]),
    output,
  ];
}

/** ffprobe arguments that print a file's chapters as JSON. */
export function buildChaptersProbeArgs(input: string): string[] {
  return ["-v", "quiet", "-print_format", "json", "-show_chapters", input];
}

/** Parse ffprobe's -show_chapters JSON. Pure. */
export function parseChaptersProbe(stdout: string): Chapter[] {
  let data: { chapters?: Array<{ start_time?: string; end_time?: string; tags?: { title?: string } }> };
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  return (data.chapters ?? []).flatMap((c, i) => {
    const start = Number(c.start_time);
    const end = Number(c.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ start: r3(start), end: r3(end), title: c.tags?.title ?? `Chapter ${i + 1}` }];
  });
}

/** The chapters embedded in a media file ([] when none, or on a probe error). */
export async function probeChapters(input: string, signal?: AbortSignal): Promise<Chapter[]> {
  const { ffprobe } = requireFfmpeg();
  const res = await runCapture(ffprobe, buildChaptersProbeArgs(input), 30_000, { signal });
  return res.code === 0 ? parseChaptersProbe(res.stdout) : [];
}

/** Markers for a video: its sidecar, else its embedded chapters. */
export async function markersOrChapters(video: string, signal?: AbortSignal): Promise<{ markers: Marker[]; from: "sidecar" | "chapters" | null }> {
  const sidecar = readMarkers(video);
  if (sidecar.length > 0) return { markers: sidecar, from: "sidecar" };
  const embedded = await probeChapters(video, signal);
  if (embedded.length > 0) return { markers: embedded.map((c) => ({ t: c.start, label: c.title })), from: "chapters" };
  return { markers: [], from: null };
}
