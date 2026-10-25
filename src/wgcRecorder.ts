/**
 * Recorder process for window recordings through Windows Graphics Capture
 * (#113). See utils/wgc.ts for why it exists. Started by start_recording as
 *
 *   node wgcRecorder.js '<WgcRecorderConfig as JSON>'
 *
 * and stopped like ffmpeg: "q" on stdin, stdin closing (the server went away),
 * the stop file appearing (a stop from another server instance, #182), or the
 * duration cap finalizes the file and exits 0. If the window closes, the
 * recording ends there too, with WGC_WINDOW_CLOSED_EXIT (#240). Every exit
 * path kills the grab, encoder and nudge children first (#208). Diagnostics go
 * to stderr; the first frame prints an ffmpeg-style "start:" banner the
 * session code reads.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  buildWgcEncodeArgs,
  buildWgcGrabArgs,
  framesDue,
  parseRawSize,
  nudgeScript,
  startBanner,
  yuv420FrameBytes,
  wgcStopFile,
  WGC_WINDOW_CLOSED_EXIT,
  type WgcRecorderConfig,
} from "./utils/wgc.js";

/** Give up if the window produces no frame at all within this long. */
const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** Skip a frame instead of queueing when the encoder is this far behind. */
const MAX_QUEUED_FRAMES = 4;

const cfg = JSON.parse(process.argv[2] ?? "{}") as WgcRecorderConfig;
const log = (s: string) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`);

const grab = spawn(cfg.ffmpeg, buildWgcGrabArgs(cfg.hwnd, cfg.fps), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
// Tiny repaints for the whole recording; see nudgeScript.
const nudge = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", nudgeScript(cfg.hwnd, 200, process.pid)], {
  stdio: "ignore",
  windowsHide: true,
});

let grabErr = "";
let size: { width: number; height: number } | null = null;
let frameBytes = 0;
let carry: Buffer = Buffer.alloc(0);
let latest: Buffer | null = null;
let encoder: ReturnType<typeof spawn> | null = null;
let startedAt = 0;
let written = 0;
let pacer: NodeJS.Timeout | null = null;
let finishing = false;
let windowClosed = false;
const stopFile = wgcStopFile(cfg.output);

function killChild(c: ChildProcess | null): void {
  if (c && c.exitCode === null && c.signalCode === null) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Kill every child, then exit: no grab, encoder or repaint loop outlives the
 * recorder on any path (#208). */
function exitWith(code: number): never {
  killChild(nudge);
  killChild(grab);
  killChild(encoder);
  rmSync(stopFile, { force: true });
  process.exit(code);
}

/** Cut whole frames off the buffered bytes; the newest becomes `latest`. Runs
 * from both handlers: the size line (stderr) and the frames (stdout) can
 * arrive in either order, and a static window may send nothing more. */
function drain(): void {
  if (!size || finishing) return;
  let off = 0;
  while (carry.length - off >= frameBytes) {
    latest = Buffer.from(carry.subarray(off, off + frameBytes));
    off += frameBytes;
  }
  if (off) carry = Buffer.from(carry.subarray(off));
  if (latest && !encoder) begin();
}

grab.stderr.on("data", (d: Buffer) => {
  if (size) return;
  grabErr = (grabErr + d.toString()).slice(-8000);
  size = parseRawSize(grabErr);
  if (size) {
    frameBytes = yuv420FrameBytes(size.width, size.height);
    drain();
  }
});

grab.stdout.on("data", (chunk: Buffer) => {
  carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  drain();
});

function begin(): void {
  encoder = spawn(cfg.ffmpeg, buildWgcEncodeArgs(size!.width, size!.height, cfg), {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  encoder.stderr?.on("data", (d: Buffer) => log(d.toString()));
  encoder.on("exit", (code) => exitWith(code === 0 && windowClosed ? WGC_WINDOW_CLOSED_EXIT : (code ?? 1)));
  encoder.stdin?.on("error", () => {
    // The encoder went away; its exit handler reports it.
  });
  startedAt = Date.now();
  log(startBanner(startedAt));
  log(`wgc: ${size!.width}x${size!.height} at ${cfg.fps} fps`);
  const tick = () => {
    const due = framesDue(Date.now() - startedAt, cfg.fps);
    while (written < due && latest && encoder?.stdin?.writable) {
      if ((encoder.stdin.writableLength ?? 0) > MAX_QUEUED_FRAMES * frameBytes) {
        written = due; // behind: drop to stay on wall-clock time
        break;
      }
      encoder.stdin.write(latest);
      written++;
    }
  };
  tick();
  pacer = setInterval(tick, Math.max(5, Math.floor(1000 / cfg.fps / 2)));
  if (cfg.maxDurationSec > 0) finishAfter(cfg.maxDurationSec * 1000);
}

/** setTimeout clamps delays past 2^31-1 ms to 1 ms, so a long cap is chained
 * in steps instead of firing at once (#184). */
function finishAfter(ms: number): void {
  const step = Math.min(ms, 2 ** 31 - 1);
  setTimeout(() => (ms > step ? finishAfter(ms - step) : finish()), step);
}

function finish(): void {
  if (finishing) return;
  finishing = true;
  if (pacer) clearInterval(pacer);
  killChild(nudge);
  killChild(grab);
  if (!encoder) {
    log("wgc: no frame was captured from the window");
    exitWith(1);
  }
  encoder.stdin?.end();
  // encoder's exit handler ends this process with its exit code.
}

grab.on("exit", () => {
  if (finishing) return;
  if (!encoder) {
    log(`wgc: capture failed: ${grabErr.split("\n").filter((l) => /error|fail|invalid/i.test(l)).slice(-3).join(" ") || "gfxcapture exited"}`);
    exitWith(1);
  }
  log("wgc: the window closed; recording ended");
  windowClosed = true;
  finish();
});

setTimeout(() => {
  if (!encoder && !finishing) {
    log(`wgc: the window produced no frame in ${FIRST_FRAME_TIMEOUT_MS / 1000}s`);
    finishing = true;
    exitWith(1);
  }
}, FIRST_FRAME_TIMEOUT_MS);

// A stop from another server instance, which has no stdin handle (#182).
rmSync(stopFile, { force: true });
setInterval(() => {
  if (existsSync(stopFile)) finish();
}, 250).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => exitWith(1));

process.stdin.on("data", (d: Buffer) => {
  if (d.toString().includes("q")) finish();
});
process.stdin.on("end", finish);
