/**
 * #359: PerfSampler's chunked PowerShell stdout parsing and lifecycle, with a
 * fake child and fake timers, and parsePerfJsonl's handling of torn lines.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawn: spawnMock }));

const { PerfSampler, parsePerfJsonl } = await import("../utils/perf.js");

type FakeChild = EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.kill = vi.fn();
  return c;
}
const MB = 1048576;

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PerfSampler (#359)", () => {
  it("joins a reading split across chunks and needs two readings for process CPU", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const s = new PerfSampler(1234, 100);
    s.start();
    child.stdout.emit("data", Buffer.from(`1000,500,${100 * MB}\r\n`));
    vi.advanceTimersByTime(100);
    // One reading only: memory is not set yet either (set with the CPU pair).
    expect(s.stop().at(-1)?.cpu).toBeUndefined();

    const child2 = fakeChild();
    spawnMock.mockReturnValue(child2);
    const t = new PerfSampler(1234, 100);
    t.start();
    child2.stdout.emit("data", Buffer.from(`1000,500,${100 * MB}\n20`));
    child2.stdout.emit("data", Buffer.from(`00,1`));
    child2.stdout.emit("data", Buffer.from(`500,${200 * MB}\r\n`));
    vi.advanceTimersByTime(100);
    const [sample] = t.stop();
    expect(sample?.rssMB).toBe(200);
    expect(sample?.cpu).toBeGreaterThan(0);
  });

  it("keeps sampling the system when the helper fails to start", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const s = new PerfSampler(1234, 100);
    s.start();
    child.emit("error", new Error("no powershell"));
    vi.advanceTimersByTime(250);
    const samples = s.stop();
    expect(samples).toHaveLength(2);
    expect(samples.every((x) => typeof x.sysCpu === "number" && x.cpu === undefined)).toBe(true);
  });

  it("stop() ends the interval and kills the helper", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const s = new PerfSampler(1234, 100);
    s.start();
    vi.advanceTimersByTime(100);
    const samples = s.stop();
    expect(child.kill).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(samples).toHaveLength(1);
  });
});

describe("parsePerfJsonl (#359)", () => {
  it("skips blank and torn lines and keeps the valid ones (CRLF)", () => {
    const text = `{"t":0,"sysCpu":5,"sysMem":40}\r\n\r\n{"t":1,"sysCpu":7\r\n{"t":2,"sysCpu":9,"sysMem":41}\r\n`;
    expect(parsePerfJsonl(text).map((s) => (s as { t: number }).t)).toEqual([0, 2]);
  });
});
