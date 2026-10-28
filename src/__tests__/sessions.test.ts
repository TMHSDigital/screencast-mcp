import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync, readdirSync } from "node:fs";
import {
  classifyOrphan,
  isAlive,
  isForeignLiveRecording,
  isLockStale,
  LOCK_STALE_MS,
  pruneRecords,
  MAX_FINISHED_RECORDS,
  SessionStore,
  classifyUnrequestedExit,
  expectedImage,
  tasklistHasImage,
  isSameServer,
  parseProcessInfo,
  processInfo,
  serverIdentity,
  breakStaleLock,
  withRegistryLock,
  type SessionRecord,
} from "../utils/sessions.js";
import { ScreencastError } from "../utils/errors.js";
import { WGC_WINDOW_CLOSED_EXIT } from "../utils/wgc.js";

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
});

describe("isForeignLiveRecording", () => {
  it("is true for a recording owned by a different, still-live server", () => {
    expect(isForeignLiveRecording(record({ serverPid: 999 }), 1000, true)).toBe(true);
  });
  it("is false when the owning server is dead (a genuine orphan)", () => {
    expect(isForeignLiveRecording(record({ serverPid: 999 }), 1000, false)).toBe(false);
  });
  it("is false when this process is the owner", () => {
    expect(isForeignLiveRecording(record({ serverPid: 1000 }), 1000, true)).toBe(false);
  });
  it("is false for older records with no serverPid", () => {
    expect(isForeignLiveRecording(record({ serverPid: undefined }), 1000, true)).toBe(false);
  });
  it("is false for a record that is not recording", () => {
    expect(isForeignLiveRecording(record({ serverPid: 999, status: "stopped" }), 1000, true)).toBe(false);
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

describe("pruneRecords", () => {
  it("keeps every active recording and caps finished records (newest first)", () => {
    const active = [
      record({ id: "live-1", status: "recording" }),
      record({ id: "live-2", status: "recording" }),
    ];
    const finished = Array.from({ length: MAX_FINISHED_RECORDS + 25 }, (_, i) =>
      record({
        id: `done-${i}`,
        status: "stopped",
        startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }),
    );
    const pruned = pruneRecords([...finished, ...active]);
    const ids = pruned.map((r) => r.id);
    expect(ids).toContain("live-1");
    expect(ids).toContain("live-2");
    const keptFinished = pruned.filter((r) => r.status !== "recording");
    expect(keptFinished).toHaveLength(MAX_FINISHED_RECORDS);
    // Newest finished record is kept; the oldest is dropped.
    expect(ids).toContain(`done-${MAX_FINISHED_RECORDS + 24}`);
    expect(ids).not.toContain("done-0");
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

  it("activeIds lists only recording sessions with an attached child", () => {
    const store = new SessionStore(newPath());
    store.load();
    store.create(record({ id: "live" }));
    store.create(record({ id: "noHandle" }));
    store.create(record({ id: "done", status: "stopped" }));
    const fake = {} as unknown as import("node:child_process").ChildProcess;
    store.attachChild("live", fake);
    store.attachChild("done", fake);
    expect(store.activeIds()).toEqual(["live"]);
    store.detachChild("live");
    expect(store.activeIds()).toEqual([]);
  });

  it("tracks stops in flight", () => {
    const store = new SessionStore(newPath());
    expect(store.isStopping("a")).toBe(false);
    store.markStopping("a");
    expect(store.isStopping("a")).toBe(true);
    store.clearStopping("a");
    expect(store.isStopping("a")).toBe(false);
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

  it("merges with concurrent on-disk records instead of clobbering them", () => {
    const p = newPath();
    const a = new SessionStore(p);
    a.load();
    a.create(record({ id: "a" }));
    // Simulate another server instance writing its own record to the shared file.
    const onDisk = JSON.parse(readFileSync(p, "utf8")) as SessionRecord[];
    onDisk.push(record({ id: "b" }));
    writeFileSync(p, JSON.stringify(onDisk));
    // A persists again (via update); b must survive.
    a.update("a", { fps: 60 });
    const finalIds = (JSON.parse(readFileSync(p, "utf8")) as SessionRecord[]).map((r) => r.id).sort();
    expect(finalIds).toEqual(["a", "b"]);
  });

  it("does not overwrite another instance's newer record with a stale loaded copy (#55)", () => {
    const p = newPath();
    const b = new SessionStore(p);
    b.load();
    b.create(record({ id: "b-rec", status: "recording" }));
    // A boots and loads B's live recording.
    const a = new SessionStore(p);
    a.load();
    // B stops its recording after A loaded it.
    b.update("b-rec", { status: "stopped", durationSec: 9 });
    // A writes something unrelated; its stale "recording" copy must not win.
    a.create(record({ id: "a-rec" }));
    const onDisk = new Map((JSON.parse(readFileSync(p, "utf8")) as SessionRecord[]).map((r) => [r.id, r]));
    expect(onDisk.get("b-rec")?.status).toBe("stopped");
    expect(onDisk.get("b-rec")?.durationSec).toBe(9);
    expect(onDisk.get("a-rec")).toBeDefined();
    // A's in-memory view picks up B's change too.
    expect(a.get("b-rec")?.status).toBe("stopped");
  });

  it("releases its lockfile after writing, and steals a stale one (#55)", () => {
    const p = newPath();
    paths.push(`${p}.lock`);
    // A lock left by a dead process (pid 0 is never a live user process).
    writeFileSync(`${p}.lock`, JSON.stringify({ pid: 0, at: Date.now() }));
    const store = new SessionStore(p);
    store.load();
    store.create(record({ id: "x" }));
    expect(existsSync(`${p}.lock`)).toBe(false);
    expect((JSON.parse(readFileSync(p, "utf8")) as SessionRecord[]).map((r) => r.id)).toEqual(["x"]);
  });

  it("sees a session another instance started, without writing first (#235)", () => {
    const p = newPath();
    const a = new SessionStore(p);
    a.load();
    const b = new SessionStore(p);
    b.load();
    b.create(record({ id: "b-rec" }));
    expect(a.get("b-rec")?.status).toBe("recording");
    expect(a.list().map((s) => s.id)).toEqual(["b-rec"]);
    b.update("b-rec", { status: "stopped", endReason: "stopped" });
    expect(a.get("b-rec")?.status).toBe("stopped");
    expect(a.list()[0]?.endReason).toBe("stopped");
  });

  it("does not let a stale update clobber fields another instance changed (#235)", () => {
    const p = newPath();
    const a = new SessionStore(p);
    a.load();
    a.create(record({ id: "r" }));
    // B loads the live recording, then A stops it.
    const b = new SessionStore(p);
    b.load();
    a.update("r", { status: "stopped", endReason: "stopped", durationSec: 9 });
    // B, still holding its "recording" copy, records only the event log.
    const out = b.update("r", { events: { path: "e.jsonl", keys: "masked", count: 3 } });
    const onDisk = (JSON.parse(readFileSync(p, "utf8")) as SessionRecord[])[0];
    for (const rec of [onDisk, out, a.get("r")]) {
      expect(rec?.status).toBe("stopped");
      expect(rec?.endReason).toBe("stopped");
      expect(rec?.durationSec).toBe(9);
      expect(rec?.events?.count).toBe(3);
    }
  });

  it("fails a write instead of writing unlocked while the lock is busy (#235)", () => {
    const p = newPath();
    paths.push(`${p}.lock`);
    // A fresh lock held by a live process (this one).
    writeFileSync(`${p}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const store = new SessionStore(p, 200);
    store.load();
    expect(() => store.create(record({ id: "x" }))).toThrow(ScreencastError);
    expect(() => store.create(record({ id: "x" }))).toThrow(/registry is busy/);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.lock`)).toBe(true);
    expect(store.get("x")).toBeUndefined();
  });

  it("backs up a corrupt registry to .bak instead of silently discarding it", () => {
    const p = newPath();
    writeFileSync(p, "{ not json");
    const store = new SessionStore(p);
    store.load();
    expect(store.list()).toEqual([]);
    expect(existsSync(`${p}.bak`)).toBe(true);
    rmSync(`${p}.bak`, { force: true });
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
});

describe("isLockStale (#55)", () => {
  it("is stale when the holder is dead, the lock is old, or it is unreadable", () => {
    expect(isLockStale({ pid: 1, at: 1_000 }, 1_500, false)).toBe(true);
    expect(isLockStale({ pid: 1, at: 1_000 }, 1_000 + LOCK_STALE_MS + 1, true)).toBe(true);
    expect(isLockStale(null, 0, true)).toBe(true);
  });
  it("is held when the holder is alive and the lock is fresh", () => {
    expect(isLockStale({ pid: 1, at: 1_000 }, 1_500, true)).toBe(false);
  });
  it("judges a fresh lock with no readable pid (still being written) by age only", () => {
    expect(isLockStale({ at: 1_000 }, 1_500, false)).toBe(false);
    expect(isLockStale({ at: 1_000 }, 1_000 + LOCK_STALE_MS + 1, false)).toBe(true);
  });
});

describe("SessionStore across processes (#55)", () => {
  it("loses no record when several server processes write at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-lock-"));
    const registry = join(dir, "sessions.json");
    const sessionsModule = pathToFileURL(join(process.cwd(), "src", "utils", "sessions.ts")).href;
    const worker = join(dir, "worker.mts");
    writeFileSync(
      worker,
      `const { SessionStore } = await import(${JSON.stringify(sessionsModule)});
       const [registry, tag] = process.argv.slice(2);
       const store = new SessionStore(registry);
       store.load();
       for (let i = 0; i < 25; i++) {
         store.create({ id: tag + "-" + i, target: "full", outputPath: "o.mp4", fps: 30,
           quality: "standard", pid: null, status: "recording", startedAt: new Date().toISOString() });
       }`,
    );
    const stderr: string[] = [];
    const run = (tag: string) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", worker, registry, tag], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("exit", (code) => {
          if (err) stderr.push(`${tag} (exit ${code}): ${err}`);
          resolve(code);
        });
      });
    const tags = ["p0", "p1", "p2", "p3", "p4", "p5"];
    try {
      const codes = await Promise.all(tags.map(run));
      expect(codes, stderr.join("\n")).toEqual([0, 0, 0, 0, 0, 0]);
      const ids = new Set((JSON.parse(readFileSync(registry, "utf8")) as SessionRecord[]).map((r) => r.id));
      const missing = tags.flatMap((t) => Array.from({ length: 25 }, (_, i) => `${t}-${i}`)).filter((id) => !ids.has(id));
      expect(missing, `missing ${missing.join(", ")}\n${stderr.join("\n")}`).toEqual([]);
      expect(existsSync(`${registry}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Six cold tsx starts plus 150 locked writes; a loaded CI runner needs room.
  }, 120_000);
});

describe("recorder process image (#182)", () => {
  it("expects node for wgc recordings and ffmpeg otherwise", () => {
    expect(expectedImage({ backend: "wgc" })).toBe("node.exe");
    expect(expectedImage({ backend: "gdigrab" })).toBe("ffmpeg.exe");
    expect(expectedImage({})).toBe("ffmpeg.exe");
    expect(expectedImage({ backend: "wgc", processImage: "electron.exe" })).toBe("electron.exe");
  });
  it("matches the image column of a tasklist CSV line", () => {
    const line = '"node.exe","4242","Console","1","52,120 K"\r\n';
    expect(tasklistHasImage(line, "node.exe")).toBe(true);
    expect(tasklistHasImage(line, "NODE.EXE")).toBe(true);
    expect(tasklistHasImage(line, "ffmpeg.exe")).toBe(false);
    expect(tasklistHasImage("INFO: No tasks are running which match the specified criteria.", "node.exe")).toBe(false);
  });
});

describe("classifyUnrequestedExit (#240)", () => {
  const base = { backend: "gdigrab" as const, maxDurationSec: 60, elapsedMs: 60_500 };
  it("reports a closed window, not the cap", () => {
    expect(classifyUnrequestedExit({ ...base, backend: "wgc", code: WGC_WINDOW_CLOSED_EXIT, elapsedMs: 5_000 })).toEqual({ status: "stopped", endReason: "window_closed" });
  });
  it("calls a clean exit the cap only once the cap could have fired", () => {
    expect(classifyUnrequestedExit({ ...base, code: 0 })).toEqual({ status: "stopped", endReason: "max_duration" });
    expect(classifyUnrequestedExit({ ...base, code: 0, elapsedMs: 5_000 })).toEqual({ status: "stopped", endReason: "stopped" });
    expect(classifyUnrequestedExit({ ...base, code: 0, maxDurationSec: 0 })).toEqual({ status: "stopped", endReason: "stopped" });
  });
  it("treats any other non-zero exit as a crash", () => {
    expect(classifyUnrequestedExit({ ...base, code: 1 })).toEqual({ status: "failed", endReason: "crashed" });
    expect(classifyUnrequestedExit({ ...base, code: WGC_WINDOW_CLOSED_EXIT })).toEqual({ status: "failed", endReason: "crashed" });
  });
});

describe("tryUpdate (#207)", () => {
  it("logs a failed registry write instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-try-"));
    const store = new SessionStore(join(dir, "sessions.json"));
    store.load();
    store.create({ id: "r", target: "full", outputPath: "o.mp4", fps: 30, quality: "standard", pid: null, status: "recording", startedAt: new Date().toISOString() });
    store.persist = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    expect(() => store.update("r", { status: "stopped" })).toThrow(/ENOSPC/);
    expect(() => store.tryUpdate("r", { status: "stopped" })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("recycled server pid (#185)", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const rec = { startedAt: new Date(start + 60_000).toISOString(), serverStartedAt: new Date(start).toISOString(), serverImage: "node.exe" };

  it("accepts the owner itself and trusts a pid whose details cannot be read", () => {
    expect(isSameServer(rec, { image: "NODE.EXE", startMs: start - 200 })).toBe(true);
    expect(isSameServer(rec, null)).toBe(true);
  });
  it("rejects a process that started after the owner, or runs another image", () => {
    expect(isSameServer(rec, { image: "node.exe", startMs: start + 120_000 })).toBe(false);
    expect(isSameServer(rec, { image: "chrome.exe", startMs: start })).toBe(false);
    // Older records: judged against the record's own start.
    expect(isSameServer({ startedAt: rec.startedAt }, { image: "x.exe", startMs: start + 120_000 })).toBe(false);
    expect(isSameServer({ startedAt: rec.startedAt }, { image: "x.exe", startMs: start })).toBe(true);
  });
  it("parses the process query output", () => {
    expect(parseProcessInfo("node.exe|1793154113389\r\n")).toEqual({ image: "node.exe", startMs: 1793154113389 });
    expect(parseProcessInfo("")).toBeNull();
  });
  it("stamps this server's identity", () => {
    const id = serverIdentity();
    expect(id.serverPid).toBe(process.pid);
    expect(Date.parse(id.serverStartedAt!)).toBeLessThanOrEqual(Date.now());
  });

  it.skipIf(process.platform !== "win32")("reaps a record whose server pid now belongs to a newer process", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const p = join(tmpdir(), `sc-recycled-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      await new Promise((r) => child.once("spawn", r));
      const info = processInfo(child.pid!);
      expect(info?.image.toLowerCase()).toBe("node.exe");
      expect(Math.abs(info!.startMs - Date.now())).toBeLessThan(30_000);
      const old = new Date(Date.now() - 600_000).toISOString();
      const live = new Date(info!.startMs).toISOString();
      writeFileSync(p, JSON.stringify([
        record({ id: "phantom", pid: null, serverPid: child.pid, serverStartedAt: old, serverImage: "node.exe", startedAt: old }),
        record({ id: "owned", pid: null, serverPid: child.pid, serverStartedAt: live, serverImage: "node.exe" }),
      ]));
      const store = new SessionStore(p);
      store.load();
      store.reapOrphans();
      expect(store.get("phantom")?.status).toBe("stopped");
      expect(store.get("owned")?.status).toBe("recording");
    } finally {
      child.kill();
      rmSync(p, { force: true });
    }
  }, 30_000);
});

describe("stale-lock takeover (#185)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("removes the lock it judged stale, but puts back one that replaced it", () => {
    dir = mkdtempSync(join(tmpdir(), "sc-stale-"));
    const lock = join(dir, "sessions.json.lock");
    const stale = JSON.stringify({ pid: 0, at: 1 });
    writeFileSync(lock, stale);
    expect(breakStaleLock(lock, stale)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // Another waiter already took over: the lock now holds a fresh owner.
    const fresh = JSON.stringify({ pid: process.pid, at: Date.now() });
    writeFileSync(lock, fresh);
    expect(breakStaleLock(lock, stale)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(fresh);
    expect(readdirSync(dir)).toEqual(["sessions.json.lock"]);
    expect(breakStaleLock(join(dir, "missing.lock"), stale)).toBe(false);
  });

  it("does not delete a lock another holder took over while it ran", () => {
    dir = mkdtempSync(join(tmpdir(), "sc-stale-"));
    const registry = join(dir, "sessions.json");
    const other = JSON.stringify({ pid: process.pid + 1, at: Date.now() });
    withRegistryLock(registry, () => writeFileSync(`${registry}.lock`, other));
    expect(readFileSync(`${registry}.lock`, "utf8")).toBe(other);
    withRegistryLock(join(dir, "b.json"), () => undefined);
    expect(existsSync(join(dir, "b.json.lock"))).toBe(false);
  });
});
