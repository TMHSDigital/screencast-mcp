/**
 * ffmpeg / ffprobe discovery and invocation.
 *
 * ffmpeg and ffprobe are EXTERNAL dependencies. They are detected on PATH (or
 * via the FFMPEG_PATH / FFPROBE_PATH env overrides) and a missing binary
 * produces a clear ScreencastError with an install hint, rather than a cryptic
 * spawn failure deep inside a tool call.
 */
import { spawn, spawnSync } from "node:child_process";
import { ScreencastError } from "./errors.js";

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

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a binary to completion, capturing stdout/stderr. Used for ffprobe and
 * short ffmpeg edit jobs (not for long-running captures). */
export function runCapture(
  bin: string,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new ScreencastError(
          `${bin} timed out after ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Run an ffmpeg edit job and reject with the tail of stderr on non-zero exit. */
export async function runFfmpeg(
  args: string[],
  timeoutMs?: number,
): Promise<void> {
  const { ffmpeg } = requireFfmpeg();
  const res = await runCapture(ffmpeg, args, timeoutMs);
  if (res.code !== 0) {
    const tail = res.stderr.trim().split("\n").slice(-6).join("\n");
    throw new ScreencastError(`ffmpeg failed (exit ${res.code}):\n${tail}`);
  }
}
