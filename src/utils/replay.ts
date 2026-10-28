/**
 * Instant replay (#197): a rolling recording buffer, and saving its last N
 * seconds after the fact.
 *
 * A replay session records with ffmpeg's segment muxer instead of one mp4:
 * `segmentSec`-long MPEG-TS segments in a ring of `wrap` files
 * (`-segment_wrap`), so disk use stays at about the buffer length however
 * long the session runs. Keyframes are forced on every segment boundary, so
 * each segment starts cleanly. ffmpeg rewrites a CSV list of the segments in
 * the ring (name, start, end) as each one completes.
 *
 * save_replay snapshots the segments it needs (plus the one still being
 * written), joins them with a stream copy, and cuts the join to the requested
 * length. The cut is a stream copy too, so it is near-instant: the frames
 * between the segment's keyframe and the cut stay in the file behind an edit
 * list, the way trim's stream copy leaves them. `reencode: true` writes a
 * frame-exact file without them.
 *
 * Everything but saveReplay and the directory cleanup is pure.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScreencastError } from "./errors.js";
import { runCapture } from "./ffmpeg.js";
import { jobTimeoutMs } from "./jobs.js";
import { buildProbeArgs, parseMediaInfo } from "./media.js";
import { homeRoot, rand, sequencePattern, stamp } from "./paths.js";
import { resolveQuality, type Quality } from "./targets.js";
import {
  convertEvents,
  eventPaths,
  formatEventsJsonl,
  selectEvents,
  summarizeEvents,
  type CaptureFrame,
  type InputEvent,
  type KeyMode,
} from "./events.js";

/** Segment length: a save lags the live screen by at most one segment when
 * the in-progress one cannot be used, and the cut snaps to its keyframes. */
export const REPLAY_SEGMENT_SEC = 2;
/** Extra segments kept in the ring beyond the buffer length, so the oldest
 * segment a save reads is never the one ffmpeg reopens next. */
export const REPLAY_SLACK_SEGMENTS = 3;
export const MIN_REPLAY_SEC = 4;
export const MAX_REPLAY_SEC = 3600;

const SEGMENT_PATTERN = "seg%05d.ts";
const SEGMENT_NAME = /^seg(\d{5})\.ts$/;
const LIST_NAME = "segments.csv";
/** Replay buffer directories are named like this under replayRoot(). */
const DIR_NAME = /^buf-[\w-]+$/;

/** A replay session's buffer, stored on its session record. */
export interface ReplayBuffer {
  /** Directory holding the segment ring and its list. */
  dir: string;
  /** Seconds of footage the buffer keeps. */
  bufferSec: number;
  segmentSec: number;
  /** Number of segment files in the ring. */
  wrap: number;
  /** The live input event log, when the session was started with events. */
  events?: { raw: string; keys: KeyMode; startMs: number; frame: CaptureFrame };
}

/** Where replay buffers live: SCREENCAST_HOME/replay. */
export function replayRoot(): string {
  return join(homeRoot(), "replay");
}

/** Segments in the ring for a buffer of `bufferSec`. Pure. */
export function replayWrap(bufferSec: number, segmentSec = REPLAY_SEGMENT_SEC): number {
  return Math.ceil(bufferSec / segmentSec) + REPLAY_SLACK_SEGMENTS;
}

/** Validate a requested buffer length and plan its ring. Pure apart from the
 * directory name (it does not create it). */
export function planReplayBuffer(bufferSec: number, segmentSec = REPLAY_SEGMENT_SEC): ReplayBuffer {
  if (!Number.isInteger(bufferSec) || bufferSec < MIN_REPLAY_SEC || bufferSec > MAX_REPLAY_SEC) {
    throw new ScreencastError(
      `replayBufferSec must be an integer from ${MIN_REPLAY_SEC} to ${MAX_REPLAY_SEC} seconds.`,
    );
  }
  return {
    dir: join(replayRoot(), `buf-${stamp()}-${rand(6)}`),
    bufferSec,
    segmentSec,
    wrap: replayWrap(bufferSec, segmentSec),
  };
}

/** The ring's segment list (CSV: name,start,end per completed segment). */
export function segmentListPath(dir: string): string {
  return join(dir, LIST_NAME);
}

/**
 * Turn a recording's ffmpeg args (buildCaptureArgs: inputs, encoder, then
 * `-movflags … <output.mp4>`) into ones that write the segment ring instead.
 * Rewriting the finished vector keeps every input and encoder option the
 * capture builder chooses. Pure.
 */
export function segmentOutputArgs(captureArgs: string[], buf: Pick<ReplayBuffer, "dir" | "segmentSec" | "wrap">): string[] {
  const args = captureArgs.slice(0, -1); // drop the .mp4 output
  const mov = args.indexOf("-movflags");
  if (mov >= 0) args.splice(mov, 2); // fragmented-mp4 flags do not apply to segments
  return [
    ...args,
    // A keyframe on every boundary, so each segment can be cut and joined alone.
    "-force_key_frames", `expr:gte(t,n_forced*${buf.segmentSec})`,
    "-f", "segment",
    "-segment_time", String(buf.segmentSec),
    "-segment_wrap", String(buf.wrap),
    "-segment_list", segmentListPath(buf.dir),
    "-segment_list_type", "csv",
    "-segment_list_size", String(buf.wrap),
    "-segment_format", "mpegts",
    // Write each packet through, so the segment still being written holds the
    // newest frames for a save instead of sitting in a 32 KB buffer.
    "-segment_format_options", "flush_packets=1",
    sequencePattern(buf.dir, SEGMENT_PATTERN),
  ];
}

export interface SegmentEntry {
  file: string;
  /** Position in the ring (the number in the file name). */
  index: number;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
}

/** Parse ffmpeg's CSV segment list, oldest first. A torn last line (the list
 * is being rewritten) is skipped. Pure. */
export function parseSegmentList(csv: string): SegmentEntry[] {
  const out: SegmentEntry[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [file = "", s, e] = line.trim().split(",");
    const m = SEGMENT_NAME.exec(file);
    const start = Number(s);
    const end = Number(e);
    if (!m || s === undefined || e === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({ file, index: Number(m[1]), start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The newest completed segments that together cover `lastSec`, oldest
 * first. Pure. */
export function pickSegments(entries: SegmentEntry[], lastSec: number): SegmentEntry[] {
  const picked: SegmentEntry[] = [];
  let covered = 0;
  for (let i = entries.length - 1; i >= 0 && covered < lastSec; i--) {
    const e = entries[i]!;
    picked.unshift(e);
    covered += e.end - e.start;
  }
  return picked;
}

/** The file ffmpeg is writing now: the ring slot after the newest completed
 * segment. Pure. */
export function liveSegmentFile(entries: SegmentEntry[], wrap: number): string {
  const last = entries.at(-1);
  const index = last ? (last.index + 1) % wrap : 0;
  return `seg${String(index).padStart(5, "0")}.ts`;
}

/** The concat-demuxer list for the snapshot files. Pure. */
export function concatList(files: string[]): string {
  return files.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** Join the snapshot segments into one mp4 (stream copy). Pure. */
export function buildReplayJoinArgs(listFile: string, output: string): string[] {
  return ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output];
}

/** Cut the joined mp4 to its last stretch from `startSec`. The input is an mp4,
 * whose index makes the seek exact (MPEG-TS seeking is not). A stream copy
 * keeps the frames back to the previous keyframe behind an edit list; a
 * re-encode drops them. Pure. */
export function buildReplayCutArgs(
  input: string,
  output: string,
  opts: { startSec: number; reencode?: boolean; quality?: Quality; audio?: boolean },
): string[] {
  const codec = opts.reencode
    ? [...resolveQuality(opts.quality ?? "standard"), ...(opts.audio ? ["-c:a", "aac", "-b:a", "160k"] : [])]
    : ["-c", "copy"];
  return [
    "-y", "-v", "error",
    "-ss", String(round3(Math.max(0, opts.startSec))),
    "-i", input,
    ...codec,
    "-movflags", "+faststart",
    output,
  ];
}

/** Events between `from` and `to` (recording seconds), re-timed to start at
 * 0 with the clip. Pure. */
export function sliceEvents(events: InputEvent[], from: number, to: number): InputEvent[] {
  return selectEvents(events, { from, to }).map((e) => ({ ...e, t: round3(e.t - from) }));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Copy a file another process may still be writing. fs.copyFile (CopyFileW
 * on Windows) refuses a file open for writing; a plain read shares it. */
function copyShared(src: string, dst: string): number {
  const fd = openSync(src, "r");
  try {
    const size = statSync(src).size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    writeFileSync(dst, buf.subarray(0, read));
    return read;
  } finally {
    closeSync(fd);
  }
}

async function probeStart(ffprobe: string, path: string, signal?: AbortSignal): Promise<number | null> {
  const res = await runCapture(ffprobe, ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", path], 15_000, { signal });
  const n = Number.parseFloat(res.stdout.trim());
  return res.code === 0 && Number.isFinite(n) ? n : null;
}

export interface SaveReplayOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Seconds to keep, counted back from the newest footage. */
  lastSec: number;
  output: string;
  /** Frame-exact re-encode instead of a stream copy (default false). */
  reencode?: boolean;
  quality?: Quality;
  /** Also use the segment ffmpeg is still writing (default true; a stopped
   * buffer has none). */
  live?: boolean;
  signal?: AbortSignal;
}

export interface SaveReplayResult {
  outputPath: string;
  durationSec: number;
  /** The clip's span on the recording's own clock, in seconds. */
  fromSec: number;
  toSec: number;
  segments: number;
  /** True when the in-progress segment was included (the clip runs to now). */
  includesLive: boolean;
  eventsPath?: string;
  events?: Record<string, number>;
}

/** Write the last `lastSec` of a replay buffer to `output`. The buffer keeps
 * running. Throws a ScreencastError when there is no footage yet. */
export async function saveReplay(buf: ReplayBuffer, opts: SaveReplayOptions): Promise<SaveReplayResult> {
  if (!existsSync(buf.dir)) {
    throw new ScreencastError("This replay buffer has been discarded: its segments are gone.");
  }
  const listPath = segmentListPath(buf.dir);
  const entries = existsSync(listPath) ? parseSegmentList(readFileSync(listPath, "utf8")) : [];
  const picked = pickSegments(entries, opts.lastSec);
  // Snapshot first: copying takes milliseconds, while ffmpeg may reopen the
  // oldest ring slot within a couple of seconds.
  const snap = mkdtempSync(join(buf.dir, "save-"));
  try {
    const files = picked.map((e, i) => {
      const dst = join(snap, `${String(i).padStart(5, "0")}.ts`);
      copyShared(join(buf.dir, e.file), dst);
      return dst;
    });
    let includesLive = false;
    if (opts.live !== false) {
      const src = join(buf.dir, liveSegmentFile(entries, buf.wrap));
      const dst = join(snap, "live.ts");
      if (existsSync(src) && copyShared(src, dst) > 0) {
        // A ring slot still holding a lap-old segment (ffmpeg has not reopened
        // it yet) starts before the newest completed one: leave it out.
        const newest = files.at(-1);
        const [liveStart, lastStart] = await Promise.all([
          probeStart(opts.ffprobe, dst, opts.signal),
          newest ? probeStart(opts.ffprobe, newest, opts.signal) : Promise.resolve(-Infinity),
        ]);
        if (liveStart !== null && lastStart !== null && liveStart > lastStart) {
          files.push(dst);
          includesLive = true;
        }
      }
    }
    if (files.length === 0) {
      throw new ScreencastError(
        "The replay buffer has no footage yet: the first segment is still being written. Try again in a couple of seconds.",
      );
    }
    const listFile = join(snap, "join.txt");
    writeFileSync(listFile, concatList(files));
    const joined = join(snap, "joined.mp4");
    const timeout = jobTimeoutMs(opts.lastSec + 2 * buf.segmentSec);
    const join1 = await runCapture(opts.ffmpeg, buildReplayJoinArgs(listFile, joined), timeout, { signal: opts.signal });
    if (join1.code !== 0) {
      throw new ScreencastError(`Joining the replay segments failed:\n${join1.stderr.trim().split("\n").slice(-4).join("\n")}`);
    }
    const probe = await runCapture(opts.ffprobe, buildProbeArgs(joined), 30_000, { signal: opts.signal });
    const info = probe.code === 0 ? parseMediaInfo(JSON.parse(probe.stdout)) : null;
    const total = info?.durationSec ?? null;
    if (!total || !(total > 0)) throw new ScreencastError("The joined replay has no duration; the segments may be damaged.");
    const startSec = Math.max(0, total - opts.lastSec);
    const cut = await runCapture(
      opts.ffmpeg,
      buildReplayCutArgs(joined, opts.output, {
        startSec,
        reencode: opts.reencode,
        quality: opts.quality,
        audio: !!info?.audioCodec,
      }),
      timeout,
      { signal: opts.signal },
    );
    if (cut.code !== 0) {
      throw new ScreencastError(`Writing the replay failed:\n${cut.stderr.trim().split("\n").slice(-4).join("\n")}`);
    }
    // The first file's place on the recording clock: its list entry, or (for
    // a live-only save) the end of the newest completed segment.
    const origin = picked[0]?.start ?? entries.at(-1)?.end ?? 0;
    const fromSec = round3(origin + startSec);
    const toSec = round3(origin + total);
    const result: SaveReplayResult = {
      outputPath: opts.output,
      durationSec: round3(total - startSec),
      fromSec,
      toSec,
      segments: files.length,
      includesLive,
    };
    if (buf.events) {
      const raw = existsSync(buf.events.raw) ? readFileSync(buf.events.raw, "utf8") : "";
      const events = sliceEvents(
        convertEvents(raw, { startMs: buf.events.startMs, frame: buf.events.frame }),
        fromSec,
        toSec,
      );
      const { jsonl } = eventPaths(opts.output);
      writeFileSync(jsonl, formatEventsJsonl(events));
      result.eventsPath = jsonl;
      result.events = summarizeEvents(events);
    }
    return result;
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }
}

/** Create a buffer's directory (fresh). */
export function prepareReplayDir(buf: ReplayBuffer): void {
  mkdirSync(buf.dir, { recursive: true });
}

/** Delete a buffer's segments. Never throws. */
export function discardReplay(buf: Pick<ReplayBuffer, "dir">): boolean {
  try {
    rmSync(buf.dir, { recursive: true, force: true });
    return !existsSync(buf.dir);
  } catch {
    return false;
  }
}

/** Disk a buffer's segments use now, in bytes. */
export function replayDiskBytes(buf: Pick<ReplayBuffer, "dir">): number {
  let total = 0;
  try {
    for (const name of readdirSync(buf.dir)) {
      try {
        const st = statSync(join(buf.dir, name));
        if (st.isFile()) total += st.size;
      } catch {
        /* rotated away meanwhile */
      }
    }
  } catch {
    /* gone */
  }
  return total;
}

/**
 * Remove replay buffers no live recording owns: left by a crash, a stop whose
 * save failed, or a session that ended on its own. Runs at server start;
 * `keep` holds the directories of sessions still recording. Returns how many
 * were removed. Only buf-* directories are touched.
 */
export function cleanupReplayDirs(keep: Iterable<string>, root: string = replayRoot()): number {
  const keepSet = new Set([...keep].map((d) => d.toLowerCase()));
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = join(root, name);
    if (!DIR_NAME.test(name) || keepSet.has(dir.toLowerCase())) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      /* locked: try again next start */
    }
  }
  return removed;
}

/** What stopping a replay session did with its buffer. */
export interface ReplayStopResult {
  saved: boolean;
  discarded: boolean;
  save?: SaveReplayResult;
  error?: string;
}

/**
 * Finish a stopped replay session's buffer: with `save`, write the whole
 * buffer to `output` first. The buffer is discarded unless a requested save
 * failed (it is kept so the caller can retry). Never throws.
 */
export async function finishReplay(
  buf: ReplayBuffer,
  opts: { save: boolean; output: string; quality?: Quality; tools?: () => { ffmpeg: string; ffprobe: string } },
): Promise<ReplayStopResult> {
  if (!opts.save) return { saved: false, discarded: discardReplay(buf) };
  try {
    const tools = opts.tools?.();
    if (!tools) throw new ScreencastError("ffmpeg is not available to save the replay buffer.");
    const save = await saveReplay(buf, { ...tools, lastSec: buf.bufferSec, output: opts.output, quality: opts.quality, live: false });
    return { saved: true, discarded: discardReplay(buf), save };
  } catch (err) {
    return { saved: false, discarded: false, error: err instanceof Error ? err.message : String(err) };
  }
}
