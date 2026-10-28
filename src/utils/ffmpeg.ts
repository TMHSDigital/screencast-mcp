/**
 * ffmpeg / ffprobe discovery and invocation.
 *
 * ffmpeg and ffprobe are EXTERNAL dependencies. They are detected on PATH (or
 * via the FFMPEG_PATH / FFPROBE_PATH env overrides) and a missing binary
 * produces a clear ScreencastError with an install hint, rather than a cryptic
 * spawn failure deep inside a tool call.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreencastError } from "./errors.js";
import { buildProbeArgs, parseMediaInfo, type MediaInfo } from "./media.js";
import { logFfmpegWarnings } from "./logging.js";

const INSTALL_HINT =
  "ffmpeg and ffprobe must be installed and on PATH (or set FFMPEG_PATH / " +
  "FFPROBE_PATH). Windows: `winget install Gyan.FFmpeg` or `choco install " +
  "ffmpeg`. macOS: `brew install ffmpeg`. Linux: `apt install ffmpeg`.";

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

function resolveBinary(envVar: string, fallback: string): string {
  const override = process.env[envVar];
  return override && override.trim().length > 0 ? override : fallback;
}

/** Return true if `bin -version` runs and exits 0. */
export function binaryWorks(bin: string): boolean {
  try {
    const res = spawnSync(bin, ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detect ffmpeg + ffprobe. Returns the resolved binary names/paths, or throws a
 * ScreencastError with an install hint naming whichever binary is missing.
 */
export function detectFfmpeg(): FfmpegTools {
  const ffmpeg = resolveBinary("FFMPEG_PATH", "ffmpeg");
  const ffprobe = resolveBinary("FFPROBE_PATH", "ffprobe");
  const missing: string[] = [];
  if (!binaryWorks(ffmpeg)) missing.push("ffmpeg");
  if (!binaryWorks(ffprobe)) missing.push("ffprobe");
  if (missing.length > 0) {
    throw new ScreencastError(
      `Required ${missing.join(" and ")} not found on PATH.`,
      INSTALL_HINT,
    );
  }
  return { ffmpeg, ffprobe };
}

let cached: FfmpegTools | null = null;

/** Cached variant for per-call guards. Re-detects only after a failure. */
export function requireFfmpeg(): FfmpegTools {
  if (cached) return cached;
  cached = detectFfmpeg();
  return cached;
}

let wgc: boolean | null = null;

/** True when this ffmpeg has the gfxcapture source (Windows Graphics Capture,
 * FFmpeg 8+ on Windows). Probed once. */
export function wgcAvailable(): boolean {
  if (wgc !== null) return wgc;
  if (process.platform !== "win32") return (wgc = false);
  try {
    const res = spawnSync(requireFfmpeg().ffmpeg, ["-hide_banner", "-h", "filter=gfxcapture"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    wgc = /gfxcapture AVOptions/.test(res.stdout ?? "");
  } catch {
    wgc = false;
  }
  return wgc;
}

const filterCache = new Map<string, boolean>();

/** True when this ffmpeg build has the named filter (e.g. whisper needs
 * --enable-whisper, subtitles needs libass). Probed once per name. */
export function hasFilter(name: string): boolean {
  const cached = filterCache.get(name);
  if (cached !== undefined) return cached;
  let found: boolean;
  try {
    const res = spawnSync(requireFfmpeg().ffmpeg, ["-hide_banner", "-h", `filter=${name}`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    found = new RegExp(`^Filter ${name}\\b`, "m").test(res.stdout ?? "");
  } catch {
    found = false;
  }
  filterCache.set(name, found);
  return found;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCaptureOptions {
  /**
   * End the child's stdin immediately. dshow device enumeration
   * (`-list_devices`) can block waiting on stdin on some setups; closing it
   * removes that hang as a cause. Safe only for jobs that do not read stdin
   * (which is every short job that goes through runCapture).
   */
  closeStdin?: boolean;
  /** Called with each stdout chunk as it arrives (e.g. `-progress pipe:1`). */
  onStdout?: (chunk: string) => void;
  /** Kill the child and reject when this signal aborts (a cancelled request). */
  signal?: AbortSignal;
}

/** Run a binary to completion, capturing stdout/stderr. Used for ffprobe and
 * short ffmpeg edit jobs (not for long-running captures). */
export function runCapture(
  bin: string,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
  opts: RunCaptureOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    if (opts.closeStdin) child.stdin?.end();
    let stdout = "";
    let stderr = "";
    // On a timeout or cancel, settle only once the child has actually exited:
    // on Windows a file the dying process still holds open cannot be deleted
    // yet, so a caller cleaning up its output would hit EPERM. A short grace
    // timer still settles if 'close' never arrives.
    let killError: ScreencastError | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    const kill = (error: ScreencastError) => {
      if (killError) return;
      killError = error;
      child.kill("SIGKILL");
      graceTimer = setTimeout(() => reject(error), 5_000);
    };
    const onAbort = () => kill(new ScreencastError(`${bin} was cancelled.`));
    const timer = setTimeout(
      () => kill(new ScreencastError(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (killError) reject(killError);
      else resolve({ code, stdout, stderr });
    });
  });
}

/** Filter options ffmpeg can also read from a file as `-/option path`. */
const SCRIPTABLE_OPTS = new Set(["-vf", "-af", "-filter_complex", "-lavfi", "-filter:v", "-filter:a"]);
/** Filter values longer than this go to a file. Windows caps a whole command
 * line at 32,767 characters, so a long zoom or cut graph cannot go inline (#225). */
export const MAX_INLINE_FILTER = 8_000;

/** Move long filter values into temp files read with ffmpeg's `-/option file`
 * syntax (FFmpeg 7+). Returns the new args and a cleanup that deletes the files. */
export function scriptLongFilters(args: string[]): { args: string[]; cleanup: () => void } {
  let dir: string | null = null;
  const out = args.map((a, i) => (i > 0 && SCRIPTABLE_OPTS.has(args[i - 1]) && a.length > MAX_INLINE_FILTER ? null : a));
  for (let i = 1; i < args.length; i++) {
    if (out[i] !== null) continue;
    dir ??= mkdtempSync(join(tmpdir(), "screencast-filter-"));
    const file = join(dir, `filter${i}.txt`);
    writeFileSync(file, args[i]);
    out[i - 1] = `-/${args[i - 1].slice(1)}`;
    out[i] = file;
  }
  const d = dir;
  return { args: out as string[], cleanup: () => d && rmSync(d, { recursive: true, force: true }) };
}

/** Options for runFfmpegBuffer / runFfmpegFrames. */
export type StreamOptions = Pick<RunCaptureOptions, "signal">;

/** Run ffmpeg and return its stdout as raw bytes (e.g. `-f rawvideo -`), which
 * runCapture's text decoding would corrupt. Rejects on a non-zero exit. */
export async function runFfmpegBuffer(args: string[], timeoutMs = 30_000, opts: StreamOptions = {}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await streamFfmpeg(args, timeoutMs, (d) => chunks.push(d), opts);
  return Buffer.concat(chunks);
}

/** Run ffmpeg writing raw fixed-size frames to stdout (`-f rawvideo -`) and
 * call `onFrame` with each one as it arrives, so memory stays bounded however
 * long the input is (#241). Each frame is a fresh buffer the callback may keep.
 * A trailing partial frame is dropped. Rejects on a non-zero exit. */
export async function runFfmpegFrames(
  args: string[],
  frameBytes: number,
  onFrame: (frame: Buffer) => void,
  timeoutMs = 30_000,
  opts: StreamOptions = {},
): Promise<number> {
  if (!(frameBytes > 0)) throw new ScreencastError("frameBytes must be positive.");
  let pending: Buffer = Buffer.alloc(0);
  let count = 0;
  await streamFfmpeg(args, timeoutMs, (d) => {
    pending = pending.length ? Buffer.concat([pending, d]) : d;
    let o = 0;
    for (; o + frameBytes <= pending.length; o += frameBytes) {
      onFrame(Buffer.from(pending.subarray(o, o + frameBytes)));
      count++;
    }
    pending = pending.subarray(o);
  }, opts);
  return count;
}

function streamFfmpeg(
  rawArgs: string[],
  timeoutMs: number,
  onData: (d: Buffer) => void,
  opts: StreamOptions,
): Promise<void> {
  const { ffmpeg } = requireFfmpeg();
  const { args, cleanup } = scriptLongFilters(rawArgs);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    // As in runCapture: on a timeout, cancel, or onData error, settle only once
    // the child has exited, with a grace timer in case 'close' never arrives.
    let killError: unknown = null;
    let graceTimer: NodeJS.Timeout | undefined;
    const kill = (error: unknown) => {
      if (killError) return;
      killError = error;
      child.kill("SIGKILL");
      graceTimer = setTimeout(() => reject(error), 5_000);
    };
    const onAbort = () => kill(new ScreencastError("ffmpeg was cancelled."));
    const timer = setTimeout(
      () => kill(new ScreencastError(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs,
    );
    const settle = () => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => {
      if (killError) return;
      try {
        onData(d);
      } catch (error) {
        kill(error);
      }
    });
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      settle();
      reject(err);
    });
    child.on("close", (code) => {
      settle();
      if (killError) reject(killError);
      else if (code === 0) resolve();
      else reject(new ScreencastError(`ffmpeg failed (exit ${code}):\n${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
  }).finally(cleanup);
}

/** Run an ffmpeg edit job and reject with the tail of stderr on non-zero exit. */
export async function runFfmpeg(
  args: string[],
  timeoutMs?: number,
  opts: RunCaptureOptions = {},
): Promise<void> {
  const { ffmpeg } = requireFfmpeg();
  const scripted = scriptLongFilters(args);
  try {
    const res = await runCapture(ffmpeg, scripted.args, timeoutMs, opts);
    if (res.code !== 0) {
      const tail = res.stderr.trim().split("\n").slice(-6).join("\n");
      throw new ScreencastError(`ffmpeg failed (exit ${res.code}):\n${tail}`);
    }
    // A job that succeeds can still warn (a dropped frame, a guessed layout);
    // the client sees that as a log message rather than nothing (#222).
    logFfmpegWarnings(res.stderr);
  } finally {
    scripted.cleanup();
  }
}

/** Probe a media file with ffprobe and return its flattened MediaInfo. Shared by
 * tools that need source dimensions or stream presence before building an edit. */
export async function probeMedia(input: string): Promise<MediaInfo> {
  const { ffprobe } = requireFfmpeg();
  const res = await runCapture(ffprobe, buildProbeArgs(input), 30_000);
  if (res.code !== 0) {
    throw new ScreencastError(
      `ffprobe failed (exit ${res.code}): ${res.stderr.trim().slice(-400)}`,
    );
  }
  return parseMediaInfo(JSON.parse(res.stdout));
}
