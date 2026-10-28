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
  linkSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { ScreencastError } from "./errors.js";
import type { Quality } from "./targets.js";
import { WGC_WINDOW_CLOSED_EXIT } from "./wgc.js";
import type { ReplayBuffer } from "./replay.js";
import type { Marker } from "./chapters.js";

/** Cap on retained finished records, so the registry does not grow without
 * bound. Active ("recording") records are always kept. */
export const MAX_FINISHED_RECORDS = 100;

export type SessionStatus = "recording" | "stopped" | "failed" | "orphaned";

/** Why a recording ended: an explicit stop_recording, the maxDurationSec cap,
 * an ffmpeg crash, the server shutting down (client disconnect / signal), or
 * the recorded window closing (wgc, #240). */
export type EndReason = "stopped" | "max_duration" | "crashed" | "shutdown" | "window_closed";

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
  backend?: "gdigrab" | "wgc";
  /** Image name of the process behind `pid` (ffmpeg.exe, or node.exe for the
   * wgc recorder), checked before a kill by pid (#182). Absent on older
   * records; see expectedImage. */
  processImage?: string;
  /** Input event log (#118), when the recording was started with events: true. */
  events?: {
    path: string;
    keys: "masked" | "shortcuts";
    count?: number;
    summary?: Record<string, number>;
    error?: string;
  };
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

/** This server process's identity, stamped on the records it creates. */
export function serverIdentity(): Pick<SessionRecord, "serverPid" | "serverStartedAt" | "serverImage"> {
  return {
    serverPid: process.pid,
    serverStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    serverImage: basename(process.execPath).toLowerCase(),
  };
}

/** Slack between a process's OS creation time and the start time the process
 * computed for itself (they differ by its startup, well under a second). */
export const OWNER_START_SLACK_MS = 5_000;

/** True unless what is now running under a record's `serverPid` is provably
 * another process: a different image, or one that started after the owner
 * did (after the record itself, for records with no serverStartedAt). A pid
 * whose details cannot be read is trusted, so a live owner is never reaped
 * on a guess. Pure (#185). */
export function isSameServer(
  record: Pick<SessionRecord, "serverStartedAt" | "serverImage" | "startedAt">,
  running: { image: string; startMs: number } | null,
): boolean {
  if (!running) return true;
  if (record.serverImage && running.image.toLowerCase() !== record.serverImage.toLowerCase()) return false;
  const ref = Date.parse(record.serverStartedAt ?? record.startedAt);
  return !(Number.isFinite(ref) && running.startMs > ref + OWNER_START_SLACK_MS);
}

/** Parse `<image>|<start ms>` from processInfo's PowerShell. Pure. */
export function parseProcessInfo(stdout: string): { image: string; startMs: number } | null {
  const m = /^(.+)\|(\d+)\s*$/m.exec(stdout.trim());
  return m?.[1] && m[2] ? { image: m[1].trim(), startMs: Number(m[2]) } : null;
}

/** Image name and start time of a running pid (Windows), or null when it is
 * gone or cannot be read. Used only at boot, for records another server owns. */
export function processInfo(pid: number): { image: string; startMs: number } | null {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
    `if ($p) { "{0}|{1}" -f $p.Name, ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`;
  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return res.status === 0 && res.stdout ? parseProcessInfo(res.stdout) : null;
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

/** The process image a record's pid should belong to: what it stored, else
 * what its backend spawns (the wgc recorder runs under node, #182). Pure. */
export function expectedImage(record: Pick<SessionRecord, "processImage" | "backend">): string {
  return record.processImage ?? (record.backend === "wgc" ? "node.exe" : "ffmpeg.exe");
}

/** True when a `tasklist /FO CSV` line names the given image. Pure. */
export function tasklistHasImage(stdout: string, image: string): boolean {
  const first = stdout.split(/\r?\n/)[0] ?? "";
  return first.toLowerCase().startsWith(`"${image.toLowerCase()}"`);
}

/** On Windows, confirm a pid is still the expected recorder image before
 * killing it, so a recycled pid belonging to an unrelated process is never
 * terminated. */
export function isRecorderProcess(pid: number | null, image: string): boolean {
  if (pid === null || process.platform !== "win32") return false;
  const res = spawnSync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) return false;
  return tasklistHasImage(res.stdout, image);
}

/** isRecorderProcess for an ffmpeg.exe. */
export function isFfmpegProcess(pid: number | null): boolean {
  return isRecorderProcess(pid, "ffmpeg.exe");
}

/** Classify a recorder exit nobody asked for. Non-zero is a crash; the wgc
 * window-closed code is its own reason; a clean exit is the maxDurationSec cap
 * only once the cap could actually have been reached (#240). Pure. */
export function classifyUnrequestedExit(opts: {
  code: number | null;
  backend: "gdigrab" | "wgc";
  maxDurationSec: number;
  elapsedMs: number;
}): { status: "stopped" | "failed"; endReason: EndReason } {
  const { code, backend, maxDurationSec, elapsedMs } = opts;
  if (backend === "wgc" && code === WGC_WINDOW_CLOSED_EXIT) return { status: "stopped", endReason: "window_closed" };
  if (code !== 0 && code !== null) return { status: "failed", endReason: "crashed" };
  const capReached = maxDurationSec > 0 && elapsedMs >= maxDurationSec * 1000 - 2000;
  return { status: "stopped", endReason: capReached ? "max_duration" : "stopped" };
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

/** A lock whose holder pid is dead is taken over at once. One whose pid still
 * looks alive is taken over only past this age, since pids are recycled; a
 * read-merge-write takes milliseconds, so no live holder gets near it. */
export const LOCK_STALE_MS = 30_000;
/** How long a write waits for the lock before failing with an error. It never
 * writes without the lock: that is how records were lost (#235). */
export const LOCK_WAIT_MS = 15_000;

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

/** Take over a stale lock by renaming it aside rather than deleting it, then
 * confirm the file moved is the one judged stale (`raw`). Two waiters can judge
 * the same lock stale; a plain unlink by the slower one would delete the lock
 * the faster one just created. If that happened, put the live lock back.
 * Returns true only when the stale lock is gone, so a lock that cannot be
 * moved (held open elsewhere) is waited on, not retried in a tight loop. */
export function breakStaleLock(lock: string, raw: string): boolean {
  const aside = `${lock}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return false; // released, taken over, or held open meanwhile; the caller waits
  }
  let removed = true;
  try {
    if (readFileSync(aside, "utf8") !== raw) {
      removed = false;
      linkSync(aside, lock);
    }
  } catch {
    /* best effort: a new holder may already have recreated it */
  }
  try {
    unlinkSync(aside);
  } catch {
    /* best effort */
  }
  return removed;
}

/** Run `fn` holding an exclusive lockfile next to the registry (#55), so two
 * server instances cannot interleave a read-merge-write. The lock is an
 * O_EXCL-created file holding the owner's pid, a timestamp, and a nonce; a
 * stale lock (dead owner, or older than LOCK_STALE_MS) is taken over. A busy
 * lock is waited on with backoff for up to `waitMs`, then the call fails: it
 * never runs `fn` unlocked (#235). */
export function withRegistryLock<T>(registry: string, fn: () => T, waitMs = LOCK_WAIT_MS): T {
  const lock = `${registry}.lock`;
  const deadline = Date.now() + waitMs;
  let holderPid: number | undefined;
  let mine: string;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      mine = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: Math.random().toString(36).slice(2) });
      writeFileSync(fd, mine);
      closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // On Windows a lock that its holder just deleted, while another process
      // still had it open, lingers as "delete pending": creating it again fails
      // with EPERM/EACCES/EBUSY, not EEXIST. That means busy, so wait.
      const busy = code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!busy) {
        throw new ScreencastError(`Could not lock the session registry (${lock}): ${(err as Error).message}`);
      }
      if (code === "EEXIST") {
        let seen: { raw: string; holder: { pid?: number; at?: number } | null } | null;
        try {
          const raw = readFileSync(lock, "utf8");
          let holder: { pid?: number; at?: number } | null;
          try {
            holder = JSON.parse(raw);
          } catch {
            // Half-written: judge it by the file's age instead.
            holder = { at: statSync(lock).mtimeMs };
          }
          seen = { raw, holder };
        } catch {
          seen = null; // the holder just released it (or is mid-release): wait
        }
        if (seen) {
          holderPid = seen.holder?.pid;
          if (
            isLockStale(seen.holder, Date.now(), isAlive(seen.holder?.pid ?? null)) &&
            breakStaleLock(lock, seen.raw)
          ) {
            continue;
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new ScreencastError(
          `The session registry is busy: could not take ${lock} within ${waitMs / 1000} s` +
            `${holderPid !== undefined ? ` (held by process ${holderPid})` : ""}. Nothing was written.`,
          "Another screencast-mcp server is writing to the same registry. Retry; if no other server is running, delete the .lock file.",
        );
      }
      // Exponential backoff with jitter, capped so a waiter still notices the
      // release promptly when several instances queue up. Each wait blocks the
      // event loop (persist() is synchronous), so it stays well under 0.1 s.
      sleepSync(Math.min(50, 2 ** Math.min(attempt, 6)) * (0.5 + Math.random()));
    }
  }
  try {
    return fn();
  } finally {
    // Release only our own lock: if this holder stalled past LOCK_STALE_MS and
    // was taken over, the file is now someone else's (#185).
    try {
      if (readFileSync(lock, "utf8") === mine) unlinkSync(lock);
    } catch {
      /* already removed */
    }
  }
}

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  /** Fields this instance created or changed since its last write, by id. Only
   * these override the on-disk copy, field by field: every other record and
   * field is taken from disk, so a stale copy never undoes another instance's
   * update (#55, #235). */
  private pending = new Map<string, Partial<SessionRecord>>();
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
      process.stderr.write(`${(err as Error).message} Reading the session registry without the lock.\n`);
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
        `Could not save session ${id}: ${err instanceof Error ? err.message : String(err)}\n`,
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
    this.refresh();
    const reaped: string[] = [];
    const owners = new Map<number, ReturnType<typeof processInfo>>();
    const ownerAlive = (record: SessionRecord): boolean => {
      const pid = record.serverPid;
      if (pid === undefined || pid === process.pid || !isAlive(pid)) return false;
      // A live pid may be a crashed server's, recycled by another process
      // (#185): check it is still the same program, started before the record.
      if (!owners.has(pid)) owners.set(pid, processInfo(pid));
      return isSameServer(record, owners.get(pid) ?? null);
    };
    for (const record of this.records.values()) {
      if (record.status !== "recording") continue;
      // Never reap a recording owned by another still-live server instance:
      // that would kill its active capture. Leave the record untouched.
      if (isForeignLiveRecording(record, process.pid, ownerAlive(record))) {
        continue;
      }
      const alive = isAlive(record.pid);
      const verdict = classifyOrphan(record, alive);
      if (verdict.reaped && record.pid !== null) {
        if (isRecorderProcess(record.pid, expectedImage(record))) killPid(record.pid);
        reaped.push(record.id);
      }
      const patch: Partial<SessionRecord> = {
        status: verdict.status,
        ...(record.stoppedAt ? {} : { stoppedAt: new Date().toISOString() }),
        ...(verdict.status === "orphaned"
          ? { error: "Reaped on server restart (recording was interrupted)." }
          : {}),
      };
      this.records.set(record.id, { ...record, ...patch });
      this.pending.set(record.id, { ...this.pending.get(record.id), ...patch });
    }
    if (this.records.size > 0) this.persist();
    return reaped;
  }
}
