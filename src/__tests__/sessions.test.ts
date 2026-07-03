import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import {
  classifyOrphan,
  isAlive,
  SessionStore,
  type SessionRecord,
} from "../utils/sessions.js";

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "rec-1",
    target: "full",
    outputPath: "out.mp4",
    fps: 30,
    quality: "standard",
    pid: 12345,
    status: "recording",
    startedAt: new Date().toISOString(),
    ...over,
  };
}

describe("classifyOrphan", () => {
  it("marks a still-alive recording as an orphan to reap", () => {
    expect(classifyOrphan(record(), true)).toEqual({ status: "orphaned", reaped: true });
  });
  it("marks a dead recording as simply stopped", () => {
    expect(classifyOrphan(record(), false)).toEqual({ status: "stopped", reaped: false });
  });
  it("leaves an already-finished session unchanged", () => {
    expect(classifyOrphan(record({ status: "stopped" }), true)).toEqual({
      status: "stopped",
      reaped: false,
    });
  });
  it("leaves a recording alone when its owning server is still alive", () => {
    expect(classifyOrphan(record(), true, true)).toEqual({
      status: "recording",
      reaped: false,
    });
  });
  it("reaps a live recording whose owning server is dead", () => {
    expect(classifyOrphan(record(), true, false)).toEqual({
      status: "orphaned",
      reaped: true,
    });
  });
});

describe("isAlive", () => {
  it("recognizes the current process as alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
  it("treats invalid pids as not alive", () => {
    expect(isAlive(null)).toBe(false);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });
});

describe("SessionStore", () => {
  const paths: string[] = [];
  function newPath(): string {
    const p = join(tmpdir(), `sc-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    paths.push(p);
    return p;
  }
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p, { force: true });
    paths.length = 0;
  });

  it("creates, reads, lists, and updates sessions", () => {
    const store = new SessionStore(newPath());
    store.load();
    store.create(record({ id: "a", startedAt: "2026-01-01T00:00:00.000Z" }));
    store.create(record({ id: "b", startedAt: "2026-01-02T00:00:00.000Z" }));
    expect(store.get("a")?.id).toBe("a");
    expect(store.list().map((s) => s.id)).toEqual(["b", "a"]); // newest first
    store.update("a", { status: "stopped", durationSec: 4 });
    expect(store.get("a")?.status).toBe("stopped");
    expect(store.get("a")?.durationSec).toBe(4);
  });

  it("persists across reloads", () => {
    const p = newPath();
    const a = new SessionStore(p);
    a.load();
    a.create(record({ id: "x" }));
    const b = new SessionStore(p);
    b.load();
    expect(b.get("x")?.id).toBe("x");
  });

  it("reaps a dead recording into a stopped state at boot", () => {
    const p = newPath();
    const a = new SessionStore(p);
    a.load();
    // A pid that is essentially never alive.
    a.create(record({ id: "dead", pid: 2_000_000_000 }));
    const b = new SessionStore(p);
    b.load();
    const reaped = b.reapOrphans();
    expect(reaped).not.toContain("dead");
    expect(b.get("dead")?.status).toBe("stopped");
  });

  it("does not touch a recording owned by another still-running process", () => {
    // A real live process stands in for the other server instance.
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      const p = newPath();
      const a = new SessionStore(p);
      a.load();
      a.create(record({ id: "owned", pid: 2_000_000_000, serverPid: owner.pid }));
      const b = new SessionStore(p);
      b.load();
      expect(b.reapOrphans()).toEqual([]);
      expect(b.get("owned")?.status).toBe("recording");
    } finally {
      owner.kill();
    }
  });

  it("backs up a corrupt registry instead of silently discarding it", () => {
    const p = newPath();
    writeFileSync(p, "{ not json");
    const store = new SessionStore(p);
    store.load();
    expect(store.list()).toEqual([]);
    expect(existsSync(`${p}.bak`)).toBe(true);
    rmSync(`${p}.bak`, { force: true });
  });

  it("merges concurrently persisted records instead of clobbering them", () => {
    const p = newPath();
    const a = new SessionStore(p);
    a.load();
    const b = new SessionStore(p);
    b.load();
    a.create(record({ id: "from-a" }));
    b.create(record({ id: "from-b" }));
    const c = new SessionStore(p);
    c.load();
    expect(c.get("from-a")?.id).toBe("from-a");
    expect(c.get("from-b")?.id).toBe("from-b");
  });
});
