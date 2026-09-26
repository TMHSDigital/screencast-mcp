import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { SessionStore, type SessionRecord } from "../utils/sessions.js";
import { stopSession, stopAll } from "../utils/lifecycle.js";

/** A stand-in ffmpeg child: records what is written to stdin and, when
 * `quitsOnQ`, exits cleanly on 'q' the way ffmpeg does. */
function fakeChild(quitsOnQ: boolean) {
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
    write: (d: string) => {
      child.written.push(d);
      if (quitsOnQ && d.startsWith("q")) {
        setImmediate(() => {
          child.exitCode = 0;
          child.emit("exit", 0);
        });
      }
    },
    end: () => {
      child.stdin.writable = false;
    },
  };
  return child;
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "rec-1",
    target: "full",
    outputPath: "out.mp4",
    fps: 30,
    quality: "standard",
    pid: null, // no real process: the kill-by-pid fallback is a no-op
    status: "recording",
    startedAt: new Date().toISOString(),
    ...over,
  };
}

const paths: string[] = [];
function newStore(): SessionStore {
  const p = join(tmpdir(), `sc-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  paths.push(p);
  const store = new SessionStore(p);
  store.load();
  return store;
}
afterEach(() => {
  for (const p of paths) if (existsSync(p)) rmSync(p, { force: true });
  paths.length = 0;
});

describe("stopSession", () => {
  it("sends ffmpeg a graceful 'q' and records the stop", async () => {
    const store = newStore();
    const rec = record();
    store.create(rec);
    const child = fakeChild(true);
    store.attachChild(rec.id, child as unknown as ChildProcess);

    const res = await stopSession(store, rec, { reason: "stopped", probe: async () => 4.2 });

    expect(child.written).toEqual(["q\n"]);
    expect(res.graceful).toBe(true);
    expect(res.durationSec).toBe(4.2);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped", endReason: "stopped", durationSec: 4.2 });
    expect(store.getChild(rec.id)).toBeUndefined();
    expect(store.isStopping(rec.id)).toBe(false);
  });

  it("falls back when ffmpeg ignores 'q', and still finalizes the record", async () => {
    const store = newStore();
    const rec = record();
    store.create(rec);
    store.attachChild(rec.id, fakeChild(false) as unknown as ChildProcess);

    const res = await stopSession(store, rec, { reason: "stopped", probe: async () => null, gracefulMs: 30 });

    expect(res.graceful).toBe(false);
    expect(store.get(rec.id)).toMatchObject({ status: "stopped", endReason: "stopped" });
    expect(store.get(rec.id)?.durationSec).toBeUndefined();
  });

  it("clears a transient crash error left by the exit handler", async () => {
    const store = newStore();
    const rec = record({ error: "ffmpeg exited with code 1" });
    store.create(rec);
    store.attachChild(rec.id, fakeChild(true) as unknown as ChildProcess);
    await stopSession(store, rec, { reason: "stopped", probe: async () => 1 });
    expect(store.get(rec.id)?.error).toBeUndefined();
  });
});

describe("stopAll (#76)", () => {
  it("stops every active recording with endReason shutdown", async () => {
    const store = newStore();
    for (const id of ["a", "b"]) {
      store.create(record({ id }));
      store.attachChild(id, fakeChild(true) as unknown as ChildProcess);
    }
    store.create(record({ id: "finished", status: "stopped" }));

    const ids = await stopAll(store, async () => 2);

    expect(ids.sort()).toEqual(["a", "b"]);
    for (const id of ["a", "b"]) {
      expect(store.get(id)).toMatchObject({ status: "stopped", endReason: "shutdown" });
    }
    expect(store.get("finished")?.endReason).toBeUndefined();
  });

  it("returns within the cap even if a stop hangs", async () => {
    const store = newStore();
    store.create(record({ id: "wedged" }));
    store.attachChild("wedged", fakeChild(false) as unknown as ChildProcess);
    const never = () => new Promise<number | null>(() => {});

    const t0 = Date.now();
    await stopAll(store, never, 100);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("is a no-op with nothing active", async () => {
    expect(await stopAll(newStore(), async () => null)).toEqual([]);
  });
});
