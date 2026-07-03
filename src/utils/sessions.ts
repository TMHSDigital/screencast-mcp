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
  existsSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Quality } from "./targets.js";

export type SessionStatus = "recording" | "stopped" | "failed" | "orphaned";

export interface SessionRecord {
  id: string;
  target: string;
  outputPath: string;
  fps: number;
  quality: Quality;
  pid: number | null;
  /** Pid of the server instance that owns this recording. Another instance's
   * boot must not reap a recording whose owning server is still alive. */
  serverPid?: number;
  status: SessionStatus;
  startedAt: string;
  stoppedAt?: string;
  durationSec?: number;
  error?: string;
}

/** Decide what an in-progress session becomes at boot, given liveness.
 * Pure: a still-alive pid is an orphan to be reaped; a dead one simply ended.
 * A record whose owning server instance is still alive stays "recording" -
 * it belongs to a concurrently running server and must be left alone. */
export function classifyOrphan(
  record: SessionRecord,
  alive: boolean,
  ownerAlive = false,
): { status: SessionStatus; reaped: boolean } {
  if (record.status !== "recording") {
    return { status: record.status, reaped: false };
  }
  if (ownerAlive) {
    return { status: "recording", reaped: false };
  }
  return alive
    ? { status: "orphaned", reaped: true }
    : { status: "stopped", reaped: false };
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

/** Terminal (non-"recording") records kept in the registry, newest first. */
const MAX_TERMINAL_RECORDS = 200;

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  private children = new Map<string, ChildProcess>();

  constructor(private readonly path: string) {}

  load(): void {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as SessionRecord[];
      this.records = new Map(data.map((r) => [r.id, r]));
    } catch {
      // Keep the unreadable file for inspection instead of silently losing
      // every record (including "recording" ones we could otherwise reap).
      try {
        copyFileSync(this.path, `${this.path}.bak`);
        process.stderr.write(
          `Session registry was unreadable; saved a copy to ${this.path}.bak and starting fresh.\n`,
        );
      } catch {
        /* best effort */
      }
      this.records = new Map();
    }
  }

  persist(): void {
    // Merge with what is on disk so a concurrently running server instance's
    // records (ids we do not track) are not clobbered. Our in-memory view wins
    // for ids we do track. This narrows, but does not eliminate, the
    // last-write-wins window - there is no cross-process lock.
    const merged = new Map<string, SessionRecord>();
    if (existsSync(this.path)) {
      try {
        const disk = JSON.parse(readFileSync(this.path, "utf8")) as SessionRecord[];
        for (const r of disk) merged.set(r.id, r);
      } catch {
        /* corrupt on disk; our in-memory view wins */
      }
    }
    for (const [id, r] of this.records) merged.set(id, r);

    // Cap terminal records so the registry does not grow without bound.
    const all = [...merged.values()];
    const active = all.filter((r) => r.status === "recording");
    const terminal = all
      .filter((r) => r.status !== "recording")
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .slice(0, MAX_TERMINAL_RECORDS);

    // Atomic write: a crash mid-write must not leave a half-written registry.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...active, ...terminal], null, 2));
    renameSync(tmp, this.path);
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
      const ownerAlive =
        record.serverPid !== undefined &&
        record.serverPid !== process.pid &&
        isAlive(record.serverPid);
      const alive = isAlive(record.pid);
      const verdict = classifyOrphan(record, alive, ownerAlive);
      // Owned by a still-running server instance: not ours to touch.
      if (verdict.status === "recording") continue;
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
