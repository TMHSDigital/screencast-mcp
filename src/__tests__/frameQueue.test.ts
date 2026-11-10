/** One capture stream for wait_for_change (#292). */
import { describe, it, expect } from "vitest";
import { FrameQueue } from "../utils/frameQueue.js";
import { buildRawStreamArgs } from "../utils/diff.js";
import { parseTarget } from "../utils/targets.js";

const f = (n: number) => new Uint8Array([n]);

describe("FrameQueue (#292)", () => {
  it("gives each wait the next frame and drops frames nobody waits for", async () => {
    const q = new FrameQueue();
    q.push(f(1)); // nobody waiting: dropped
    const a = q.next(1000);
    q.push(f(2));
    q.push(f(3));
    expect([...(await a)]).toEqual([2]);
    const b = q.next(1000);
    q.push(f(4));
    expect([...(await b)]).toEqual([4]);
  });

  it("rejects waits when the capture fails or ends, now and later", async () => {
    const q = new FrameQueue();
    const pending = q.next(1000);
    q.fail(new Error("gdigrab died"));
    await expect(pending).rejects.toThrow("gdigrab died");
    await expect(q.next(1000)).rejects.toThrow("gdigrab died");
    const done = new FrameQueue();
    const waiting = done.next(1000);
    done.end();
    await expect(waiting).rejects.toThrow(/ended/);
    await expect(done.next(1000)).rejects.toThrow(/ended/);
  });

  it("times out a wait with no frame", async () => {
    await expect(new FrameQueue().next(20)).rejects.toThrow(/No frame/);
  });
});

describe("buildRawStreamArgs (#292)", () => {
  it("streams gray frames at the poll rate, flushed, without input probing", () => {
    const a = buildRawStreamArgs(parseTarget("region:0,0,400,300"), [], { width: 200, height: 150 }, 4);
    const s = a.join(" ");
    expect(s).toContain("-probesize 32 -analyzeduration 0 -f gdigrab -framerate 4");
    expect(s).toContain("scale=200:150:flags=area,format=gray");
    expect(s).toContain("-flush_packets 1 -f rawvideo -");
    expect(a).not.toContain("-frames:v");
  });
});
