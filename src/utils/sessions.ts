/**
 * Recording session registry.
 *
 * Sessions are tracked both in memory (with a live child-process handle for
 * graceful stop) and on disk (sessions.json) so that:
 *   - stop/list/get survive within a server run, and
 *   - a crash leaves a durable record the next boot can reconcile (orphan
 *     reaping), ensuring no ffmpeg child silently outlives the server.
 *
 * The child handle is intentionally NOT persisted; only the pid is. Reaping
 * logic (classifyOrphan) is pure so it is unit-tested without real processes.
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  copyFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Quality } from "./targets.js";

/** Cap on retained finished records, so the registry does not grow without
 * bound. Active ("recording") records are always kept. */
export const MAX_FINISHED_RECORDS = 100;

export type SessionStatus = "recording" | "stopped" | "failed" | "orphaned";

/** Why a recording ended: an explicit stop_recording, the maxDurationSec cap,
 * an ffmpeg crash, or the server shutting down (client disconnect / signal). */
export type EndReason = "stopped" | "max_duration" | "crashed" | "shutdown";

export interface SessionRecord {
  id: string;
  target: string;
  outputPath: string;
  fps: number;
  quality: Quality;
  pid: number | null;
  /** The node process (server instance) that created this record. Used so a
   * second server instance does not reap a recording owned by a still-live one. */
  serverPid?: number;
  status: SessionStatus;
  startedAt: string;
  stoppedAt?: string;
  durationSec?: number;
  /** Capture cap passed to ffmpeg as -t (0 / absent = unlimited). */
  maxDurationSec?: number;
  endReason?: EndReason;
  error?: string;
  /** For window: targets, the title of the window actually recorded (#89). */
  matchedWindow?: string;
}

/** Decide what an in-progress session becomes at boot, given liveness.
 * Pure: a still-alive pid is an orphan to be reaped; a dead one simply ended. */
export function classifyOrphan(
  record: SessionRecord,
  alive: boolean,
): { status: SessionStatus; reaped: boolean } {
  if (record.status !== "recording") {
    return { status: record.status, reaped: false };
  }
  return alive
    ? { status: "orphaned", reaped: true }
    : { status: "stopped", reaped: false };
}

/**
 * True if a "recording" record is owned by a DIFFERENT, still-live server
 * instance. Such a record must be left alone: another running server is actively
 * recording it, so reaping would kill that server's live capture. Pure so the
 * ownership rule is unit-tested without real processes.
 *
 * Records with no `serverPid` (older registries) are not treated as foreign, so
 * genuine orphans there still get reaped.
 */
export function isForeignLiveRecording(
  record: SessionRecord,
  currentServerPid: number,
  ownerAlive: boolean,
): boolean {
  return (
    record.status === "recording" &&
    record.serverPid !== undefined &&
    record.serverPid !== currentServerPid &&
    ownerAlive
  );
}

/** True if a pid exists. `process.kill(pid, 0)` throws ESRCH when it does not. */
export function isAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** On Windows, confirm a pid is actually an ffmpeg.exe before killing it, so a
 * recycled pid belonging to an unrelated process is never terminated. */
export function isFfmpegProcess(pid: number | null): boolean {
  if (pid === null || process.platform !== "win32") return false;
  const res = spawnSync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) return false;
  return /"ffmpeg\.exe"/i.test(res.stdout);
}

/** Forcefully terminate a pid tree (used only for orphan reaping). */
export function killPid(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Keep every active recording plus the most recent MAX_FINISHED_RECORDS
 * finished records (newest first), so the registry stays bounded. Pure. */
export function pruneRecords(records: SessionRecord[]): SessionRecord[] {
  const active = records.filter((r) => r.status === "recording");
  const finished = records
    .filter((r) => r.status !== "recording")
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, MAX_FINISHED_RECORDS);
  return [...active, ...finished];
}

/** A lock older than this is assumed abandoned even if its pid looks alive
 * (pids are recycled). A read-merge-write takes milliseconds. */
export const LOCK_STALE_MS = 10_000;
/** Give up waiting for the lock after this long and write anyway: a stuck
 * lock must not stop a recording from being registered. */
export const LOCK_WAIT_MS = 2_000;

/** True when a registry lock can be taken over: it is older than
 * LOCK_STALE_MS, or it names a holder pid that is no longer alive. A lock with
 * no readable pid (just created, not yet written) is judged by age alone.
 * Pure so the rule is unit-tested. */
export function isLockStale(
  holder: { pid?: number; at?: number } | null,
  now: number,
  holderAlive: boolean,
): boolean {
  if (!holder || typeof holder.at !== "number") return true;
  if (now - holder.at > LOCK_STALE_MS) return true;
  return typeof holder.pid === "number" && !holderAlive;
}

/** Synchronous sleep for the lock retry loop (persist() is synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** renameSync, retried briefly on Windows sharing errors. A rename over a file
 * that another process (an unlocked reader, antivirus, the search indexer)
 * momentarily holds open fails with EPERM/EBUSY rather than waiting. */
function renameWithRetry(from: string, to: string): void {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || Date.now() >= deadline) throw err;
      sleepSync(15);
    }
  }
}

/** Run `fn` holding an exclusive lockfile next to the registry (#55), so two
 * server instances cannot interleave a read-merge-write. The lock is an
 * O_EXCL-created file holding the owner's pid and a timestamp; a stale lock
 * (dead owner or older than LOCK_STALE_MS) is taken over. */
function withRegistryLock<T>(registry: string, fn: () => T): T {
  const lock = `${registry}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      held = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (Date.now() >= deadline) {
        process.stderr.write(`Session registry lock ${lock} is busy; writing without it.\n`);
        break;
      }
      // On Windows a lock that its holder just deleted, while another process
      // still had it open, lingers as "delete pending": creating it again fails
      // with EPERM/EACCES/EBUSY, not EEXIST. That means busy, so wait.
      if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
        sleepSync(5 + Math.random() * 10);
        continue;
      }
      if (code !== "EEXIST") break; // e.g. a missing or read-only dir: write unlocked
      let holder: { pid?: number; at?: number } | null;
      try {
        holder = JSON.parse(readFileSync(lock, "utf8"));
      } catch {
        // Unreadable or half-written: judge it by the file's age instead.
        try {
          holder = { at: statSync(lock).mtimeMs };
        } catch {
          continue; // the holder just released it; retry at once
        }
      }
      if (isLockStale(holder, Date.now(), isAlive(holder?.pid ?? null))) {
        try {
          unlinkSync(lock);
        } catch {
          /* another instance took it over first */
        }
        continue;
      }
      sleepSync(10 + Math.random() * 15);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        unlinkSync(lock);
      } catch {
        /* already removed */
      }
    }
  }
}

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  /** Ids this instance created or changed since its last write. Only these
   * override the on-disk copy; every other record is taken from disk, so a
   * stale copy loaded at boot never undoes another instance's update (#55). */
  private dirty = new Set<string>();
  private children = new Map<string, ChildProcess>();
  /** Ids with a deliberate stop in flight, so the child's exit handler does not
   * misread the clean exit as the maxDurationSec cap firing. */
  private stopping = new Set<string>();
  /** Called after every write, e.g. to tell MCP clients the session
   * resources changed (#126). */
  private listeners: Array<() => void> = [];

  constructor(private readonly path: string) {}

  /** Run `cb` after each registry write. A throwing listener is ignored. */
  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  /** Read the on-disk records, tolerating a missing or corrupt file. A corrupt
   * registry is copied to .bak for inspection instead of silently discarded -
   * it may hold "recording" entries whose ffmpeg would otherwise never be
   * reaped. */
  private readDisk(): Map<string, SessionRecord> {
    if (!existsSync(this.path)) return new Map();
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as SessionRecord[];
      return new Map(data.map((r) => [r.id, r]));
    } catch {
      try {
        copyFileSync(this.path, `${this.path}.bak`);
        process.stderr.write(
          `Session registry was unreadable; saved a copy to ${this.path}.bak and starting fresh.\n`,
        );
      } catch {
        /* best effort */
      }
      return new Map();
    }
  }

  load(): void {
    // Read under the lock too: on Windows a writer's rename over the file
    // fails while any other process has it open for reading.
    const disk = withRegistryLock(this.path, () => this.readDisk());
    this.records = new Map(pruneRecords([...disk.values()]).map((r) => [r.id, r]));
  }

  persist(): void {
    // Under the registry lock: re-read the file, overlay only the records this
    // instance changed (anything else on disk is newer than our copy), prune,
    // and write atomically (temp + rename) so a kill mid-write cannot corrupt
    // the file. Our view is then refreshed from what was written.
    withRegistryLock(this.path, () => {
      const merged = this.readDisk();
      for (const id of this.dirty) {
        const rec = this.records.get(id);
        if (rec) merged.set(id, rec);
      }
      const pruned = pruneRecords([...merged.values()]);
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(pruned, null, 2));
      renameWithRetry(tmp, this.path);
      this.records = new Map(pruned.map((r) => [r.id, r]));
      this.dirty.clear();
    });
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a listener must not break a registry write */
      }
    }
  }

  create(record: SessionRecord): void {
    this.records.set(record.id, record);
    this.dirty.add(record.id);
    this.persist();
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    );
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const cur = this.records.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.records.set(id, next);
    this.dirty.add(id);
    this.persist();
    return this.records.get(id) ?? next;
  }

  attachChild(id: string, child: ChildProcess): void {
    this.children.set(id, child);
  }

  getChild(id: string): ChildProcess | undefined {
    return this.children.get(id);
  }

  detachChild(id: string): void {
    this.children.delete(id);
  }

  /** Ids of recordings this instance owns a live child handle for. */
  activeIds(): string[] {
    return [...this.children.keys()].filter((id) => this.records.get(id)?.status === "recording");
  }

  markStopping(id: string): void {
    this.stopping.add(id);
  }

  isStopping(id: string): boolean {
    return this.stopping.has(id);
  }

  clearStopping(id: string): void {
    this.stopping.delete(id);
  }

  /**
   * Reconcile persisted "recording" sessions at boot: kill any ffmpeg child
   * that outlived the previous server, and mark records accordingly. Returns
   * the ids that were reaped.
   */
  reapOrphans(): string[] {
    const reaped: string[] = [];
    for (const record of this.records.values()) {
      if (record.status !== "recording") continue;
      // Never reap a recording owned by another still-live server instance:
      // that would kill its active capture. Leave the record untouched.
      if (isForeignLiveRecording(record, process.pid, isAlive(record.serverPid ?? null))) {
        continue;
      }
      const alive = isAlive(record.pid);
      const verdict = classifyOrphan(record, alive);
      if (verdict.reaped && record.pid !== null) {
        if (isFfmpegProcess(record.pid)) killPid(record.pid);
        reaped.push(record.id);
      }
      this.dirty.add(record.id);
      this.records.set(record.id, {
        ...record,
        status: verdict.status,
        stoppedAt: record.stoppedAt ?? new Date().toISOString(),
        error:
          verdict.status === "orphaned"
            ? "Reaped on server restart (recording was interrupted)."
            : record.error,
      });
    }
    if (this.records.size > 0) this.persist();
    return reaped;
  }
}
