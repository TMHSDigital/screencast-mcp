/** wait_for_change mode text (#318) on scripted frames, reads and a fake clock. */
import { describe, it, expect } from "vitest";
import { textWaitLoop, type TextWaitOptions } from "../utils/textWait.js";
import type { TextMatch } from "../utils/ocr.js";

const W = 64;
const H = 64;
const blank = () => new Uint8Array(W * H);
const marked = (v = 255) => {
  const f = blank();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) f[y * W + x] = v;
  return f;
};
const hit: TextMatch = { x: 1, y: 2, width: 30, height: 10, text: "Build succeeded", line: "Build succeeded" };

/** Scripted grabs and reads over a fake clock: each sleep advances time. */
function run(frames: Uint8Array[], reads: TextMatch[][], over: Partial<TextWaitOptions> = {}) {
  let t = 0;
  let i = 0;
  let r = 0;
  const ctl = new AbortController();
  const opts: TextWaitOptions = {
    grab: async () => frames[Math.min(i++, frames.length - 1)]!,
    read: async () => reads[Math.min(r++, reads.length - 1)]!,
    width: W,
    height: H,
    diff: {},
    timeoutMs: 2000,
    intervalMs: 100,
    gone: false,
    signal: ctl.signal,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...over,
  };
  return { result: textWaitLoop(opts), ctl, time: () => t };
}

describe("textWaitLoop (#318)", () => {
  it("returns at once when the text is already there", async () => {
    const { result, time } = run([blank()], [[hit]]);
    expect(await result).toMatchObject({ outcome: "matched", reads: 1, matches: [hit] });
    expect(time()).toBe(0);
  });

  it("reads again only after the screen changes", async () => {
    const still = blank();
    const { result } = run([still, still, still, marked(), marked()], [[], [hit]]);
    const res = await result;
    expect(res).toMatchObject({ outcome: "matched", reads: 2 });
  });

  it("a still screen costs one read for the whole wait", async () => {
    const { result } = run([blank()], [[]]);
    expect(await result).toMatchObject({ outcome: "timeout", reads: 1, matches: [] });
  });

  it("with gone, waits until the text disappears", async () => {
    const { result } = run([blank(), marked(), marked(), blank()], [[hit], [hit], []], { gone: true });
    expect(await result).toMatchObject({ outcome: "matched", reads: 3, matches: [] });
  });

  it("is cancelled by the signal", async () => {
    const { result, ctl } = run([blank()], [[]], {
      sleep: async () => {
        ctl.abort();
      },
    });
    expect((await result).outcome).toBe("cancelled");
  });
});
