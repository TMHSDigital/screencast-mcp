import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  MAX_REPLAY_SEC,
  MIN_REPLAY_SEC,
  REPLAY_SEGMENT_SEC,
  REPLAY_SLACK_SEGMENTS,
  buildReplayCutArgs,
  buildReplayJoinArgs,
  cleanupReplayDirs,
  concatList,
  finishReplay,
  liveSegmentFile,
  parseSegmentList,
  pickSegments,
  planReplayBuffer,
  replayWrap,
  segmentListPath,
  segmentOutputArgs,
  sliceEvents,
} from "../utils/replay.js";
import { buildCaptureArgs } from "../utils/targets.js";
import { SessionStore, type SessionRecord } from "../utils/sessions.js";
import { stopSession } from "../utils/lifecycle.js";
import type { InputEvent } from "../utils/events.js";

const scratch: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sc-replay-"));
  scratch.push(d);
  return d;
}
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("replay buffer planning (#197)", () => {
  it("sizes the ring to the buffer plus slack", () => {
    expect(replayWrap(60)).toBe(30 + REPLAY_SLACK_SEGMENTS);
    expect(replayWrap(5)).toBe(3 + REPLAY_SLACK_SEGMENTS);
    expect(replayWrap(10, 1)).toBe(10 + REPLAY_SLACK_SEGMENTS);
  });

  it("validates the buffer length and names a buf- directory", () => {
    const buf = planReplayBuffer(60);
    expect(buf).toMatchObject({ bufferSec: 60, segmentSec: REPLAY_SEGMENT_SEC, wrap: replayWrap(60) });
    expect(buf.dir).toMatch(/[\\/]replay[\\/]buf-[\w-]+$/);
    expect(planReplayBuffer(60).dir).not.toBe(buf.dir);
    expect(() => planReplayBuffer(MIN_REPLAY_SEC - 1)).toThrow(/replayBufferSec/);
    expect(() => planReplayBuffer(MAX_REPLAY_SEC + 1)).toThrow(/replayBufferSec/);
    expect(() => planReplayBuffer(10.5)).toThrow(/integer/);
  });
});

describe("segmentOutputArgs", () => {
  const capture = buildCaptureArgs(
    { kind: "region", x: 0, y: 0, w: 640, h: 480 },
    { fps: 15, quality: "draft", output: "C:/out/rec.mp4", maxDurationSec: 600 },
  );
  const buf = { dir: "C:/home/replay/buf-1", segmentSec: 2, wrap: 33 };
  const args = segmentOutputArgs(capture, buf);

  it("keeps the inputs, encoder, and cap but swaps the mp4 output for a segment ring", () => {
    expect(args).not.toContain("C:/out/rec.mp4");
    expect(args).not.toContain("-movflags");
    expect(args.slice(0, capture.indexOf("-movflags"))).toEqual(capture.slice(0, capture.indexOf("-movflags")));
    expect(args[args.indexOf("-t") + 1]).toBe("600");
    expect(args[args.indexOf("-f", args.indexOf("-c:v")) + 1]).toBe("segment");
    expect(args[args.indexOf("-segment_time") + 1]).toBe("2");
    expect(args[args.indexOf("-segment_wrap") + 1]).toBe("33");
    expect(args[args.indexOf("-segment_list_size") + 1]).toBe("33");
    expect(args[args.indexOf("-segment_list_type") + 1]).toBe("csv");
    expect(args[args.indexOf("-segment_format") + 1]).toBe("mpegts");
    expect(args[args.indexOf("-segment_format_options") + 1]).toBe("flush_packets=1");
    expect(args[args.indexOf("-segment_list") + 1]).toBe(segmentListPath(buf.dir));
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe("expr:gte(t,n_forced*2)");
    expect(args.at(-1)).toBe(join(buf.dir, "seg%05d.ts"));
  });

  it("escapes a % in the buffer directory for the segment pattern", () => {
    const out = segmentOutputArgs(capture, { ...buf, dir: "C:/100%/buf-1" });
    expect(out.at(-1)).toBe(join("C:/100%%/buf-1", "seg%05d.ts"));
  });
});

describe("segment list", () => {
  const csv = [
    "seg00004.ts,8.000000,10.000000",
    "seg00000.ts,10.000000,12.000000",
    "garbage",
    "seg00001.ts,12.000000,13.5", // completed, short
    "seg0000", // torn while being rewritten
  ].join("\r\n");

  it("parses entries oldest first and skips torn lines", () => {
    expect(parseSegmentList(csv)).toEqual([
      { file: "seg00004.ts", index: 4, start: 8, end: 10 },
      { file: "seg00000.ts", index: 0, start: 10, end: 12 },
      { file: "seg00001.ts", index: 1, start: 12, end: 13.5 },
    ]);
    expect(parseSegmentList("")).toEqual([]);
  });

  it("picks the newest segments that cover the request", () => {
    const entries = parseSegmentList(csv);
    expect(pickSegments(entries, 1).map((e) => e.index)).toEqual([1]);
    expect(pickSegments(entries, 1.5).map((e) => e.index)).toEqual([1]);
    expect(pickSegments(entries, 2).map((e) => e.index)).toEqual([0, 1]);
    expect(pickSegments(entries, 99).map((e) => e.index)).toEqual([4, 0, 1]);
    expect(pickSegments([], 10)).toEqual([]);
  });

  it("names the segment being written, wrapping around the ring", () => {
    const entries = parseSegmentList(csv);
    expect(liveSegmentFile(entries, 5)).toBe("seg00002.ts");
    expect(liveSegmentFile([{ file: "seg00004.ts", index: 4, start: 0, end: 2 }], 5)).toBe("seg00000.ts");
    expect(liveSegmentFile([], 5)).toBe("seg00000.ts");
  });
});

describe("join and cut args", () => {
  it("quotes concat entries", () => {
    expect(concatList(["C:/a/0.ts", "C:/it's/1.ts"])).toBe("file 'C:/a/0.ts'\nfile 'C:/it'\\''s/1.ts'\n");
  });

  it("joins by stream copy", () => {
    expect(buildReplayJoinArgs("list.txt", "joined.mp4")).toEqual([
      "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4",
    ]);
  });

  it("cuts by stream copy with an input seek, or re-encodes", () => {
    const copy = buildReplayCutArgs("joined.mp4", "out.mp4", { startSec: 3.14159 });
    expect(copy).toEqual(["-y", "-v", "error", "-ss", "3.142", "-i", "joined.mp4", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
    expect(buildReplayCutArgs("j.mp4", "o.mp4", { startSec: -1 })).toContain("0");
    const re = buildReplayCutArgs("j.mp4", "o.mp4", { startSec: 1, reencode: true, quality: "draft", audio: true });
    expect(re).toContain("libx264");
    expect(re).not.toContain("copy");
    expect(re[re.indexOf("-c:a") + 1]).toBe("aac");
    expect(buildReplayCutArgs("j.mp4", "o.mp4", { startSec: 1, reencode: true })).not.toContain("-c:a");
  });
});

describe("sliceEvents", () => {
  const ev = (t: number): InputEvent => ({ t, type: "down", x: 1, y: 2, inFrame: true, button: "left" });
  it("keeps the window's events re-timed to the clip", () => {
    expect(sliceEvents([ev(1), ev(10.25), ev(12), ev(15.5)], 10, 15).map((e) => e.t)).toEqual([0.25, 2]);
  });
});

describe("replay directories", () => {
  it("cleanup removes buf- directories no live session owns, and nothing else", () => {
    const root = tempDir();
    for (const name of ["buf-a", "buf-b", "notes"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "buf-a", "seg00000.ts"), "x");
    writeFileSync(join(root, "keep.txt"), "x");
    expect(cleanupReplayDirs([join(root, "buf-b")], root)).toBe(1);
    expect(existsSync(join(root, "buf-a"))).toBe(false);
    expect(existsSync(join(root, "buf-b"))).toBe(true);
    expect(existsSync(join(root, "notes"))).toBe(true);
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
    expect(cleanupReplayDirs([], join(root, "missing"))).toBe(0);
  });

  it("finishReplay discards without save, and keeps the buffer when a save fails", async () => {
    const dir = join(tempDir(), "buf-x");
    mkdirSync(dir);
    const buf = { dir, bufferSec: 10, segmentSec: 2, wrap: 8 };
    const failed = await finishReplay(buf, { save: true, output: join(dir, "..", "o.mp4") });
    expect(failed).toMatchObject({ saved: false, discarded: false });
    expect(failed.error).toMatch(/ffmpeg/);
    expect(existsSync(dir)).toBe(true);
    const failedEmpty = await finishReplay(buf, {
      save: true,
      output: join(dir, "..", "o.mp4"),
      tools: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
    });
    expect(failedEmpty.error).toMatch(/no footage/);
    expect(existsSync(dir)).toBe(true);
    expect(await finishReplay(buf, { save: false, output: "o.mp4" })).toEqual({ saved: false, discarded: true });
    expect(existsSync(dir)).toBe(false);
  });
});

describe("stopping a replay session", () => {
  it("discards the buffer by default and reports it", async () => {
    const root = tempDir();
    const dir = join(root, "buf-stop");
    mkdirSync(dir);
    writeFileSync(join(dir, "seg00000.ts"), "x");
    const store = new SessionStore(join(root, "sessions.json"));
    store.load();
    const rec: SessionRecord = {
      id: "rec-replay",
      target: "full",
      outputPath: join(root, "out.mp4"),
      fps: 30,
      quality: "standard",
      pid: null,
      status: "recording",
      startedAt: new Date().toISOString(),
      replay: { dir, bufferSec: 10, segmentSec: 2, wrap: 8 },
    };
    store.create(rec);
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: string | null; stdin: unknown };
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = {
      writable: true,
      write: () => setImmediate(() => {
        child.exitCode = 0;
        child.emit("exit", 0);
      }),
      end: () => {},
    };
    store.attachChild(rec.id, child as unknown as ChildProcess);
    const res = await stopSession(store, rec, { reason: "stopped", probe: async () => null });
    expect(res.replay).toEqual({ saved: false, discarded: true });
    expect(existsSync(dir)).toBe(false);
    expect(res.record?.status).toBe("stopped");
  });
});
