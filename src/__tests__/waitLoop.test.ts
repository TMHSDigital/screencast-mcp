/** wait_for_change's loop on scripted frames and a fake clock (#301). */
import { describe, it, expect } from "vitest";
import { waitLoop, type WaitLoopOptions } from "../utils/waitLoop.js";

const W = 64;
const H = 64;
const blank = () => new Uint8Array(W * H);
/** A frame with a bright square in the top-left corner. */
const marked = () => {
  const f = blank();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) f[y * W + x] = 255;
  return f;
};

/** Scripted grabs over a fake clock: each sleep advances time. */
function run(frames: Array<Uint8Array | Error | ((signal: AbortController) => Uint8Array)>, over: Partial<WaitLoopOptions> = {}) {
  let t = 0;
  let i = 0;
  const ctl = new AbortController();
  const grabs: number[] = [];
  const opts: WaitLoopOptions = {
    grab: async () => {
      grabs.push(t);
      const f = frames[Math.min(i++, frames.length - 1)]!;
      if (f instanceof Error) throw f;
      return typeof f === "function" ? f(ctl) : f;
    },
    mode: "change",
    width: W,
    height: H,
    diff: {},
    timeoutMs: 2000,
    settleMs: 500,
    intervalMs: 100,
    signal: ctl.signal,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...over,
  };
  return { result: waitLoop(opts), ctl, grabs, time: () => t };
}

describe("waitLoop (#301)", () => {
  it("change: returns changed with regions on the first differing frame", async () => {
    const r = run([blank(), blank(), blank(), marked(), blank()]);
    const res = await r.result;
    expect(res.outcome).toBe("changed");
    expect(res.regions.length).toBeGreaterThan(0);
    expect(r.grabs.length).toBe(4);
  });

  it("settle: settles after settleMs of identical frames and reports changedWhileWaiting", async () => {
    const r = run([blank(), marked(), blank(), blank(), blank(), blank(), blank(), blank(), blank()], { mode: "settle" });
    const res = await r.result;
    expect(res.outcome).toBe("settled");
    expect(res.everChanged).toBe(true);
    // The last change was at t=200 (the frame back to blank); still for 500 ms after.
    expect(r.time()).toBe(700);
  });

  it("settle: a frame that never changes settles with changedWhileWaiting false", async () => {
    const res = await run([blank()], { mode: "settle" }).result;
    expect(res.outcome).toBe("settled");
    expect(res.everChanged).toBe(false);
  });

  it("identical frames until the timeout return timeout", async () => {
    const r = run([blank()]);
    const res = await r.result;
    expect(res.outcome).toBe("timeout");
    expect(res.regions).toEqual([]);
    expect(r.time()).toBe(2000);
  });

  it("an abort before a grab returns cancelled", async () => {
    const r = run([blank(), (c) => (c.abort(), blank()), blank()]);
    expect((await r.result).outcome).toBe("cancelled");
  });

  it("a grab that fails because of the abort returns cancelled, not an error", async () => {
    const r = run([
      blank(),
      (c) => {
        c.abort();
        throw new Error("ffmpeg killed");
      },
    ]);
    expect((await r.result).outcome).toBe("cancelled");
  });

  it("a grab error without an abort is rethrown", async () => {
    await expect(run([blank(), new Error("grab failed")]).result).rejects.toThrow("grab failed");
  });
});
