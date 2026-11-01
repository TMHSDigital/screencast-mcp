/**
 * Recording stop sequence, shared by stop_recording and server shutdown.
 *
 * Graceful first: ffmpeg quits cleanly (and finalizes the mp4) on 'q' over
 * stdin. If it does not exit in time, or the live handle was lost (a
 * cross-restart stop), the process is terminated by pid; the fragmented-mp4
 * muxing keeps a killed recording playable either way.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { requireFfmpeg, runCapture } from "./ffmpeg.js";
import { finishReplay, type ReplayStopResult } from "./replay.js";
import { whenFinalized } from "./events.js";
import { buildProbeArgs, parseMediaInfo } from "./media.js";
import { ScreencastError } from "./errors.js";
import { wgcStopFile } from "./wgc.js";
import { encoderArgs } from "./gpu.js";
import {
  clearPausing,
  endSession,
  finishSegments,
  markPausing,
  pauseBlocker,
  recordedSec,
  segmentDurationSec,
  webcamOutputPath,
  type SegmentPart,
} from "./pause.js";
import {
  expectedImage,
  isAlive,
  isRecorderProcess,
  killPid,
  type EndReason,
  type SessionRecord,
  type SessionStore,
} from "./sessions.js";

/** Poll until a pid is gone (process fully exited, file handles released). */
async function waitForPidExit(pid: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Wait up to ms for a child to exit; resolve true if it did. */
export function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Probe a finished file's duration, or null if it is missing/unreadable. */
export async function probeDuration(ffprobe: string, path: string): Promise<number | null> {
  if (!existsSync(path)) return null;
  try {
    const res = await runCapture(ffprobe, buildProbeArgs(path), 30_000);
    if (res.code !== 0) return null;
    return parseMediaInfo(JSON.parse(res.stdout)).durationSec;
  } catch {
    return null;
  }
}

export interface StopOptions {
  /** Recorded on the session; "stopped" for stop_recording, "shutdown" on exit. */
  reason: Extract<EndReason, "stopped" | "shutdown">;
  /** Resolves the final duration; injected so tests need no ffprobe. */
  probe: (path: string) => Promise<number | null>;
  /** How long to wait for a graceful 'q' before killing (default 8s). */
  gracefulMs?: number;
  /** Replay-buffer sessions (#197): write the whole buffer to outputPath
   * before discarding it (default false: discard). */
  saveReplay?: boolean;
}

export interface StopResult {
  record: SessionRecord | undefined;
  graceful: boolean;
  durationSec: number | null;
  /** What happened to a replay session's buffer (#197). */
  replay?: ReplayStopResult;
  /** Segments joined after pauses (#200), and a join error. */
  segments?: { count: number; error?: string };
}

/** Quit a capture child gracefully ('q'), killing it if it does not exit in
 * time. Resolves whether it quit on its own. */
async function quitChild(child: ChildProcess, pid: number | null, gracefulMs: number): Promise<boolean> {
  if (!child.stdin || !child.stdin.writable) return false;
  child.stdin.write("q\n");
  child.stdin.end();
  const graceful = await waitForExit(child, gracefulMs);
  if (!graceful && pid !== null) {
    killPid(pid);
    await waitForPidExit(pid, 2000);
    await waitForExit(child, 2000);
  }
  return graceful;
}

/** The finished parts of a session, the running one included (its length
 * probed now that it has exited). */
export async function finalParts(record: SessionRecord, ffprobe: string): Promise<SegmentPart[]> {
  const seg = record.segments;
  if (!seg) return [];
  const parts = [...seg.parts];
  if (seg.current) {
    // A failed probe does not drop footage: the span stands in (#252).
    const probed = await probeDuration(ffprobe, seg.current.path);
    const endMs = record.stoppedAt ? Date.parse(record.stoppedAt) : Date.now();
    const durationSec = segmentDurationSec(seg.current.path, probed, seg.current.startMs, endMs) ?? 0;
    parts.push({ ...seg.current, durationSec });
  }
  return parts;
}

/** True when a segmented session needs joining or a webcam aligned at stop. */
export function needsJoin(record: SessionRecord): boolean {
  const seg = record.segments;
  return !!seg && (seg.parts.length > 0 || !!record.webcam);
}

/** Join a segmented recording and align its webcam (#200); returns the
 * record update and a join error. */
export async function joinSegments(
  record: SessionRecord,
  tools: { ffmpeg: string; ffprobe: string },
): Promise<{ patch: Partial<SessionRecord>; count: number; error?: string }> {
  const parts = await finalParts(record, tools.ffprobe);
  const res = await finishSegments(record.outputPath, parts, {
    ffmpeg: tools.ffmpeg,
    webcamOutput: record.webcam ? webcamOutputPath(record.outputPath) : undefined,
    webcamCodec: encoderArgs(record.encoder ?? "x264", record.quality, { gpuFrames: false }),
  });
  return {
    patch: {
      segments: { parts },
      ...(record.webcam ? { webcam: { ...record.webcam, error: res.webcamError } } : {}),
    },
    count: parts.length,
    error: res.error,
  };
}

/** What a session operation is doing. */
export type SessionOpKind = "pause" | "resume" | "stop";

/** Pause, resume and stop in flight, per store and session id (#252). One
 * operation runs at a time per session: a second call of the same kind (an
 * agent retry) joins the running one; a stop waits for a running pause or
 * resume and then stops whatever state it left; a pause or resume that
 * collides with a different operation is rejected. Without this, overlapping
 * calls spawned a second capture over the first, or force-killed a segment
 * that was still finalizing (#181, #252). */
const sessionOps = new WeakMap<SessionStore, Map<string, { kind: SessionOpKind; promise: Promise<unknown> }>>();

/** The operation running on a session, if any. */
export function sessionOpInFlight(store: SessionStore, id: string): SessionOpKind | null {
  return sessionOps.get(store)?.get(id)?.kind ?? null;
}

/**
 * Run `fn` as the session's one operation. `queue` (stop) waits for a
 * different operation in flight instead of rejecting; `fn` is told whether it
 * waited, so it can re-read the record the other operation changed.
 */
export function withSessionOp<T>(
  store: SessionStore,
  id: string,
  kind: SessionOpKind,
  fn: (waited: boolean) => Promise<T>,
  opts: { queue?: boolean } = {},
): Promise<T> {
  let ops = sessionOps.get(store);
  if (!ops) sessionOps.set(store, (ops = new Map()));
  const running = ops.get(id);
  if (running?.kind === kind) return running.promise as Promise<T>;
  if (running && !opts.queue) {
    return Promise.reject(
      new ScreencastError(
        `Cannot ${kind} ${id}: a ${running.kind} of it is in progress.`,
        "Retry once it finishes (get_recording shows the session's status).",
      ),
    );
  }
  let start: Promise<T>;
  if (running) {
    start = running.promise.then(
      () => fn(true),
      () => fn(true),
    );
  } else {
    try {
      start = fn(false);
    } catch (err) {
      start = Promise.reject(err);
    }
  }
  const map = ops;
  const op: Promise<T> = start.finally(() => {
    if (map.get(id)?.promise === op) map.delete(id);
  });
  map.set(id, { kind, promise: op });
  return op;
}

/**
 * Pause a recording (#200): quit the running segment gracefully, probe its
 * length, and park the session as "paused". The event logger keeps running;
 * the capture settings stay on the record for resume_recording. A second pause
 * while one runs joins it; one during a resume or stop is rejected (#252).
 */
export function pauseSession(
  store: SessionStore,
  record: SessionRecord,
  opts: { probe: (path: string) => Promise<number | null>; gracefulMs?: number },
): Promise<{ record: SessionRecord | undefined; recordedSec: number; segmentSec: number; graceful: boolean }> {
  return withSessionOp(store, record.id, "pause", () => runPause(store, store.get(record.id) ?? record, opts));
}

async function runPause(
  store: SessionStore,
  record: SessionRecord,
  opts: { probe: (path: string) => Promise<number | null>; gracefulMs?: number },
): Promise<{ record: SessionRecord | undefined; recordedSec: number; segmentSec: number; graceful: boolean }> {
  const child = store.getChild(record.id);
  const blocker = pauseBlocker(record, !!child);
  if (blocker) throw new ScreencastError(`Cannot pause ${record.id}: ${blocker}.`);
  markPausing(record.id);
  store.markStopping(record.id);
  try {
    const pausedAt = Date.now();
    const graceful = await quitChild(child!, record.pid, opts.gracefulMs ?? 8000);
    store.detachChild(record.id, child);
    const cur = record.segments!.current!;
    // Keep the segment unless it is missing or empty: when ffprobe fails or
    // times out, its length is estimated from when it started and the pause
    // (#252).
    const probed = await opts.probe(cur.path);
    const segmentSec = segmentDurationSec(cur.path, probed, cur.startMs, pausedAt) ?? 0;
    const parts = record.segments!.parts;
    const next = segmentSec > 0 ? [...parts, { ...cur, durationSec: segmentSec }] : parts;
    if (segmentSec <= 0 && cur.path !== record.outputPath) rmSync(cur.path, { force: true });
    store.markPaused(record.id);
    const updated = store.update(record.id, { status: "paused", pid: null, segments: { parts: next } });
    return { record: updated, recordedSec: recordedSec(next), segmentSec, graceful };
  } finally {
    clearPausing(record.id);
    store.clearStopping(record.id);
  }
}

/**
 * Stop every recording this instance owns (server shutdown, #76). Stops run in
 * parallel and the whole pass is capped at `capMs` so a wedged ffmpeg cannot
 * hold the process open; never throws. Returns the ids it attempted.
 */
export async function stopAll(
  store: SessionStore,
  probe: StopOptions["probe"],
  capMs = 10_000,
): Promise<string[]> {
  const ids = store.activeIds();
  const stops = ids.map(async (id) => {
    const record = store.get(id);
    if (!record) return;
    try {
      await stopSession(store, record, { reason: "shutdown", probe, gracefulMs: Math.min(8000, capMs) });
    } catch (err) {
      process.stderr.write(
        `Stopping ${id} on shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  await Promise.race([Promise.allSettled(stops), cap]);
  clearTimeout(timer);
  return ids;
}

/** Stop an active recording and record its final state. The caller has already
 * checked the record exists and is "recording" or "paused". A second stop of
 * the same session (an agent retry, or shutdown racing stop_recording) joins
 * the first instead of force-killing a recording that is still finalizing
 * (#181); a stop during a pause or resume waits for it, then stops the state
 * it left (#252). */
export function stopSession(
  store: SessionStore,
  record: SessionRecord,
  opts: StopOptions,
): Promise<StopResult> {
  return withSessionOp(
    store,
    record.id,
    "stop",
    async (waited) => {
      if (!waited) return runStop(store, record, opts);
      const cur = store.get(record.id) ?? record;
      if (cur.status !== "recording" && cur.status !== "paused") {
        // It ended while the other operation ran: report the final state.
        return { record: cur, graceful: true, durationSec: cur.durationSec ?? null };
      }
      return runStop(store, cur, opts);
    },
    { queue: true },
  );
}

async function runStop(
  store: SessionStore,
  record: SessionRecord,
  opts: StopOptions,
): Promise<StopResult> {
  store.markStopping(record.id);
  const stopFile = record.backend === "wgc" ? wgcStopFile(record.outputPath) : null;
  try {
    let graceful = false;
    const child = store.getChild(record.id);

    if (child && child.stdin && child.stdin.writable) {
      child.stdin.write("q\n");
      child.stdin.end();
      graceful = await waitForExit(child, opts.gracefulMs ?? 8000);
      if (!graceful && record.pid !== null) {
        killPid(record.pid);
        await waitForPidExit(record.pid, 2000);
      }
    } else if (record.pid !== null && isAlive(record.pid)) {
      // Cross-restart stop: no stdin handle. Act on the pid only while it is
      // still the recorder this record started (never a recycled, unrelated
      // process); the wgc recorder runs under node, not ffmpeg (#182).
      if (isRecorderProcess(record.pid, expectedImage(record))) {
        if (stopFile) {
          // The wgc recorder finalizes when its stop file appears.
          writeFileSync(stopFile, "");
          await waitForPidExit(record.pid, opts.gracefulMs ?? 8000);
          graceful = !isAlive(record.pid);
        }
        if (isAlive(record.pid)) {
          killPid(record.pid);
          await waitForPidExit(record.pid, 2000);
        }
        if (isAlive(record.pid)) {
          throw new ScreencastError(
            `Could not stop recording ${record.id}: its process (pid ${record.pid}) is still running.`,
          );
        }
      }
    }
    store.detachChild(record.id, child);
    // A paused session has nothing running: its last segment ended at the
    // pause, cleanly (#200).
    if (record.status === "paused") graceful = true;
    endSession(record.id);
    store.clearPaused(record.id);
    // The input event log converts once ffmpeg has exited (#118).
    await whenFinalized(record.id);
    // Segments after pauses are joined into outputPath, and a webcam lined up
    // with the recording (#200).
    let segments: StopResult["segments"];
    let segmentPatch: Partial<SessionRecord> = {};
    if (needsJoin(record)) {
      const join = await joinSegments(record, requireFfmpeg());
      segmentPatch = join.patch;
      segments = { count: join.count, ...(join.error ? { error: join.error } : {}) };
    }
    // A replay buffer is saved to outputPath on request, else discarded (#197).
    const replay = record.replay
      ? await finishReplay(record.replay, {
          save: opts.saveReplay ?? false,
          output: record.outputPath,
          quality: record.quality,
          tools: requireFfmpeg,
        })
      : undefined;

    const durationSec = await opts.probe(record.outputPath);
    const updated = store.update(record.id, {
      ...segmentPatch,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      durationSec: durationSec ?? undefined,
      endReason: opts.reason,
      // A forced kill can transiently mark the record "failed" via the crash
      // detector in start_recording; a deliberate stop is not a failure.
      error: segments?.error,
    });
    return { record: updated, graceful, durationSec, ...(replay ? { replay } : {}), ...(segments ? { segments } : {}) };
  } finally {
    if (stopFile) rmSync(stopFile, { force: true });
    store.clearStopping(record.id);
  }
}
