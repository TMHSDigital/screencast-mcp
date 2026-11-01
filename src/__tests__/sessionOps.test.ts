/**
 * Overlapping pause / resume / stop calls on one session (#252), with fake
 * ffmpeg children and a real (temporary) session store; nothing is captured.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawn: spawnMock }));
vi.mock("../utils/ffmpeg.js", async (orig) => ({
  ...(await orig<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
  runCapture: async () => ({ code: 1, stdout: "", stderr: "" }),
}));

import { SessionStore, type SessionRecord } from "../utils/sessions.js";
import { pauseSession, sessionOpInFlight, stopSession } from "../utils/lifecycle.js";
import { attachExitHandler, resumeSession, type CaptureWatch } from "../utils/recorder.js";
import { partPath, partsDir } from "../utils/pause.js";

type FakeChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  written: string[];
  stderr: EventEmitter;
  stdin: { writable: boolean; write: (d: string) => void; end: () => void };
};

/** A stand-in ffmpeg: on 'q' it exits cleanly after `quitMs`, like ffmpeg
 * writing out its last fragment. No pid, so kill-by-pid is a no-op. */
function fakeChild(quitMs = 30): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.written = [];
  child.stderr = new EventEmitter();
  child.stdin = {
    writable: true,
    write: (d: string) => {
      child.written.push(d);
      if (d.startsWith("q")) setTimeout(() => exit(child, 0), quitMs);
    },
    end: () => {
      child.stdin.writable = false;
    },
  };
  return child;
}

function exit(child: FakeChild, code: number): void {
  if (child.exitCode !== null) return;
  child.exitCode = code;
  child.emit("exit", code);
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;
const watch: CaptureWatch = { head: () => "", tail: () => "", outputAt: () => null };

let dir: string;
let n = 0;
const stores: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-ops-"));
  spawnMock.mockReset();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const p of stores) rmSync(p, { force: true });
  stores.length = 0;
});

function newStore(): SessionStore {
  const p = join(tmpdir(), `sc-ops-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  stores.push(p);
  const store = new SessionStore(p);
  store.load();
  return store;
}

/** A recording session whose first segment is a real (non-empty) file. */
function recording(over: Partial<SessionRecord> = {}): SessionRecord {
  const outputPath = join(dir, `rec-${++n}.mp4`);
  writeFileSync(outputPath, "fragmented mp4 bytes");
  return {
    id: `ops-${n}-${Math.random().toString(36).slice(2, 8)}`,
    target: "region:0,0,640,480",
    outputPath,
    fps: 30,
    quality: "standard",
    pid: null,
    status: "recording",
    startedAt: new Date().toISOString(),
    backend: "gdigrab",
    capture: { target: { kind: "region", x: 0, y: 0, w: 640, h: 480 }, opts: { fps: 30 } },
    segments: { parts: [], current: { path: outputPath, startMs: Date.now() - 5000 } },
    ...over,
  };
}

/** A session this store paused after one 3 s segment. */
function paused(store: SessionStore): SessionRecord {
  const rec = recording();
  const r: SessionRecord = {
    ...rec,
    status: "paused",
    segments: { parts: [{ path: rec.outputPath, startMs: Date.now() - 10_000, durationSec: 3 }] },
  };
  store.create(r);
  store.markPaused(r.id);
  return r;
}

describe("double resume (#252)", () => {
  it("joins the second call: one capture, one attached child", async () => {
    const store = newStore();
    const rec = paused(store);
    const child = fakeChild();
    spawnMock.mockImplementation(() => child);

    const [a, b] = await Promise.all([resumeSession(store, rec, "ffmpeg"), resumeSession(store, rec, "ffmpeg")]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(store.getChild(rec.id)).toBe(child);
    expect(store.get(rec.id)).toMatchObject({ status: "recording" });
    expect(store.get(rec.id)?.segments?.current?.path).toBe(partPath(rec.outputPath, 1));
    expect(sessionOpInFlight(store, rec.id)).toBeNull();
  });

  it("rejects a resume while a pause is running", async () => {
    const store = newStore();
    const rec = recording();
    store.create(rec);
    const child = fakeChild();
    store.attachChild(rec.id, asChild(child));

    const pause = pauseSession(store, rec, { probe: async () => 5 });
    await expect(resumeSession(store, { ...rec, status: "paused" }, "ffmpeg")).rejects.toThrow(/pause of it is in progress/);
    await pause;
    expect(spawnMock).not.toHaveBeenCalled();
    expect(store.get(rec.id)?.status).toBe("paused");
  });

  it("a failed resume does not delete a file another live capture is writing", async () => {
    const store = newStore();
    const rec = paused(store);
    const live = fakeChild();
    const target = partPath(rec.outputPath, 1);
    mkdirSync(partsDir(rec.outputPath), { recursive: true });
    writeFileSync(target, "being written");
    // Another capture already owns the session (a resume racing in from
    // somewhere the lock does not reach); the failing one must leave its file.
    store.attachChild(rec.id, asChild(live));
    const failing = fakeChild();
    spawnMock.mockImplementation(() => {
      setTimeout(() => exit(failing, 1), 5);
      return failing;
    });

    await expect(resumeSession(store, rec, "ffmpeg")).rejects.toThrow(/Resume failed/);
    expect(existsSync(target)).toBe(true);
    expect(store.getChild(rec.id)).toBe(live);
  });
});

describe("stale child exits (#252)", () => {
  it("only detaches the child that is still attached", () => {
    const store = newStore();
    const rec = recording();
    store.create(rec);
    const old = fakeChild();
    const current = fakeChild();
    store.attachChild(rec.id, asChild(old));
    attachExitHandler(store, rec.id, asChild(old), { backend: "gdigrab", maxDurationSec: 0, spawnedAt: Date.now(), watch });
    store.attachChild(rec.id, asChild(current));

    exit(old, 1);

    expect(store.getChild(rec.id)).toBe(current);
    expect(store.get(rec.id)).toMatchObject({ status: "recording" });
    store.detachChild(rec.id, asChild(old));
    expect(store.getChild(rec.id)).toBe(current);
    store.detachChild(rec.id, asChild(current));
    expect(store.getChild(rec.id)).toBeUndefined();
  });
});

describe("pause and stop together (#252)", () => {
  it("a stop during a pause waits for it, then stops the paused session without killing the segment", async () => {
    const store = newStore();
    const rec = recording();
    store.create(rec);
    const child = fakeChild(40);
    store.attachChild(rec.id, asChild(child));

    const pause = pauseSession(store, rec, { probe: async () => 4 });
    const stop = stopSession(store, rec, { reason: "stopped", probe: async () => 4 });
    const [p, s] = await Promise.all([pause, stop]);

    expect(child.written).toEqual(["q\n"]); // one graceful quit, no escalation
    expect(p.graceful).toBe(true);
    expect(s.graceful).toBe(true);
    expect(s.segments?.count).toBe(1);
    const final = store.get(rec.id)!;
    expect(final).toMatchObject({ status: "stopped", endReason: "stopped" });
    expect(final.segments?.parts).toHaveLength(1);
    expect(existsSync(rec.outputPath)).toBe(true);
    expect(store.getChild(rec.id)).toBeUndefined();
    expect(store.isStopping(rec.id)).toBe(false);
  });

  it("a pause during a stop is rejected and leaves the stop's flag alone", async () => {
    const store = newStore();
    const rec = recording();
    store.create(rec);
    const child = fakeChild(40);
    store.attachChild(rec.id, asChild(child));

    const stop = stopSession(store, rec, { reason: "stopped", probe: async () => 4 });
    await expect(pauseSession(store, rec, { probe: async () => 4 })).rejects.toThrow(/stop of it is in progress/);
    expect(store.isStopping(rec.id)).toBe(true);
    const res = await stop;

    expect(child.written).toEqual(["q\n"]);
    expect(res.graceful).toBe(true);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped" });
    expect(store.isStopping(rec.id)).toBe(false);
  });

  it("joins a second pause instead of quitting twice", async () => {
    const store = newStore();
    const rec = recording();
    store.create(rec);
    const child = fakeChild(20);
    store.attachChild(rec.id, asChild(child));

    const [a, b] = await Promise.all([
      pauseSession(store, rec, { probe: async () => 4 }),
      pauseSession(store, rec, { probe: async () => 4 }),
    ]);
    expect(a).toBe(b);
    expect(child.written).toEqual(["q\n"]);
    expect(store.get(rec.id)?.segments?.parts).toHaveLength(1);
  });
});

describe("probe failure during pause (#252)", () => {
  it("keeps a segment ffprobe could not read, timed from its start to the pause", async () => {
    const store = newStore();
    const rec = recording();
    store.create(rec);
    store.attachChild(rec.id, asChild(fakeChild()));

    const res = await pauseSession(store, rec, { probe: async () => null });

    expect(res.segmentSec).toBeGreaterThan(4.5);
    expect(res.segmentSec).toBeLessThan(10);
    const parts = store.get(rec.id)!.segments!.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.durationSec).toBe(res.segmentSec);
    expect(store.get(rec.id)?.status).toBe("paused");
  });

  it("drops (and removes) only an empty later segment", async () => {
    const store = newStore();
    const base = recording();
    const later = partPath(base.outputPath, 1);
    mkdirSync(partsDir(base.outputPath), { recursive: true });
    writeFileSync(later, "");
    const rec: SessionRecord = {
      ...base,
      segments: { parts: [{ path: base.outputPath, startMs: 1, durationSec: 2 }], current: { path: later, startMs: Date.now() - 1000 } },
    };
    store.create(rec);
    store.attachChild(rec.id, asChild(fakeChild()));

    const res = await pauseSession(store, rec, { probe: async () => null });

    expect(res.segmentSec).toBe(0);
    expect(store.get(rec.id)!.segments!.parts).toHaveLength(1);
    expect(existsSync(later)).toBe(false);
  });
});
