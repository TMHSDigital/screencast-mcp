/**
 * Recording session registry.
 *
 * Sessions are tracked both in memory (with a live child-process handle for
 * graceful stop) and on disk (sessions.json) so that:
 *   - stop/list/get survive within a server run, and
 *   - a crash leaves a durable record the next boot can reconcile (orphan
 *     reaping), ensuring no ffmpeg child silently outlives the server.
 *
 * The child handle is intentionally NOT persisted; only the pid is. The
 * reaping rules live in orphans.ts (pure, so unit-tested without real
 * processes), pid metadata in processes.ts, and the registry lock in
 * fileLock.ts (#360); this module re-exports them.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { errorMessage } from "./errors.js";
import type { Quality } from "./targets.js";
import { WGC_WINDOW_CLOSED_EXIT } from "./wgc.js";
import type { ReplayBuffer } from "./replay.js";
import type { Marker } from "./chapters.js";
import type { VideoEncoder } from "./gpu.js";
import type { SegmentCapture, SegmentState, WebcamInfo } from "./pause.js";
import type { PerfSummary } from "./perf.js";

// Split out (#360); re-exported so existing importers keep one entry point.
export * from "./processes.js";
export * from "./orphans.js";
export { LOCK_STALE_MS, LOCK_WAIT_MS, isLockStale, breakStaleLock, withRegistryLock } from "./fileLock.js";
import { isAlive, killPid, processInfo, processInfoAsync } from "./processes.js";
import { classifyOrphan, isForeignLiveRecording, isOwnRecorder, ownerAlive } from "./orphans.js";
import { LOCK_WAIT_MS, renameWithRetry, withRegistryLock } from "./fileLock.js";

/** gdigrab (screen rectangle), wgc (one window, #113), or ddagrab (Desktop
 * Duplication on the GPU, #199). */
export type CaptureBackend = "gdigrab" | "wgc" | "ddagrab";

/** Cap on retained finished records, so the registry does not grow without
 * bound. Active ("recording") records are always kept. */
export const MAX_FINISHED_RECORDS = 100;

export type SessionStatus = "recording" | "paused" | "stopped" | "failed" | "orphaned";

/** Statuses of a session that has not ended: recording, or paused between
 * segments (#200). */
export function isLive(status: SessionStatus): boolean {
  return status === "recording" || status === "paused";
}

/** Why a recording ended: an explicit stop_recording, the maxDurationSec cap,
 * an ffmpeg crash, the server shutting down (client disconnect / signal), or
 * the recorded window closing (wgc, #240). */
export type EndReason = "stopped" | "max_duration" | "crashed" | "shutdown" | "window_closed";

export interface SessionRecord {
  id: string;
  target: string;
  /** A name the caller gave it (#366), for list_sessions query. */
  label?: string;
  outputPath: string;
  fps: number;
  quality: Quality;
  pid: number | null;
  /** The node process (server instance) that created this record. Used so a
   * second server instance does not reap a recording owned by a still-live one. */
  serverPid?: number;
  /** When that server process started, and its image name (node.exe), so a
   * crashed server's pid recycled by another process is not mistaken for a
   * live owner (#185). Absent on older records. */
  serverStartedAt?: string;
  serverImage?: string;
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
  /** Capture backend: the screen rectangle (gdigrab) or the window itself
   * through Windows Graphics Capture (wgc, #113). Absent on older records. */
  backend?: CaptureBackend;
  /** Video encoder (#199): libx264, or a hardware one. Absent = x264. */
  encoder?: VideoEncoder;
  /** How to start another segment after pause_recording (#200). */
  capture?: SegmentCapture;
  /** The recorded segments (#200): finished parts and the one running now. */
  segments?: SegmentState;
  /** Webcam sidecar (#200). */
  webcam?: WebcamInfo;
  /** Image name of the process behind `pid` (ffmpeg.exe, or node.exe for the
   * wgc recorder), checked before a kill by pid (#182). Absent on older
   * records; see expectedImage. */
  processImage?: string;
  /** When the process behind `pid` was spawned (epoch ms), so a pid recycled
   * by a later process is never killed as the recorder (#284). Absent on
   * older records. */
  pidSpawnedAt?: number;
  /** Input event log (#118), when the recording was started with events: true. */
  events?: {
    path: string;
    keys: "masked" | "shortcuts";
    count?: number;
    summary?: Record<string, number>;
    error?: string;
  };
  /** CPU and memory sampled during the recording (#335). */
  perf?: { path: string; summary?: PerfSummary; error?: string };
  /** App logs followed during the recording (#334), on the video clock. */
  logs?: { path: string; sources: string[]; count?: number; errors?: number; error?: string };
  /** Clips saveWhen wrote from the replay buffer (#356), oldest first. */
  autoSaves?: Array<{ at: string; outputPath?: string; durationSec?: number; error?: string }>;
  /** Epoch ms of the first captured frame (ffmpeg's input start), the zero of
   * the video clock that add_marker stamps markers on (#174). */
  videoStartMs?: number;
  /** Labelled moments from add_marker, in video seconds, in time order (#174). */
  markers?: Marker[];
  /** Rolling replay buffer (#197), when started with replayBufferSec. The
   * recording writes a segment ring here instead of outputPath; save_replay
   * keeps the last N seconds, and stop_recording { save: true } writes the
   * whole buffer to outputPath. */
  replay?: ReplayBuffer;
}

/** Classify a recorder exit nobody asked for. Non-zero is a crash; the wgc
 * window-closed code is its own reason; a clean exit is the maxDurationSec cap
 * only once the cap could actually have been reached (#240). Pure. */
export function classifyUnrequestedExit(opts: {
  code: number | null;
  backend: CaptureBackend;
  maxDurationSec: number;
  elapsedMs: number;
}): { status: "stopped" | "failed"; endReason: EndReason } {
  const { code, backend, maxDurationSec, elapsedMs } = opts;
  if (backend === "wgc" && code === WGC_WINDOW_CLOSED_EXIT) return { status: "stopped", endReason: "window_closed" };
  if (code !== 0 && code !== null) return { status: "failed", endReason: "crashed" };
  const capReached = maxDurationSec > 0 && elapsedMs >= maxDurationSec * 1000 - 2000;
  return { status: "stopped", endReason: capReached ? "max_duration" : "stopped" };
}

/** Keep every active recording plus the most recent MAX_FINISHED_RECORDS
 * finished records (newest first), so the registry stays bounded. Pure. */
export function pruneRecords(records: SessionRecord[]): SessionRecord[] {
  const active = records.filter((r) => isLive(r.status));
  const finished = records
    .filter((r) => !isLive(r.status))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, MAX_FINISHED_RECORDS);
  return [...active, ...finished];
}

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  /** Fields this instance created or changed since its last write, by id. Only
   * these override the on-disk copy, field by field: every other record and
   * field is taken from disk, so a stale copy never undoes another instance's
   * update (#55, #235). */
  private pending = new Map<string, Partial<SessionRecord>>();
  /** Records this instance deleted, kept out of the next write (#321). */
  private removed = new Set<string>();
  /** Identity of the registry file as last read or written, so get()/list()
   * re-read it only when another instance has replaced it (#235). */
  private seen: string | null = null;
  private children = new Map<string, ChildProcess>();
  /** Ids with a deliberate stop in flight, so the child's exit handler does not
   * misread the clean exit as the maxDurationSec cap firing. */
  private stopping = new Set<string>();
  /** Called after every write, e.g. to tell MCP clients the session
   * resources changed (#126). */
  private listeners: Array<() => void> = [];

  constructor(
    private readonly path: string,
    private readonly lockWaitMs = LOCK_WAIT_MS,
  ) {}

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
      return this.parseDisk();
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

  /** Parse the registry file; throws if it is missing or unreadable. */
  private parseDisk(): Map<string, SessionRecord> {
    const data = JSON.parse(readFileSync(this.path, "utf8")) as SessionRecord[];
    return new Map(data.map((r) => [r.id, r]));
  }

  /** The registry file's identity: every write replaces it by rename, so a
   * new file id (or size/mtime) means another instance wrote it. */
  private signature(): string | null {
    try {
      const s = statSync(this.path, { bigint: true });
      return `${s.ino}:${s.size}:${s.mtimeNs}`;
    } catch {
      return null;
    }
  }

  /** Lay this instance's unwritten changes over the on-disk records, field by
   * field, falling back to our own copy for a record the disk no longer has. */
  private overlay(disk: Map<string, SessionRecord>): Map<string, SessionRecord> {
    for (const [id, patch] of this.pending) {
      const base = disk.get(id) ?? this.records.get(id);
      if (base) disk.set(id, { ...base, ...patch });
    }
    for (const id of this.removed) disk.delete(id);
    return disk;
  }

  /** Pick up records another server instance started, stopped, or updated
   * since we last looked (#235). Cheap when nothing changed (one stat). A read
   * that fails (the file mid-replace, or corrupt) keeps the current view;
   * load() and persist() deal with a corrupt file. */
  private refresh(): void {
    const sig = this.signature();
    if (sig === this.seen) return;
    let disk: Map<string, SessionRecord>;
    try {
      disk = sig === null ? new Map() : this.parseDisk();
    } catch {
      return;
    }
    this.seen = sig;
    this.records = new Map(pruneRecords([...this.overlay(disk).values()]).map((r) => [r.id, r]));
  }

  load(): void {
    // Read under the lock too: on Windows a writer's rename over the file
    // fails while any other process has it open for reading. If the lock
    // stays busy, read anyway: a read cannot lose a record, and the writer's
    // rename is retried.
    const read = () => {
      const disk = this.readDisk();
      this.seen = this.signature();
      return disk;
    };
    let disk: Map<string, SessionRecord>;
    try {
      disk = withRegistryLock(this.path, read, this.lockWaitMs);
    } catch (err) {
      process.stderr.write(`${errorMessage(err)} Reading the session registry without the lock.\n`);
      disk = read();
    }
    this.records = new Map(pruneRecords([...this.overlay(disk).values()]).map((r) => [r.id, r]));
  }

  persist(): void {
    // Under the registry lock: re-read the file, overlay only the fields this
    // instance changed (anything else on disk is newer than our copy), prune,
    // and write atomically (temp + rename) so a kill mid-write cannot corrupt
    // the file. Our view is then refreshed from what was written. A lock that
    // stays busy throws and leaves the changes pending for the next write.
    withRegistryLock(
      this.path,
      () => {
        const pruned = pruneRecords([...this.overlay(this.readDisk()).values()]);
        const tmp = `${this.path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(pruned, null, 2));
        renameWithRetry(tmp, this.path);
        this.seen = this.signature();
        this.records = new Map(pruned.map((r) => [r.id, r]));
        this.pending.clear();
        this.removed.clear();
      },
      this.lockWaitMs,
    );
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a listener must not break a registry write */
      }
    }
  }

  /** Register a new session. If the write fails the session is dropped again,
   * so a recording the caller then abandons does not linger in our view. */
  create(record: SessionRecord): void {
    this.records.set(record.id, record);
    this.pending.set(record.id, record);
    try {
      this.persist();
    } catch (err) {
      this.records.delete(record.id);
      this.pending.delete(record.id);
      throw err;
    }
  }

  /** Delete finished records from the registry (#321). A failed write puts
   * them back in this instance's view and rethrows. */
  remove(ids: readonly string[]): void {
    const before = ids.flatMap((id) => {
      const r = this.records.get(id);
      return r ? [r] : [];
    });
    for (const id of ids) {
      this.removed.add(id);
      this.pending.delete(id);
      this.records.delete(id);
    }
    try {
      this.persist();
    } catch (err) {
      for (const id of ids) this.removed.delete(id);
      for (const r of before) this.records.set(r.id, r);
      throw err;
    }
  }

  get(id: string): SessionRecord | undefined {
    this.refresh();
    return this.records.get(id);
  }

  list(): SessionRecord[] {
    this.refresh();
    return [...this.records.values()].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    );
  }

  /** Apply `patch` to a session. Only the patched fields are written over the
   * current on-disk record, so fields another instance changed meanwhile
   * survive (#235). */
  update(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    let cur = this.records.get(id);
    if (!cur) {
      this.refresh(); // started by another instance since we last looked
      cur = this.records.get(id);
    }
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.records.set(id, next);
    this.pending.set(id, { ...this.pending.get(id), ...patch });
    this.persist();
    return this.records.get(id) ?? next;
  }

  /** update() for event handlers: a failed registry write (a full disk, a
   * locked sessions.json) is logged instead of thrown, because a throw from a
   * child-process or finalizer callback would crash the server (#207). */
  tryUpdate(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    try {
      return this.update(id, patch);
    } catch (err) {
      process.stderr.write(
        `Could not save session ${id}: ${errorMessage(err)}\n`,
      );
      return undefined;
    }
  }

  attachChild(id: string, child: ChildProcess): void {
    this.children.set(id, child);
  }

  getChild(id: string): ChildProcess | undefined {
    return this.children.get(id);
  }

  /** Forget a session's child handle. With `child`, only while that child is
   * still the attached one: a stale child's exit must not drop the handle of
   * the capture that replaced it (#252). */
  detachChild(id: string, child?: ChildProcess): void {
    if (child && this.children.get(id) !== child) return;
    this.children.delete(id);
  }

  /** Ids of recordings this instance owns a live child handle for, plus the
   * ones it paused (#200): shutdown finalizes both. */
  activeIds(): string[] {
    return [
      ...[...this.children.keys()].filter((id) => this.records.get(id)?.status === "recording"),
      ...[...this.paused].filter((id) => this.records.get(id)?.status === "paused" && !this.children.has(id)),
    ];
  }

  /** Sessions this instance paused and can resume (its event logger and
   * capture settings live here). */
  private paused = new Set<string>();

  markPaused(id: string): void {
    this.paused.add(id);
  }

  ownsPaused(id: string): boolean {
    return this.paused.has(id);
  }

  clearPaused(id: string): void {
    this.paused.delete(id);
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
  reapOrphans(opts: { ids?: ReadonlySet<string>; owners?: Map<number, ReturnType<typeof processInfo>> } = {}): string[] {
    this.refresh();
    const reaped: string[] = [];
    const owners = opts.owners ?? new Map<number, ReturnType<typeof processInfo>>();
    for (const record of this.records.values()) {
      if (!isLive(record.status)) continue;
      if (opts.ids && !opts.ids.has(record.id)) continue;
      // Never reap a recording owned by another still-live server instance:
      // that would kill its active capture. Leave the record untouched.
      if (isForeignLiveRecording(record, process.pid, ownerAlive(record, owners))) {
        continue;
      }
      const alive = isAlive(record.pid);
      const verdict = classifyOrphan(record, alive);
      if (verdict.reaped && record.pid !== null) {
        if (isOwnRecorder(record)) killPid(record.pid);
        reaped.push(record.id);
      }
      const patch: Partial<SessionRecord> = {
        status: verdict.status,
        ...(record.stoppedAt ? {} : { stoppedAt: new Date().toISOString() }),
        ...(verdict.status === "orphaned"
          ? { error: "Reaped on server restart (recording was interrupted)." }
          : {}),
        ...(record.status === "paused"
          ? {
              endReason: "shutdown" as const,
              error: `The server exited while this recording was paused; its parts were not joined (${record.segments?.parts.map((p) => p.path).join(", ") ?? record.outputPath}).`,
            }
          : {}),
        // A resumed recording whose owner exited before the stop joined its
        // segments (a shutdown cap, a crash): outputPath holds only the first
        // part, so say so instead of reporting a clean stop (#345).
        ...(record.status === "recording" && (record.segments?.parts.length ?? 0) > 0
          ? {
              endReason: "shutdown" as const,
              error: `The server exited before this recording's segments were joined; ${record.outputPath} holds only the first one. The parts: ${[
                ...(record.segments?.parts.map((p) => p.path) ?? []),
                ...(record.segments?.current ? [record.segments.current.path] : []),
              ].join(", ")}.`,
            }
          : {}),
      };
      this.records.set(record.id, { ...record, ...patch });
      this.pending.set(record.id, { ...this.pending.get(record.id), ...patch });
    }
    if (this.records.size > 0) this.persist();
    return reaped;
  }

  /** Ids of the live records now: what boot reaping may touch. */
  liveIds(): Set<string> {
    return new Set(this.list().flatMap((r) => (isLive(r.status) ? [r.id] : [])));
  }

  /**
   * reapOrphans for the records in `ids`, without blocking the event loop on
   * PowerShell (#358): the owner details of foreign live servers are read
   * asynchronously first, so the server can answer initialize meanwhile. Only
   * records that existed at boot are passed, so a recording this server
   * starts in the meantime is never taken for an orphan.
   */
  async reapOrphansAsync(ids: ReadonlySet<string>): Promise<string[]> {
    const pids = new Set<number>();
    for (const r of this.list()) {
      const pid = r.serverPid;
      if (ids.has(r.id) && pid !== undefined && pid !== process.pid && isAlive(pid)) pids.add(pid);
    }
    const owners = new Map(await Promise.all([...pids].map(async (pid) => [pid, await processInfoAsync(pid)] as const)));
    return this.reapOrphans({ ids, owners });
  }
}
