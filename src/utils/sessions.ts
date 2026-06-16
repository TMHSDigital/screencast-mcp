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
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Quality } from "./targets.js";

/** Cap on retained finished records, so the registry does not grow without
 * bound. Active ("recording") records are always kept. */
export const MAX_FINISHED_RECORDS = 100;

export type SessionStatus = "recording" | "stopped" | "failed" | "orphaned";

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
  error?: string;
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

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  private children = new Map<string, ChildProcess>();

  constructor(private readonly path: string) {}

  /** Read the on-disk records, tolerating a missing or corrupt file. */
  private readDisk(): Map<string, SessionRecord> {
    if (!existsSync(this.path)) return new Map();
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as SessionRecord[];
      return new Map(data.map((r) => [r.id, r]));
    } catch {
      return new Map();
    }
  }

  load(): void {
    this.records = new Map(pruneRecords([...this.readDisk().values()]).map((r) => [r.id, r]));
  }

  persist(): void {
    // Merge with what is on disk so a concurrent server instance's records are
    // not clobbered; our in-memory view wins for the ids we own (ids are unique
    // per recording, so this is effectively a union). Then prune and write
    // atomically (temp + rename) so a kill mid-write cannot corrupt the file.
    const merged = this.readDisk();
    for (const [id, rec] of this.records) merged.set(id, rec);
    const pruned = pruneRecords([...merged.values()]);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(pruned, null, 2));
    renameSync(tmp, this.path);
    this.records = new Map(pruned.map((r) => [r.id, r]));
  }

  create(record: SessionRecord): void {
    this.records.set(record.id, record);
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
    this.persist();
    return next;
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
