/**
 * Ownership and orphan rules for session records: which server instance owns
 * a record, whether a pid is still the recorder it spawned, and what an
 * unfinished record becomes at boot. Mostly pure. Split out of sessions.ts
 * (#360).
 */
import { basename } from "node:path";
import { isLive, type SessionRecord, type SessionStatus } from "./sessions.js";
import { isAlive, isRecorderProcess, processInfo } from "./processes.js";

/** Decide what an in-progress session becomes at boot, given liveness.
 * Pure: a still-alive pid is an orphan to be reaped; a dead one simply ended. */
export function classifyOrphan(
  record: SessionRecord,
  alive: boolean,
): { status: SessionStatus; reaped: boolean } {
  // A paused session has no process; its owner is gone, so it simply ended
  // (its parts stay on disk, #200).
  if (record.status === "paused") return { status: "stopped", reaped: false };
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
    isLive(record.status) &&
    record.serverPid !== undefined &&
    record.serverPid !== currentServerPid &&
    ownerAlive
  );
}

/** Why this server must not stop a record, or null when it may. Another live
 * instance's gdigrab/ddagrab capture can only be force-killed from here,
 * which leaves both processes finalizing (and joining paused segments) at
 * once; a wgc recording is handed over through its stop file instead (#182).
 * Pure (#286). */
export function foreignStopRefusal(
  record: SessionRecord,
  currentServerPid: number,
  ownerIsAlive: boolean,
): string | null {
  if (record.backend === "wgc" || !isForeignLiveRecording(record, currentServerPid, ownerIsAlive)) return null;
  return (
    `Recording ${record.id} belongs to another running screencast-mcp instance (pid ${record.serverPid}). ` +
    "Stop it from the client connected to that instance; closing that instance also finalizes it."
  );
}

/** True when the server instance that created a record is another process
 * that is still running. A live pid may be a crashed server's, recycled by
 * another process (#185), so it must still be the same program, started
 * before the record. `cache` memoizes processInfo across records. */
export function ownerAlive(
  record: SessionRecord,
  cache: Map<number, ReturnType<typeof processInfo>> = new Map(),
): boolean {
  const pid = record.serverPid;
  if (pid === undefined || pid === process.pid || !isAlive(pid)) return false;
  if (!cache.has(pid)) cache.set(pid, processInfo(pid));
  return isSameServer(record, cache.get(pid) ?? null);
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

/** The process image a record's pid should belong to: what it stored, else
 * what its backend spawns (the wgc recorder runs under node, #182). Pure. */
export function expectedImage(record: Pick<SessionRecord, "processImage" | "backend">): string {
  return record.processImage ?? (record.backend === "wgc" ? "node.exe" : "ffmpeg.exe");
}

/** False when what runs under a record's `pid` is provably not the recorder
 * it spawned: a different image, or a process created after the spawn (a
 * recycled pid). Details that cannot be read, or a record with no spawn time,
 * leave the decision to the image check. Pure (#284). */
export function isSameRecorder(
  record: Pick<SessionRecord, "pidSpawnedAt" | "processImage" | "backend">,
  running: { image: string; startMs: number } | null,
): boolean {
  if (!running) return true;
  if (running.image.toLowerCase() !== expectedImage(record).toLowerCase()) return false;
  const ref = record.pidSpawnedAt;
  return !(typeof ref === "number" && Number.isFinite(ref) && running.startMs > ref + OWNER_START_SLACK_MS);
}

/** True when a record's pid is still the recorder it started: the image
 * matches and the process is not newer than the spawn. Only then may the pid
 * be killed (its tree included: the wgc recorder's ffmpeg children). */
export function isOwnRecorder(
  record: Pick<SessionRecord, "pid" | "pidSpawnedAt" | "processImage" | "backend">,
): boolean {
  if (record.pid === null || !isRecorderProcess(record.pid, expectedImage(record))) return false;
  return record.pidSpawnedAt === undefined || isSameRecorder(record, processInfo(record.pid));
}
