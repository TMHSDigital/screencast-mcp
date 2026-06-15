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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
      this.records = new Map();
    }
  }

  persist(): void {
    writeFileSync(this.path, JSON.stringify([...this.records.values()], null, 2));
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
