/**
 * The capture child's life: watching its stderr, deciding it started, and
 * classifying an exit nobody asked for. Shared by start_recording and
 * resume_recording (#200), which starts each later segment the same way.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { ScreencastError } from "./errors.js";
import { logMessage, StderrWatch } from "./logging.js";
import { parseCaptureStart, whenFinalized } from "./events.js";
import { buildCaptureArgs } from "./targets.js";
import { requireFfmpeg } from "./ffmpeg.js";
import { joinSegments, probeDuration } from "./lifecycle.js";
import {
  endSession,
  isPausing,
  partPath,
  partsDir,
  recordedSec,
  remainingCapSec,
  resumeBlocker,
  webcamPartPath,
} from "./pause.js";
import { classifyUnrequestedExit, killPid, type CaptureBackend, type SessionRecord, type SessionStore } from "./sessions.js";

export interface CaptureWatch {
  /** The first 8 KB of stderr (the input banners). */
  head(): string;
  /** The last 2 KB (the error, if it fails). */
  tail(): string;
  /** When ffmpeg announced its output (≈ the first frame for sources whose
   * banner carries no wall-clock start, like ddagrab). */
  outputAt(): number | null;
}

/** Collect a capture child's stderr and forward warnings and dropped frames
 * to the client as log messages (#222). */
export function watchStderr(child: ChildProcess, sessionId: string): CaptureWatch {
  let head = "";
  let tail = "";
  let outputAt: number | null = null;
  const watch = new StderrWatch(() => ({ sessionId }));
  child.stderr?.on("data", (d: Buffer) => {
    const text = d.toString();
    tail = (tail + text).slice(-2000);
    if (head.length < 8000) head += text;
    if (outputAt === null && /Output #0/.test(head)) outputAt = Date.now();
    watch.feed(text);
  });
  child.on("error", (err) => {
    tail += `\n${err.message}`;
  });
  return { head: () => head, tail: () => tail, outputAt: () => outputAt };
}

/** The last lines of stderr, for an error message. */
export function tailLines(watch: CaptureWatch, n = 6): string {
  return watch.tail().trim().split("\n").slice(-n).join("\n");
}

/** Wait until the capture is running or has exited. An ffmpeg capture is
 * running once it survives a moment; the wgc recorder says so when its first
 * frame is written (a repaint can take a second). */
export function settleCapture(child: ChildProcess, watch: CaptureWatch, backend: CaptureBackend): Promise<"running" | "exited"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("running"), backend === "wgc" ? 15_000 : backend === "ddagrab" ? 2000 : 1200);
    if (backend === "wgc") {
      child.stderr?.on("data", () => {
        if (parseCaptureStart(watch.head()) !== null) {
          clearTimeout(timer);
          resolve("running");
        }
      });
    }
    child.on("error", () => {
      clearTimeout(timer);
      resolve("exited");
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve("exited");
    });
  });
}

/** Epoch ms of the first frame: gdigrab's banner start; ddagrab's lavfi banner
 * starts at 0, so the moment ffmpeg opened its output stands in. */
export function captureStartMs(watch: CaptureWatch, backend: CaptureBackend, spawnedAt: number): number {
  const banner = parseCaptureStart(watch.head());
  if (banner !== null) return banner;
  return backend === "ddagrab" ? (watch.outputAt() ?? spawnedAt) : spawnedAt;
}

/**
 * Keep the record consistent when the child exits. A pause's exit is not the
 * end; any other exit ends the session (the event log converts). A deliberate
 * stop records its own final state; only an exit nobody asked for is
 * classified here: non-zero is a crash, a clean one the maxDurationSec cap or
 * the recorded window closing (#240). A segmented recording that ends on its
 * own is joined here, since no stop_recording will do it.
 */
export function attachExitHandler(
  store: SessionStore,
  id: string,
  child: ChildProcess,
  opts: { backend: CaptureBackend; maxDurationSec: number; spawnedAt: number; watch: CaptureWatch },
): void {
  child.on("exit", (code) => {
    store.detachChild(id);
    if (!isPausing(id)) endSession(id);
    const cur = store.get(id);
    if (!cur || cur.status !== "recording" || store.isStopping(id)) return;
    const verdict = classifyUnrequestedExit({
      code,
      backend: opts.backend,
      maxDurationSec: opts.maxDurationSec,
      elapsedMs: Date.now() - opts.spawnedAt,
    });
    logMessage(
      verdict.status === "failed" ? "error" : "notice",
      verdict.status === "failed"
        ? `Recording ${id} failed: the recorder exited with code ${code}.`
        : `Recording ${id} ended on its own (${verdict.endReason}).`,
      { sessionId: id, ...verdict },
    );
    store.tryUpdate(id, {
      ...verdict,
      stoppedAt: new Date().toISOString(),
      ...(verdict.status === "failed"
        ? { error: `${opts.backend === "wgc" ? "The window recorder" : "ffmpeg"} exited with code ${code}:\n${tailLines(opts.watch)}` }
        : {}),
    });
    if (cur.segments && (cur.segments.parts.length > 0 || cur.webcam)) {
      void finalizeSegments(store, cur).catch((err: unknown) => {
        process.stderr.write(`Joining ${id}'s segments failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  });
}

async function finalizeSegments(store: SessionStore, record: SessionRecord): Promise<void> {
  const tools = requireFfmpeg();
  await whenFinalized(record.id);
  const { patch, error } = await joinSegments(record, tools);
  const durationSec = await probeDuration(tools.ffprobe, record.outputPath);
  store.tryUpdate(record.id, { ...patch, durationSec: durationSec ?? undefined, ...(error ? { error } : {}) });
}

/**
 * Start the next segment of a paused recording (#200) with the settings it
 * was started with. The video clock picks up where the last segment ended.
 * On failure the session stays paused.
 */
export async function resumeSession(
  store: SessionStore,
  record: SessionRecord,
  ffmpeg: string,
): Promise<{ record: SessionRecord; recordedSec: number; capSec: number }> {
  const blocker = resumeBlocker(record, store.ownsPaused(record.id));
  if (blocker) throw new ScreencastError(`Cannot resume ${record.id}: ${blocker}.`);
  const seg = record.segments!;
  const capture = record.capture!;
  const backend: CaptureBackend = record.backend ?? "gdigrab";
  const done = recordedSec(seg.parts);
  const capSec = remainingCapSec(record.maxDurationSec, done);
  const index = seg.parts.length;
  const path = partPath(record.outputPath, index);
  const webcamPath = capture.webcam ? webcamPartPath(record.outputPath, index) : undefined;
  if (index > 0 || webcamPath) mkdirSync(partsDir(record.outputPath), { recursive: true });
  const args = buildCaptureArgs(capture.target, {
    ...capture.opts,
    output: path,
    maxDurationSec: capSec,
    ...(capture.webcam && webcamPath ? { webcam: { ...capture.webcam, output: webcamPath } } : {}),
  });
  const spawnedAt = Date.now();
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const watch = watchStderr(child, record.id);
  const cleanup = () => {
    if (index > 0) rmSync(path, { force: true });
    if (webcamPath) rmSync(webcamPath, { force: true });
  };
  if ((await settleCapture(child, watch, backend)) === "exited") {
    cleanup();
    throw new ScreencastError(`Resume failed (ffmpeg exited immediately); the recording stays paused:\n${tailLines(watch)}`);
  }
  const startMs = captureStartMs(watch, backend, spawnedAt);
  const camStart = webcamPath ? parseCaptureStart(watch.head(), capture.opts.audio ? 2 : 1) : null;
  store.attachChild(record.id, child);
  let updated: SessionRecord | undefined;
  try {
    updated = store.update(record.id, {
      status: "recording",
      pid: child.pid ?? null,
      // now - videoStartMs stays the video time across the pause (#174).
      videoStartMs: startMs - done * 1000,
      segments: {
        parts: seg.parts,
        current: { path, startMs, ...(webcamPath ? { webcamPath, ...(camStart !== null ? { webcamStartMs: camStart } : {}) } : {}) },
      },
    });
  } catch (err) {
    store.detachChild(record.id);
    if (child.pid !== undefined) killPid(child.pid);
    cleanup();
    throw new ScreencastError(`Resume stopped: the session registry could not be written (${(err as Error).message}).`);
  }
  if (!updated) {
    store.detachChild(record.id);
    if (child.pid !== undefined) killPid(child.pid);
    cleanup();
    throw new ScreencastError(`No session with id "${record.id}".`);
  }
  store.clearPaused(record.id);
  attachExitHandler(store, record.id, child, { backend, maxDurationSec: capSec, spawnedAt, watch });
  return { record: updated, recordedSec: done, capSec };
}
