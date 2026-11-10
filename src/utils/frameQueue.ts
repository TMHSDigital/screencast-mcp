/**
 * Hands the frames of one long-running capture to a poller (#292): `next()`
 * resolves with the first frame that arrives after the call, so each poll
 * sees fresh pixels, and frames nobody waits for are dropped.
 */
import { ScreencastError } from "./errors.js";

export class FrameQueue {
  private waiters: Array<{ resolve: (f: Uint8Array) => void; reject: (e: unknown) => void }> = [];
  private error: unknown = null;
  private ended = false;

  /** A frame arrived: give it to everyone waiting. */
  push(frame: Uint8Array): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w.resolve(frame);
  }

  /** The capture failed: reject current and later waits with `error`. */
  fail(error: unknown): void {
    if (this.error === null) this.error = error;
    this.rejectAll(this.error);
  }

  /** The capture exited cleanly: no more frames will come. */
  end(): void {
    this.ended = true;
    this.rejectAll(new ScreencastError("The screen capture ended unexpectedly."));
  }

  /** The next frame, rejecting after `timeoutMs` without one. */
  next(timeoutMs: number): Promise<Uint8Array> {
    if (this.error !== null) return Promise.reject(this.error);
    if (this.ended) return Promise.reject(new ScreencastError("The screen capture ended unexpectedly."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new ScreencastError(`No frame from the screen capture within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      const waiter = {
        resolve: (f: Uint8Array) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(waiter);
    });
  }

  private rejectAll(error: unknown): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w.reject(error);
  }
}
