/**
 * Recording stop sequence, shared by stop_recording and server shutdown.
 *
 * Graceful first: ffmpeg quits cleanly (and finalizes the mp4) on 'q' over
 * stdin. If it does not exit in time, or the live handle was lost (a
 * cross-restart stop), the process is terminated by pid; the fragmented-mp4
 * muxing keeps a killed recording playable either way.
 */
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { runCapture } from "./ffmpeg.js";
import { buildProbeArgs, parseMediaInfo } from "./media.js";
import {
  isAlive,
  isFfmpegProcess,
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
}

export interface StopResult {
  record: SessionRecord | undefined;
  graceful: boolean;
  durationSec: number | null;
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
 * checked the record exists and is "recording". */
export async function stopSession(
  store: SessionStore,
  record: SessionRecord,
  opts: StopOptions,
): Promise<StopResult> {
  store.markStopping(record.id);
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
      // Cross-restart stop: no stdin handle. Terminate by pid, but only if the
      // pid is still an ffmpeg (never a recycled, unrelated process).
      if (isFfmpegProcess(record.pid)) {
        killPid(record.pid);
        await waitForPidExit(record.pid, 2000);
      }
    }
    store.detachChild(record.id);

    const durationSec = await opts.probe(record.outputPath);
    const updated = store.update(record.id, {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      durationSec: durationSec ?? undefined,
      endReason: opts.reason,
      // A forced kill can transiently mark the record "failed" via the crash
      // detector in start_recording; a deliberate stop is not a failure.
      error: undefined,
    });
    return { record: updated, graceful, durationSec };
  } finally {
    store.clearStopping(record.id);
  }
}
