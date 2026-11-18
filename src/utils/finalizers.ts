/**
 * Per-session sidecar finalizers: work that finishes after ffmpeg exits (the
 * event log, app logs, perf samples). Readers wait on it with whenFinalized.
 */

// Event logs finish converting after ffmpeg exits. stopSession waits on this
// so stop_recording reports the finished log instead of racing it.
const finalizers = new Map<string, Promise<void>>();

/** Track work that finishes a session's sidecars; several (the event log,
 * app logs) combine into one wait. */
export function trackFinalizer(sessionId: string, work: Promise<void>): void {
  const prev = finalizers.get(sessionId);
  const done = prev ? Promise.all([prev, work]).then(() => {}) : work;
  finalizers.set(sessionId, done);
  void done.finally(() => {
    if (finalizers.get(sessionId) === done) finalizers.delete(sessionId);
  });
}

export async function whenFinalized(sessionId: string, timeoutMs = 10_000): Promise<void> {
  const done = finalizers.get(sessionId);
  if (!done) return;
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
}
