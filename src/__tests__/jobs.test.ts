import { describe, it, expect, vi } from "vitest";
import {
  jobTimeoutMs,
  partialPath,
  retargetOutput,
  createProgressParser,
  progressReporter,
  BASE_TIMEOUT_MS,
  UNKNOWN_DURATION_TIMEOUT_MS,
  JOB_TIMEOUT_ENV,
  type ToolExtra,
} from "../utils/jobs.js";
import { join } from "node:path";

describe("jobTimeoutMs (#81)", () => {
  it("never drops below the base for short media", () => {
    expect(jobTimeoutMs(5, {})).toBe(BASE_TIMEOUT_MS);
  });
  it("scales with duration for long media", () => {
    // A 60-minute recording gets 4 hours, not a fixed 15 minutes.
    expect(jobTimeoutMs(3600, {})).toBe(4 * 3600 * 1000);
  });
  it("uses a generous default when the duration is unknown", () => {
    expect(jobTimeoutMs(null, {})).toBe(UNKNOWN_DURATION_TIMEOUT_MS);
    expect(jobTimeoutMs(0, {})).toBe(UNKNOWN_DURATION_TIMEOUT_MS);
  });
  it("honours a positive integer env override and ignores junk", () => {
    expect(jobTimeoutMs(3600, { [JOB_TIMEOUT_ENV]: "1234" })).toBe(1234);
    expect(jobTimeoutMs(5, { [JOB_TIMEOUT_ENV]: "soon" })).toBe(BASE_TIMEOUT_MS);
  });
});

describe("partialPath / retargetOutput", () => {
  it("keeps the extension so ffmpeg picks the same muxer", () => {
    expect(partialPath(join("out", "clip.mp4"))).toBe(join("out", "clip.partial.mp4"));
    expect(partialPath(join("out", "anim.gif"))).toBe(join("out", "anim.partial.gif"));
  });
  it("replaces only the last occurrence of the output path", () => {
    expect(retargetOutput(["-i", "a.mp4", "-c", "copy", "a.mp4"], "a.mp4", "p.mp4")).toEqual([
      "-i", "a.mp4", "-c", "copy", "p.mp4",
    ]);
  });
  it("refuses args that do not contain the output", () => {
    expect(() => retargetOutput(["-i", "a.mp4"], "b.mp4", "p.mp4")).toThrow(/not in the ffmpeg arguments/);
  });
});

describe("createProgressParser", () => {
  it("reads out_time_us across chunk boundaries", () => {
    const parse = createProgressParser();
    expect(parse("frame=10\nout_time_us=150")).toBeNull();
    expect(parse("0000\nprogress=continue\n")).toBe(1.5);
    expect(parse("out_time_ms=3000000\n")).toBe(3);
  });
  it("ignores N/A values", () => {
    expect(createProgressParser()("out_time_us=N/A\n")).toBeNull();
  });
});

describe("progressReporter", () => {
  const fakeExtra = (token?: string) => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    return { extra: { _meta: token ? { progressToken: token } : undefined, sendNotification } as unknown as ToolExtra, sendNotification };
  };
  it("is undefined when the request carried no progress token", () => {
    expect(progressReporter(fakeExtra().extra)).toBeUndefined();
    expect(progressReporter(undefined)).toBeUndefined();
  });
  it("sends whole-percent progress notifications, without repeats", () => {
    const { extra, sendNotification } = fakeExtra("tok");
    const report = progressReporter(extra)!;
    report(0.101);
    report(0.104); // same whole percent: suppressed
    report(0.5);
    report(2); // clamped to 100
    expect(sendNotification.mock.calls.map((c) => c[0].params.progress)).toEqual([10, 50, 100]);
    expect(sendNotification.mock.calls[0]?.[0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "tok", total: 100 },
    });
  });
});
