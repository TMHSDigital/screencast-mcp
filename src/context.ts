/** Process-wide singletons shared by every tool. */
import { SessionStore } from "./utils/sessions.js";
import { registryPath } from "./utils/paths.js";
import { ScreencastError } from "./utils/errors.js";

let store: SessionStore | null = null;

/** Lazily construct and load the on-disk session registry. */
export function getStore(): SessionStore {
  if (!store) {
    store = new SessionStore(registryPath());
    store.load();
  }
  return store;
}

let shuttingDown = false;

/** Set once shutdown begins: from then on nothing writes to the client, whose
 * pipe may already be closed (#229). */
export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/* start_recording calls in flight (#285). A start spends a second or two in
 * awaits (consent, device and encoder checks, settling) before its session is
 * registered; shutdown waits for those so it can stop what they spawned. */
let startsInFlight = 0;
let onStartsIdle: Array<() => void> = [];

/** Register a start_recording call. Throws once shutdown has begun; the
 * returned release must run when the call finishes (idempotent). */
export function beginStart(): () => void {
  if (shuttingDown) throw new ScreencastError("The server is shutting down; the recording was not started.");
  startsInFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    startsInFlight--;
    if (startsInFlight === 0) {
      const waiters = onStartsIdle;
      onStartsIdle = [];
      for (const w of waiters) w();
    }
  };
}

/** Resolves true once no start_recording call is in flight, or false after
 * `timeoutMs`. */
export function startsSettled(timeoutMs: number): Promise<boolean> {
  if (startsInFlight === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    onStartsIdle.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
