/**
 * The recorder's unrequested-exit, self-end and resume failure paths (#297),
 * with fake ffmpeg children and a real (temporary) session store.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

const spawnMock = vi.hoisted(() => vi.fn());
const joinMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawn: spawnMock }));
vi.mock("../utils/ffmpeg.js", async (orig) => ({
  ...(await orig<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
  probeDuration: async () => 12.5,
}));
vi.mock("../utils/lifecycle.js", async (orig) => ({
  ...(await orig<typeof import("../utils/lifecycle.js")>()),
  joinSegments: joinMock,
}));

import { SessionStore, type SessionRecord } from "../utils/sessions.js";
import { attachExitHandler, resumeSession, settleCapture, type CaptureWatch } from "../utils/recorder.js";
import { clearPausing, markPausing, partPath, sessionEnded } from "../utils/pause.js";
import { WGC_WINDOW_CLOSED_EXIT } from "../utils/wgc.js";

type FakeChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  stderr: EventEmitter;
  stdin: { writable: boolean; write: (d: string) => void; end: () => void };
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = undefined; // kill-by-pid is a no-op
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: () => {}, end: () => {} };
  return child;
}

function exit(child: FakeChild, code: number | null): void {
  child.exitCode = code;
  child.emit("exit", code);
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;
const watch = (tail = ""): CaptureWatch => ({ head: () => "", tail: () => tail, outputAt: () => null });

let dir: string;
let n = 0;
const stores: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-recexit-"));
  spawnMock.mockReset();
  joinMock.mockReset();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const p of stores) rmSync(p, { force: true });
  stores.length = 0;
});

function newStore(): SessionStore {
  const p = join(tmpdir(), `sc-recexit-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  stores.push(p);
  const store = new SessionStore(p);
  store.load();
  return store;
}

function recording(over: Partial<SessionRecord> = {}): SessionRecord {
  const outputPath = join(dir, `rec-${++n}.mp4`);
  writeFileSync(outputPath, "fragmented mp4 bytes");
  return {
    id: `exit-${n}-${Math.random().toString(36).slice(2, 8)}`,
    target: "region:0,0,640,480",
    outputPath,
    fps: 30,
    quality: "standard",
    pid: null,
    status: "recording",
    startedAt: new Date().toISOString(),
    backend: "gdigrab",
    capture: { target: { kind: "region", x: 0, y: 0, w: 640, h: 480 }, opts: { fps: 30 } },
    ...over,
  };
}

/** A recording with an attached child and the exit handler wired. */
function running(
  store: SessionStore,
  over: Partial<SessionRecord> = {},
  opts: { backend?: "gdigrab" | "wgc"; maxDurationSec?: number; spawnedAt?: number; tail?: string } = {},
) {
  const rec = recording(over);
  store.create(rec);
  const child = fakeChild();
  store.attachChild(rec.id, asChild(child));
  attachExitHandler(store, rec.id, asChild(child), {
    backend: opts.backend ?? "gdigrab",
    maxDurationSec: opts.maxDurationSec ?? 0,
    spawnedAt: opts.spawnedAt ?? Date.now(),
    watch: watch(opts.tail),
  });
  return { rec, child };
}

const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);

describe("unrequested exits (#297)", () => {
  it("a non-zero exit while recording fails the session with the stderr tail", () => {
    const store = newStore();
    const { rec, child } = running(store, {}, { tail: "line 1\nConversion failed!" });
    exit(child, 1);
    const cur = store.get(rec.id)!;
    expect(cur).toMatchObject({ status: "failed", endReason: "crashed" });
    expect(cur.error).toMatch(/^ffmpeg exited with code 1:\n[\s\S]*Conversion failed!$/);
    expect(cur.stoppedAt).toBeDefined();
    expect(store.getChild(rec.id)).toBeUndefined();
  });

  it("a clean exit at the cap ends the session as max_duration", () => {
    const store = newStore();
    const { rec, child } = running(store, {}, { maxDurationSec: 10, spawnedAt: Date.now() - 10_000 });
    exit(child, 0);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped", endReason: "max_duration" });
    expect(store.get(rec.id)?.error).toBeUndefined();
  });

  it("the window recorder's window-closed code ends the session as window_closed", () => {
    const store = newStore();
    const { rec, child } = running(store, { backend: "wgc" }, { backend: "wgc" });
    exit(child, WGC_WINDOW_CLOSED_EXIT);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped", endReason: "window_closed" });
  });

  it("a wgc crash names the window recorder", () => {
    const store = newStore();
    const { rec, child } = running(store, { backend: "wgc" }, { backend: "wgc" });
    exit(child, 2);
    expect(store.get(rec.id)?.error).toMatch(/^The window recorder exited with code 2/);
  });

  it("leaves the record alone while a stop is in progress", () => {
    const store = newStore();
    const { rec, child } = running(store);
    store.markStopping(rec.id);
    exit(child, 1);
    expect(store.get(rec.id)).toMatchObject({ status: "recording" });
    expect(store.get(rec.id)?.endReason).toBeUndefined();
    store.clearStopping(rec.id);
  });

  it("ends the session on exit, but not on a pause's exit", async () => {
    const store = newStore();
    const a = running(store);
    exit(a.child, 0);
    expect(await settled(sessionEnded(a.rec.id))).toBe(true);

    const b = running(store);
    markPausing(b.rec.id);
    exit(b.child, 0);
    expect(await settled(sessionEnded(b.rec.id))).toBe(false);
    clearPausing(b.rec.id);
  });
});

describe("self-end of a segmented recording (#297)", () => {
  const segmented = (rec: () => SessionRecord) => {
    const base = rec();
    return { segments: { parts: [{ path: base.outputPath, startMs: 1, durationSec: 3 }], current: { path: partPath(base.outputPath, 1), startMs: Date.now() } } };
  };

  it("joins the segments and records the final duration", async () => {
    const store = newStore();
    joinMock.mockResolvedValue({ patch: { segments: { parts: [] } }, count: 2 });
    const { rec, child } = running(store, segmented(() => recording()), { maxDurationSec: 5, spawnedAt: Date.now() - 5000 });
    exit(child, 0);
    await vi.waitFor(() => expect(store.get(rec.id)?.durationSec).toBe(12.5));
    expect(joinMock).toHaveBeenCalledTimes(1);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped", endReason: "max_duration" });
  });

  it("puts a join error on the record", async () => {
    const store = newStore();
    joinMock.mockResolvedValue({ patch: {}, count: 1, error: "segment 2 could not be read" });
    const { rec, child } = running(store, segmented(() => recording()));
    exit(child, 0);
    await vi.waitFor(() => expect(store.get(rec.id)?.error).toBe("segment 2 could not be read"));
  });

  it("does not join a recording that was never paused", () => {
    const store = newStore();
    const { child } = running(store);
    exit(child, 0);
    expect(joinMock).not.toHaveBeenCalled();
  });
});

describe("settleCapture (#297)", () => {
  const BANNER = "Input #0, gdigrab, from 'desktop':\n  Duration: N/A, start: 1792936190.232363, bitrate: N/A\n";

  it("wgc: running once the start banner is printed", async () => {
    const child = fakeChild();
    let head = "";
    const w: CaptureWatch = { head: () => head, tail: () => "", outputAt: () => null };
    const p = settleCapture(asChild(child), w, "wgc");
    head = BANNER;
    child.stderr.emit("data", Buffer.from(BANNER));
    await expect(p).resolves.toBe("running");
  });

  it("exited on a spawn error or an early exit", async () => {
    const a = fakeChild();
    const pa = settleCapture(asChild(a), watch(), "wgc");
    a.emit("error", new Error("ENOENT"));
    await expect(pa).resolves.toBe("exited");

    const b = fakeChild();
    const pb = settleCapture(asChild(b), watch(), "gdigrab");
    exit(b, 1);
    await expect(pb).resolves.toBe("exited");
  });
});

describe("resume failures (#297)", () => {
  function paused(store: SessionStore): SessionRecord {
    const rec = recording();
    const r: SessionRecord = { ...rec, status: "paused", segments: { parts: [{ path: rec.outputPath, startMs: Date.now() - 10_000, durationSec: 3 }] } };
    store.create(r);
    store.markPaused(r.id);
    return r;
  }

  it("a registry write failure detaches the child and removes the new part", async () => {
    const store = newStore();
    const rec = paused(store);
    const child = fakeChild();
    spawnMock.mockImplementation(() => {
      writeFileSync(partPath(rec.outputPath, 1), "partial");
      return child;
    });
    vi.spyOn(store, "update").mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(resumeSession(store, rec, "ffmpeg")).rejects.toThrow(/registry could not be written \(disk full\)/);
    expect(store.getChild(rec.id)).toBeUndefined();
    expect(existsSync(partPath(rec.outputPath, 1))).toBe(false);
    expect(existsSync(rec.outputPath)).toBe(true);
  });

  it("a record that vanished mid-resume is reported, and the capture abandoned", async () => {
    const store = newStore();
    const rec = paused(store);
    const child = fakeChild();
    spawnMock.mockImplementation(() => child);
    vi.spyOn(store, "update").mockReturnValue(undefined);

    await expect(resumeSession(store, rec, "ffmpeg")).rejects.toThrow(`No session with id "${rec.id}".`);
    expect(store.getChild(rec.id)).toBeUndefined();
  });
});
