/**
 * The cross-process lockfile that guards the session registry's
 * read-merge-write (#55, #235), plus a rename that retries Windows sharing
 * errors. Split out of sessions.ts (#360).
 */
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, linkSync } from "node:fs";
import { errorMessage, ScreencastError } from "./errors.js";
import { isAlive } from "./processes.js";

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
export function renameWithRetry(from: string, to: string): void {
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
        throw new ScreencastError(`Could not lock the session registry (${lock}): ${errorMessage(err)}`);
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
