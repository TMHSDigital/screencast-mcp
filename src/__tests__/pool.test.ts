/** Bounded-concurrency map for frame extraction (#290). */
import { describe, it, expect } from "vitest";
import { frameConcurrency, mapPool } from "../utils/pool.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapPool (#290)", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([30, 5, 20, 1, 10, 2], async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await tick(ms);
      active--;
      return i * 10;
    }, 3);
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBe(3);
  });

  it("handles an empty list and a limit above the item count", async () => {
    expect(await mapPool([], async () => 1, 4)).toEqual([]);
    expect(await mapPool([1, 2], async (x) => x * 2, 10)).toEqual([2, 4]);
  });

  it("stops starting work after a failure and waits for calls in flight", async () => {
    const started: number[] = [];
    let finished = 0;
    const run = mapPool([0, 1, 2, 3, 4, 5], async (i) => {
      started.push(i);
      if (i === 1) throw new Error("boom");
      await tick(20);
      finished++;
      return i;
    }, 2);
    await expect(run).rejects.toThrow("boom");
    // Item 0 was in flight when 1 failed and finished before the throw.
    expect(finished).toBe(started.length - 1);
    expect(started.length).toBeLessThan(6);
  });

  it("picks a quarter of the cores, between 2 and 4", () => {
    expect(frameConcurrency(1)).toBe(2);
    expect(frameConcurrency(12)).toBe(3);
    expect(frameConcurrency(64)).toBe(4);
  });
});
