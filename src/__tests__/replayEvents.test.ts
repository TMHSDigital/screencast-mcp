/**
 * A replay buffer's input event log stays bounded and save_replay reads only
 * the window it needs (#258).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookScript, rawLinesSince, readRawEventLog, rotatedLogPath } from "../utils/events.js";
import { REPLAY_EVENT_SLACK_SEC, replayEventRotateSec, resetReplaySegments } from "../utils/replay.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sc-replay-ev-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("event log rotation (#258)", () => {
  it("rotates a replay session's log a little slower than the buffer", () => {
    expect(replayEventRotateSec(30)).toBe(30 + REPLAY_EVENT_SLACK_SEC);
    expect(replayEventRotateSec(3600)).toBeGreaterThan(3600);
  });

  it("tells the helper how often to rotate, and never for a plain recording", () => {
    expect(buildHookScript("p", "masked", 1, replayEventRotateSec(60))).toContain("[ScEvents]::Rot=120000");
    expect(buildHookScript("p", "masked", 1)).toContain("[ScEvents]::Rot=0");
    expect(buildHookScript("p", "masked", 1)).not.toContain("__ROTATE__");
  });

  it("keeps the previous period beside the live log", () => {
    expect(rotatedLogPath("C:/b/events.raw")).toBe("C:/b/events.raw.1");
  });
});

describe("reading only the save window (#258)", () => {
  it("drops lines before the window, and torn or unstamped lines", () => {
    const raw = ["1000,move,1,1,", "2000,down,2,2,left", "garbage", "", "3000,hb,0,0,", "29"].join("\n");
    expect(rawLinesSince(raw, 2000).split("\n")).toEqual(["2000,down,2,2,left", "3000,hb,0,0,"]);
  });

  it("reads the rotated period first, then the live file", () => {
    const d = tmp();
    const raw = join(d, "events.raw");
    writeFileSync(rotatedLogPath(raw), "1000,move,1,1,\n5000,move,5,5,\n");
    writeFileSync(raw, "9000,down,9,9,left\n");
    expect(readRawEventLog(raw, 4000).split("\n")).toEqual(["5000,move,5,5,", "9000,down,9,9,left"]);
    expect(readRawEventLog(raw)).toContain("1000,move");
  });

  it("treats missing files as empty", () => {
    const d = tmp();
    expect(readRawEventLog(join(d, "events.raw"), 0)).toBe("");
    writeFileSync(join(d, "events.raw"), "7000,move,1,1,\n");
    expect(readRawEventLog(join(d, "events.raw"), 0)).toBe("7000,move,1,1,");
  });

  it("does work proportional to the window, not the session", () => {
    // A long session's live period holds far more than the window; only the
    // window's lines survive the filter.
    const lines = Array.from({ length: 50_000 }, (_, i) => `${i * 33},move,${i % 100},0,`);
    const kept = rawLinesSince(lines.join("\n"), 49_000 * 33).split("\n");
    expect(kept).toHaveLength(1000);
  });
});

describe("resetReplaySegments (#253)", () => {
  it("clears the ring and its list but keeps the event log", () => {
    const d = tmp();
    for (const f of ["seg00000.ts", "seg00001.ts", "segments.csv", "events.raw", "events.raw.1"]) writeFileSync(join(d, f), "x");
    resetReplaySegments({ dir: d });
    expect(readdirSync(d).sort()).toEqual(["events.raw", "events.raw.1"]);
  });
});
