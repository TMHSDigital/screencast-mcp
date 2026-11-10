/**
 * stop_recording's force-kill and cross-restart branches (#299), with the
 * pid checks mocked so no real process is touched, plus the real Windows
 * image check behind the pid-reuse guard.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

const pids = vi.hoisted(() => ({
  alive: new Set<number>(),
  /** Pids that survive killPid. */
  stubborn: new Set<number>(),
  /** When set, a pid counts as alive only until this file exists. */
  stopFile: null as string | null,
  own: true,
  killed: [] as number[],
}));
vi.mock("../utils/sessions.js", async (orig) => {
  const real = await orig<typeof import("../utils/sessions.js")>();
  const { existsSync: exists } = await import("node:fs");
  return {
    ...real,
    isAlive: (pid: number | null) =>
      pid !== null && pids.alive.has(pid) && !(pids.stopFile !== null && exists(pids.stopFile)),
    isOwnRecorder: () => pids.own,
    killPid: (pid: number) => {
      pids.killed.push(pid);
      if (!pids.stubborn.has(pid)) pids.alive.delete(pid);
    },
  };
});

import { SessionStore, isRecorderProcess, type SessionRecord } from "../utils/sessions.js";
import { stopSession } from "../utils/lifecycle.js";
import { wgcStopFile } from "../utils/wgc.js";

/** A child that never answers 'q'. */
function deafChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: string | null;
    written: string[];
    stdin: { writable: boolean; write: (d: string) => void; end: () => void };
  };
  child.exitCode = null;
  child.signalCode = null;
  child.written = [];
  child.stdin = {
    writable: true,
    write: (d: string) => void child.written.push(d),
    end: () => {
      child.stdin.writable = false;
    },
  };
  return child;
}

let dir: string;
const stores: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-stop-"));
  pids.alive.clear();
  pids.stubborn.clear();
  pids.stopFile = null;
  pids.own = true;
  pids.killed.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const p of stores) rmSync(p, { force: true });
  stores.length = 0;
});

function newStore(): SessionStore {
  const p = join(tmpdir(), `sc-stop-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  stores.push(p);
  const store = new SessionStore(p);
  store.load();
  return store;
}

const PID = 424242;
function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: `stop-${Math.random().toString(36).slice(2, 8)}`,
    target: "full",
    outputPath: join(dir, "out.mp4"),
    fps: 30,
    quality: "standard",
    pid: PID,
    status: "recording",
    startedAt: new Date().toISOString(),
    ...over,
  };
}

const opts = { reason: "stopped" as const, probe: async () => 3, gracefulMs: 50 };

describe("stop force-kill (#299)", () => {
  it("kills a child that ignores 'q' and reports a non-graceful stop", async () => {
    const store = newStore();
    const rec = record();
    store.create(rec);
    pids.alive.add(PID);
    const child = deafChild();
    store.attachChild(rec.id, child as unknown as ChildProcess);

    const res = await stopSession(store, rec, opts);

    expect(child.written).toEqual(["q\n"]);
    expect(pids.killed).toEqual([PID]);
    expect(res.graceful).toBe(false);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped", endReason: "stopped" });
  });

  it("throws when the pid survives the kill, and clears the stopping flag", async () => {
    const store = newStore();
    const rec = record();
    store.create(rec);
    pids.alive.add(PID);
    pids.stubborn.add(PID);
    store.attachChild(rec.id, deafChild() as unknown as ChildProcess);

    await expect(stopSession(store, rec, opts)).rejects.toThrow(`its process (pid ${PID}) is still running`);
    expect(store.get(rec.id)?.status).toBe("recording");
    expect(store.isStopping(rec.id)).toBe(false);
  });
});

describe("cross-restart stop (#299)", () => {
  it("never kills a live pid that is not its recorder, and still finalizes", async () => {
    const store = newStore();
    const rec = record();
    store.create(rec);
    pids.alive.add(PID);
    pids.own = false;

    const res = await stopSession(store, rec, opts);

    expect(pids.killed).toEqual([]);
    expect(pids.alive.has(PID)).toBe(true);
    expect(res.graceful).toBe(false);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped", endReason: "stopped" });
  });

  it("kills its own ffmpeg recorder by pid", async () => {
    const store = newStore();
    const rec = record();
    store.create(rec);
    pids.alive.add(PID);

    await stopSession(store, rec, opts);

    expect(pids.killed).toEqual([PID]);
    expect(store.get(rec.id)?.status).toBe("stopped");
  });

  it("stops the wgc recorder with its stop file, gracefully, without a kill", async () => {
    const store = newStore();
    const rec = record({ backend: "wgc" });
    store.create(rec);
    pids.alive.add(PID);
    pids.stopFile = wgcStopFile(rec.outputPath);

    const res = await stopSession(store, rec, opts);

    // The pid only reads as gone once the stop file was written; the stop
    // removes the file afterwards.
    expect(existsSync(pids.stopFile)).toBe(false);
    expect(pids.killed).toEqual([]);
    expect(res.graceful).toBe(true);
    expect(store.get(rec.id)?.status).toBe("stopped");
  });

  it("throws when its own recorder survives the kill", async () => {
    const store = newStore();
    const rec = record();
    store.create(rec);
    pids.alive.add(PID);
    pids.stubborn.add(PID);

    await expect(stopSession(store, rec, opts)).rejects.toThrow(/is still running/);
    expect(store.isStopping(rec.id)).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")("isRecorderProcess on Windows (#299)", () => {
  it("matches a pid's real image only", () => {
    const image = process.execPath.split(/[\\/]/).pop()!; // node.exe
    expect(isRecorderProcess(process.pid, image)).toBe(true);
    expect(isRecorderProcess(process.pid, "ffmpeg.exe")).toBe(false);
    expect(isRecorderProcess(null, image)).toBe(false);
  });
});
