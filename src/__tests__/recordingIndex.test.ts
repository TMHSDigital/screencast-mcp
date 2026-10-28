/**
 * Recording index and search (#245): keyframe planning, segment merging,
 * attaching events/markers/cues, the sidecar location, and search scoring
 * with secret masking. Pure, no ffmpeg.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INDEX_VERSION,
  MAX_MATCHES_PER_HIT,
  attach,
  cueTexts,
  eventTexts,
  fallbackIndexPath,
  fingerprintFile,
  indexSidecarPath,
  indexWritePath,
  keyframeTime,
  markerTexts,
  mergeSegments,
  parseIndex,
  planKeyframes,
  sameFingerprint,
  searchIndex,
  segmentsFrom,
  type IndexSegment,
  type RecordingIndex,
} from "../utils/recordingIndex.js";
import type { InputEvent } from "../utils/events.js";

function makeIndex(segments: IndexSegment[]): RecordingIndex {
  return {
    version: INDEX_VERSION,
    video: "rec.mp4",
    fingerprint: { size: 1, mtimeMs: 1, sample: "x" },
    durationSec: segments.at(-1)?.end ?? 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    sceneThreshold: 0.03,
    maxFrames: 120,
    framesRead: segments.length,
    ocr: true,
    segments,
  };
}

describe("planKeyframes", () => {
  it("keeps 0 and the strongest scene changes, in time order", () => {
    const changes = [
      { timeSec: 4, score: 0.5 },
      { timeSec: 2, score: 0.9 },
      { timeSec: 6, score: 0.1 },
    ];
    expect(planKeyframes(changes, 8, 3, 100)).toEqual([0, 2, 4]);
  });

  it("halves the longest gaps until none exceeds maxGap, within the cap", () => {
    expect(planKeyframes([], 40, 10, 10)).toEqual([0, 10, 20, 30]);
    // The cap wins over the gap rule.
    expect(planKeyframes([], 40, 2, 10)).toEqual([0, 20]);
  });

  it("ignores changes at or past the end", () => {
    expect(planKeyframes([{ timeSec: 9, score: 1 }], 5, 5, 100)).toEqual([0]);
  });
});

describe("segments", () => {
  it("run from each keyframe to the next, the last to the end", () => {
    expect(segmentsFrom([0, 2.5, 7], 10)).toEqual([
      { start: 0, end: 2.5 },
      { start: 2.5, end: 7 },
      { start: 7, end: 10 },
    ]);
  });

  it("grab their keyframe just inside, never past the end", () => {
    expect(keyframeTime({ start: 3, end: 10 })).toBe(3.25);
    expect(keyframeTime({ start: 3, end: 3.2 })).toBe(3.1);
  });

  it("merge neighbours that read the same text", () => {
    const merged = mergeSegments([
      { start: 0, end: 2, ocr: ["A"] },
      { start: 2, end: 4, ocr: ["A"] },
      { start: 4, end: 6, ocr: ["B"] },
      { start: 6, end: 8, ocr: ["A"] },
    ]);
    expect(merged.map((s) => [s.start, s.end, s.ocr.join()])).toEqual([
      [0, 4, "A"],
      [4, 6, "B"],
      [6, 8, "A"],
    ]);
  });
});

describe("event, marker, and cue text", () => {
  it("keeps clicks, shortcuts, typing, scrolls, and gaps, never moves or ups", () => {
    const events: InputEvent[] = [
      { t: 0.5, type: "move", x: 1, y: 1, inFrame: true },
      { t: 1, type: "down", x: 10.4, y: 20, inFrame: true, button: "left" },
      { t: 1.1, type: "up", x: 10, y: 20, inFrame: true, button: "left" },
      { t: 2, type: "key", x: 0, y: 0, inFrame: true, keys: "Ctrl+S" },
      { t: 3, type: "typing", x: 0, y: 0, inFrame: true, durationSec: 1.5 },
      { t: 4, type: "wheel", x: 5, y: 5, inFrame: true, delta: -2, axis: "vertical" },
      { t: 5, type: "gap", x: 0, y: 0, inFrame: true, durationSec: 3, reason: "input_not_seen" },
    ];
    expect(eventTexts(events)).toEqual([
      { t: 1, text: "click left at 10,20" },
      { t: 2, text: "shortcut Ctrl+S" },
      { t: 3, text: "typing 1.5 s" },
      { t: 4, text: "scroll down at 5,5" },
      { t: 5, text: "event gap (input_not_seen)" },
    ]);
  });

  it("flattens cue text and drops empty cues", () => {
    expect(cueTexts([{ start: 1, end: 2, text: "Hello\nworld" }, { start: 3, end: 4, text: "  " }])).toEqual([
      { t: 1, text: "Hello world" },
    ]);
    expect(markerTexts([{ t: 2, label: "Bug" }])).toEqual([{ t: 2, text: "Bug" }]);
  });

  it("attach each item to the segment holding its time", () => {
    const segs: IndexSegment[] = [
      { start: 0, end: 5, ocr: [] },
      { start: 5, end: 10, ocr: [], markers: [{ t: 1, text: "stale" }] },
    ];
    const out = attach(segs, [{ t: 7, text: "m2" }, { t: 4.9, text: "m1" }, { t: 10, text: "end" }], "markers");
    expect(out[0]!.markers).toEqual([{ t: 4.9, text: "m1" }]);
    expect(out[1]!.markers).toEqual([{ t: 7, text: "m2" }, { t: 10, text: "end" }]);
    // The input is untouched.
    expect(segs[1]!.markers).toEqual([{ t: 1, text: "stale" }]);
  });
});

describe("searchIndex", () => {
  const index = makeIndex([
    { start: 0, end: 4, ocr: ["File Edit View", "Untitled"] },
    { start: 4, end: 9, ocr: ["Save failed: disk full", "OK"], events: [{ t: 4.5, text: "shortcut Ctrl+S" }] },
    { start: 9, end: 12, ocr: ["export TOKEN=ghp_Abc123Def456Ghi789Jkl"], transcript: [{ t: 10.2, text: "now the save works" }] },
    { start: 12, end: 15, ocr: ["Saved", "disk check failed"], markers: [{ t: 13, text: "retry" }] },
  ]);

  it("finds a phrase with its segment times, best first", () => {
    const { hits, total } = searchIndex(index, "Save failed");
    expect(total).toBe(2);
    expect(hits[0]).toMatchObject({ start: 4, end: 9, t: 4, score: 2 });
    expect(hits[0]!.matches[0]).toEqual({ source: "screen", t: 4, text: "Save failed: disk full" });
    // Every word, spread over lines, scores lower.
    expect(hits[1]).toMatchObject({ start: 12, score: 1 });
  });

  it("tolerates OCR misreads", () => {
    expect(searchIndex(index, "SAVE FAI1ED").hits[0]?.start).toBe(4);
  });

  it("uses a cue, marker, or event time when that is what matched", () => {
    expect(searchIndex(index, "save works").hits[0]).toMatchObject({ t: 10.2, start: 9 });
    expect(searchIndex(index, "retry").hits[0]).toMatchObject({ t: 13, matches: [{ source: "marker" }] });
    expect(searchIndex(index, "ctrl+s").hits[0]).toMatchObject({ t: 4.5, matches: [{ source: "event" }] });
  });

  it("masks secrets in snippets but still finds them", () => {
    const { hits } = searchIndex(index, "ghp_", { regex: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matches[0]!.text).toBe("export [REDACTED]");
    expect(JSON.stringify(searchIndex(index, "TOKEN").hits)).not.toContain("Abc123");
  });

  it("can skip masking when asked", () => {
    expect(searchIndex(index, "TOKEN", { secretPattern: null }).hits[0]!.matches[0]!.text).toContain("ghp_Abc123");
  });

  it("limits hits and matches per hit", () => {
    const many = makeIndex([{ start: 0, end: 1, ocr: Array.from({ length: 9 }, (_, i) => `row ${i}`) }]);
    const { hits } = searchIndex(many, "row");
    expect(hits[0]!.matches).toHaveLength(MAX_MATCHES_PER_HIT);
    expect(searchIndex(index, "s", { limit: 1 }).hits).toHaveLength(1);
  });

  it("rejects an empty query and a bad regex", () => {
    expect(() => searchIndex(index, "  ")).toThrow(/empty/);
    expect(() => searchIndex(index, "(", { regex: true })).toThrow(/Invalid regex/);
  });
});

describe("index files", () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.SCREENCAST_ALLOWED_DIRS;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("sit next to the video, or under edits/indexes when that folder is not allowed", () => {
    expect(indexSidecarPath(join("a", "rec.final.mp4"))).toBe(join("a", "rec.final.index.json"));
    const allowed = mkdtempSync(join(tmpdir(), "sc-idx-ok-"));
    const outside = mkdtempSync(join(tmpdir(), "sc-idx-out-"));
    dirs.push(allowed, outside);
    process.env.SCREENCAST_ALLOWED_DIRS = allowed;
    const edits = join(allowed, "edits");
    expect(indexWritePath(join(allowed, "rec.mp4"), edits)).toBe(join(allowed, "rec.index.json"));
    const fallback = indexWritePath(join(outside, "rec.mp4"), edits);
    expect(fallback).toBe(fallbackIndexPath(join(outside, "rec.mp4"), edits));
    expect(fallback.startsWith(join(edits, "indexes"))).toBe(true);
    expect(fallbackIndexPath(join(allowed, "rec.mp4"), edits)).not.toBe(fallback);
  });

  it("parse only a current index", () => {
    expect(parseIndex(JSON.stringify(makeIndex([])))).not.toBeNull();
    expect(parseIndex(JSON.stringify({ ...makeIndex([]), version: 0 }))).toBeNull();
    expect(parseIndex("not json")).toBeNull();
  });

  it("fingerprint a file by size, mtime, and its ends", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-idx-fp-"));
    dirs.push(dir);
    const file = join(dir, "v.bin");
    writeFileSync(file, Buffer.alloc(200_000, 1));
    const a = fingerprintFile(file);
    expect(sameFingerprint(a, fingerprintFile(file))).toBe(true);
    const buf = Buffer.alloc(200_000, 1);
    buf[199_999] = 2;
    writeFileSync(file, buf);
    utimesSync(file, new Date(a.mtimeMs), new Date(a.mtimeMs));
    expect(sameFingerprint(a, fingerprintFile(file))).toBe(false);
  });
});
