/** Shutdown waits for start_recording calls in flight (#285). */
import { describe, it, expect } from "vitest";
import { beginStart, markShuttingDown, startsSettled } from "../context.js";

describe("start_recording shutdown guard (#285)", () => {
  it("settles at once with nothing in flight", async () => {
    expect(await startsSettled(10)).toBe(true);
  });

  it("waits for every in-flight start, and release is idempotent", async () => {
    const a = beginStart();
    const b = beginStart();
    let settled: boolean | null = null;
    const p = startsSettled(5_000).then((v) => (settled = v));
    a();
    a();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBeNull();
    b();
    await p;
    expect(settled).toBe(true);
  });

  it("gives up after the timeout when a start never finishes", async () => {
    const stuck = beginStart();
    expect(await startsSettled(20)).toBe(false);
    stuck();
  });

  it("refuses new starts once shutdown has begun", () => {
    markShuttingDown();
    expect(() => beginStart()).toThrow(/shutting down/);
  });
});
