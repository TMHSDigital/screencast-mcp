/**
 * Pause and resume (#200), and the webcam sidecar it shares a timeline with.
 *
 * gdigrab and ddagrab cannot pause in place, so a recording is a run of
 * segments: pause_recording stops ffmpeg gracefully (the segment is a finished
 * fragmented mp4), resume_recording starts a new one with the same arguments,
 * and stop_recording joins them with a stream copy. The first segment is
 * written at outputPath itself, so a recording that is never paused works as
 * before; later ones go to `<output>.parts/`.
 *
 * The video clock skips the paused stretches. Markers keep using
 * `videoStartMs` (now - videoStartMs = video seconds): on resume it moves to
 * `segment start - seconds already recorded`. The input event log keeps one
 * helper running throughout; its epoch times are mapped through the segments'
 * spans, and input during a pause is dropped.
 *
 * A webcam records into a second file per segment from the same ffmpeg. Its
 * first frame lands a moment after (or before) the screen's, so at stop each
 * part is padded or trimmed to its screen segment and the parts are joined
 * into one file aligned frame for frame with the recording: overlay can then
 * place it in any corner with no offset.
 *
 * Everything except finishSegments is pure or in-memory bookkeeping.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ScreencastError } from "./errors.js";
import { runCapture } from "./ffmpeg.js";
import { jobTimeoutMs } from "./jobs.js";
import { concatList, buildReplayJoinArgs } from "./replay.js";
import type { ClockSpan } from "./events.js";
import type { CaptureOptions, Target } from "./targets.js";
import type { SessionRecord } from "./sessions.js";

/** One finished segment. */
export interface SegmentPart {
  path: string;
  /** Epoch ms of its first frame (ffmpeg's input start, else an estimate). */
  startMs: number;
  durationSec: number;
  webcamPath?: string;
  /** Epoch ms of the camera's first frame in this segment. */
  webcamStartMs?: number;
}

export interface SegmentState {
  /** Finished segments, oldest first. */
  parts: SegmentPart[];
  /** The segment being recorded now; absent while paused. */
  current?: Omit<SegmentPart, "durationSec">;
}

/** What resume_recording needs to start the next segment: the capture as
 * built at start (target, encoder, inputs), minus output and cap. */
export interface SegmentCapture {
  target: Target;
  opts: Omit<CaptureOptions, "output" | "maxDurationSec" | "webcam">;
  webcam?: { device: string; codec?: string[] };
}

export type Corner = "top_left" | "top_right" | "bottom_left" | "bottom_right";

export interface WebcamInfo {
  device: string;
  /** The aligned camera file, written at stop. */
  path: string;
  corner: Corner;
  /** Overlay width as a fraction of the recording's width. */
  size: number;
  shape: "rect" | "circle";
  error?: string;
}

export const DEFAULT_WEBCAM_SIZE = 0.25;

/** Directory for segments after the first, and for raw webcam parts. Pure. */
export function partsDir(output: string): string {
  return `${output}.parts`;
}

/** Where segment `index` is written: the output itself first, then the parts
 * directory. Pure. */
export function partPath(output: string, index: number): string {
  return index === 0 ? output : join(partsDir(output), `part-${String(index).padStart(3, "0")}.mp4`);
}

/** Raw camera file for segment `index`. Pure. */
export function webcamPartPath(output: string, index: number): string {
  return join(partsDir(output), `webcam-${String(index).padStart(3, "0")}.mp4`);
}

/** The aligned camera sidecar next to the recording: rec.mp4 -> rec.webcam.mp4. Pure. */
export function webcamOutputPath(output: string): string {
  const ext = extname(output);
  return join(dirname(output), `${basename(output, ext)}.webcam.mp4`);
}

/** Seconds recorded in finished segments. Pure. */
export function recordedSec(parts: SegmentPart[]): number {
  return parts.reduce((s, p) => s + p.durationSec, 0);
}

/** Each segment's place on the video clock; the running one is open-ended. Pure. */
export function clockSpans(state: SegmentState): ClockSpan[] {
  const spans: ClockSpan[] = [];
  let offset = 0;
  for (const p of state.parts) {
    spans.push({ startMs: p.startMs, offsetSec: offset, durationSec: p.durationSec });
    offset += p.durationSec;
  }
  if (state.current) spans.push({ startMs: state.current.startMs, offsetSec: offset });
  return spans;
}

/** The event log's clock at the end of a recording: the first frame's epoch,
 * the spans across pauses, and the video's length. Pure. */
export function eventClock(
  state: SegmentState | undefined,
  fallbackStartMs: number,
  nowMs: number,
): { startMs: number; endSec: number; spans?: ClockSpan[] } {
  if (!state || (state.parts.length === 0 && !state.current)) {
    return { startMs: fallbackStartMs, endSec: (nowMs - fallbackStartMs) / 1000 };
  }
  const spans = clockSpans(state);
  const live = state.current ? Math.max(0, (nowMs - state.current.startMs) / 1000) : 0;
  return { startMs: spans[0]!.startMs, endSec: recordedSec(state.parts) + live, spans };
}

/** The segment cap left after `recorded` seconds: 0 = no cap. Throws when
 * less than a second remains. Pure. */
export function remainingCapSec(maxDurationSec: number | undefined, recorded: number): number {
  if (!maxDurationSec) return 0;
  const left = Math.floor(maxDurationSec - recorded);
  if (left < 1) {
    throw new ScreencastError(
      `The recording already used its maxDurationSec cap (${maxDurationSec}s); nothing is left to resume.`,
      "Call stop_recording to finalize it.",
    );
  }
  return left;
}

/** Why a session cannot pause, or null when it can. Pure. */
export function pauseBlocker(record: SessionRecord, ownsChild: boolean): string | null {
  if (record.status === "paused") return "it is already paused";
  if (record.status !== "recording") return `it is ${record.status}`;
  if (record.backend === "wgc") return 'backend "wgc" cannot pause yet';
  if (record.replay) return "a replay buffer cannot pause";
  if (!record.capture || !record.segments?.current) return "it was started before pause was supported";
  if (!ownsChild) return "another server instance owns it";
  return null;
}

/** Why a session cannot resume, or null when it can. Pure. */
export function resumeBlocker(record: SessionRecord, owns: boolean): string | null {
  if (record.status === "recording") return "it is already recording";
  if (record.status !== "paused") return `it is ${record.status}`;
  if (!record.capture || !record.segments) return "its capture settings are missing";
  if (!owns) return "it was paused by another server instance";
  return null;
}

// ---------------------------------------------------------------------------
// In-memory: sessions mid-pause, and when a session's capture finally ends.

const pausing = new Set<string>();

export function markPausing(id: string): void {
  pausing.add(id);
}

export function isPausing(id: string): boolean {
  return pausing.has(id);
}

export function clearPausing(id: string): void {
  pausing.delete(id);
}

const ends = new Map<string, { promise: Promise<void>; resolve: () => void }>();

function endEntry(id: string) {
  let e = ends.get(id);
  if (!e) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    e = { promise, resolve };
    ends.set(id, e);
  }
  return e;
}

/** Resolves when the session's last segment has ended (not at a pause): the
 * event log converts then. */
export function sessionEnded(id: string): Promise<void> {
  return endEntry(id).promise;
}

/** Mark the session's capture as over. Idempotent. */
export function endSession(id: string): void {
  endEntry(id).resolve();
  // Keep the resolved entry briefly so a late sessionEnded() still resolves.
  setTimeout(() => ends.delete(id), 60_000).unref?.();
}

// ---------------------------------------------------------------------------
// Joining

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Line the camera parts up with their screen segments and join them: each
 * part is padded with its first frame (camera started late) or trimmed
 * (started early) by `leadSec`, held or cut to the segment's length, and the
 * parts are concatenated. One re-encode of the (small) camera stream. Pure.
 */
export function buildWebcamAlignArgs(
  parts: Array<{ path: string; leadSec: number; durationSec: number }>,
  output: string,
  codec: string[],
): string[] {
  if (parts.length === 0) throw new ScreencastError("No webcam parts to join.");
  const chains = parts.map((p, i) => {
    const d = r3(Math.max(0.001, p.durationSec));
    const lead = r3(p.leadSec);
    const head =
      lead > 0 ? `tpad=start_duration=${lead}:start_mode=clone,` : lead < 0 ? `trim=start=${-lead},setpts=PTS-STARTPTS,` : "";
    return `[${i}:v]${head}tpad=stop_duration=${d}:stop_mode=clone,trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[w${i}]`;
  });
  const join = `${parts.map((_, i) => `[w${i}]`).join("")}concat=n=${parts.length}:v=1:a=0[v]`;
  return [
    "-y", "-v", "error",
    ...parts.flatMap((p) => ["-i", p.path]),
    "-filter_complex", `${chains.join(";")};${join}`,
    "-map", "[v]",
    ...codec,
    "-movflags", "+faststart",
    output,
  ];
}

export interface FinishSegmentsResult {
  /** Segments joined into outputPath (false: a single segment, nothing to do). */
  joined: boolean;
  webcamPath?: string;
  error?: string;
  webcamError?: string;
}

/**
 * Join a finished recording's segments into outputPath and write the aligned
 * webcam file, then remove the parts directory. On a failure the parts are
 * kept and the error is reported (outputPath then holds the first segment).
 */
export async function finishSegments(
  output: string,
  parts: SegmentPart[],
  opts: { ffmpeg: string; webcamOutput?: string; webcamCodec: string[] },
): Promise<FinishSegmentsResult> {
  const dir = partsDir(output);
  const result: FinishSegmentsResult = { joined: false };
  const video = parts.filter((p) => existsSync(p.path) && p.durationSec > 0);
  const total = recordedSec(video);
  let keepDir = false;
  if (video.length > 1 || (video.length === 1 && video[0]!.path !== output)) {
    mkdirSync(dir, { recursive: true });
    const list = join(dir, "segments.txt");
    const tmp = join(dir, `joined${extname(output) || ".mp4"}`);
    writeFileSync(list, concatList(video.map((p) => p.path)));
    const res = await runCapture(opts.ffmpeg, buildReplayJoinArgs(list, tmp), jobTimeoutMs(total));
    if (res.code === 0 && existsSync(tmp)) {
      renameSync(tmp, output);
      result.joined = true;
    } else {
      keepDir = true;
      result.error = `Joining the ${video.length} segments failed; they are kept in ${dir}: ${res.stderr.trim().split("\n").slice(-3).join(" ")}`;
    }
  }
  const cams = video.filter((p) => p.webcamPath && existsSync(p.webcamPath));
  if (opts.webcamOutput && cams.length > 0) {
    const args = buildWebcamAlignArgs(
      cams.map((p) => ({
        path: p.webcamPath!,
        leadSec: p.webcamStartMs !== undefined ? (p.webcamStartMs - p.startMs) / 1000 : 0,
        durationSec: p.durationSec,
      })),
      opts.webcamOutput,
      opts.webcamCodec,
    );
    const res = await runCapture(opts.ffmpeg, args, jobTimeoutMs(total));
    if (res.code === 0 && existsSync(opts.webcamOutput)) {
      result.webcamPath = opts.webcamOutput;
    } else {
      keepDir = true;
      result.webcamError = `Aligning the webcam failed; its raw parts are kept in ${dir}: ${res.stderr.trim().split("\n").slice(-3).join(" ")}`;
    }
  }
  if (!keepDir) rmSync(dir, { recursive: true, force: true });
  return result;
}

/** Where to put the webcam over a recording for overlay: a corner, `size` of
 * the width, a 2% margin, even sizes. Pure. */
export function webcamPlacement(
  screen: { width: number; height: number },
  cam: { width: number; height: number },
  corner: Corner,
  size: number,
): { x: number; y: number; width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const width = even(screen.width * size);
  const height = even((width * cam.height) / Math.max(1, cam.width));
  const m = Math.round(screen.width * 0.02);
  const x = corner.endsWith("left") ? m : Math.max(0, screen.width - width - m);
  const y = corner.startsWith("top") ? m : Math.max(0, screen.height - height - m);
  return { x, y, width, height };
}
