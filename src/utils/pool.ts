/**
 * A small bounded-concurrency map for per-frame ffmpeg work (#290): each spawn
 * costs ~200 ms before decoding, so a serial loop over hundreds of frames uses
 * one core and takes minutes.
 */
import { availableParallelism } from "node:os";

/** Default parallel ffmpeg processes for frame extraction: a quarter of the
 * cores, at least 2 and at most 4. Each ffmpeg is itself multi-threaded, and
 * more processes than this only contend with the rest of the machine. */
export function frameConcurrency(cores: number = availableParallelism()): number {
  return Math.min(4, Math.max(2, Math.floor(cores / 4)));
}

/** Map `items` through `fn` with at most `limit` calls in flight. Results keep
 * the input order. On the first rejection no new calls start; the ones in
 * flight are awaited (so none outlives the call), then the error is thrown. */
export async function mapPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = frameConcurrency(),
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let error: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        if (!failed) {
          failed = true;
          error = err;
        }
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failed) throw error;
  return results;
}
