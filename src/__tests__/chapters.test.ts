import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChapters,
  buildChaptersMuxArgs,
  cleanLabel,
  escapeFfmetadata,
  ffmetadata,
  insertMarker,
  markerTimeSec,
  markersPath,
  parseChaptersProbe,
  parseMarkerSidecar,
  readMarkers,
  retimeMarkers,
  scenePoints,
  transcriptPoints,
  writeMarkers,
  youtubeChapters,
  youtubeTimestamp,
  MAX_MARKERS,
  type Marker,
} from "../utils/chapters.js";
import { planPipeline } from "../utils/pipeline.js";

const SRC = { width: 320, height: 240, fps: 30, durationSec: 60, hasAudio: true };

describe("markers (#174)", () => {
  it("times a live marker from the first captured frame, never negative", () => {
    expect(markerTimeSec(1_000_000, 1_012_345)).toBe(12.345);
    expect(markerTimeSec(1_000_000, 999_000)).toBe(0);
  });

  it("inserts in time order, cleans the label, and caps the count", () => {
    let list: Marker[] = [];
    list = insertMarker(list, { t: 5, label: "b" });
    list = insertMarker(list, { t: 1.23456, label: "  a \n first " });
    list = insertMarker(list, { t: 5, label: "c" });
    expect(list.map((m) => [m.t, m.label])).toEqual([[1.235, "a first"], [5, "b"], [5, "c"]]);
    expect(() => insertMarker(list, { t: 1, label: "   " })).toThrow(/label/);
    expect(() => insertMarker(list, { t: -1, label: "x" })).toThrow(/non-negative/);
    const full = Array.from({ length: MAX_MARKERS }, (_, i) => ({ t: i, label: "m" }));
    expect(() => insertMarker(full, { t: 1, label: "x" })).toThrow(/at most/);
    expect(cleanLabel("x".repeat(300)).length).toBe(200);
  });

  it("names the sidecar after the video and round-trips it", () => {
    expect(markersPath("C:\\rec\\demo.mp4")).toBe("C:\\rec\\demo.markers.json");
    const dir = mkdtempSync(join(tmpdir(), "sc-markers-"));
    try {
      const video = join(dir, "v.mp4");
      expect(readMarkers(video)).toEqual([]);
      writeMarkers(video, [{ t: 2, label: "two" }, { t: 1, label: "one" }], "rec-1");
      expect(readMarkers(video).map((m) => m.label)).toEqual(["one", "two"]);
      expect(JSON.parse(readFileSync(markersPath(video), "utf8")).sessionId).toBe("rec-1");
      writeFileSync(markersPath(video), "not json");
      expect(readMarkers(video)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(parseMarkerSidecar(JSON.stringify([{ t: 1, label: "a" }, { t: "x" }, { label: "no t" }]))).toEqual([{ t: 1, label: "a" }]);
  });

  it("re-times through trims and speed, carrying the chapter running at a trim start", () => {
    const marks: Marker[] = [
      { t: 0, label: "setup" },
      { t: 30, label: "bug" },
      { t: 50, label: "fix" },
      { t: 70, label: "after" },
    ];
    // Keep 20-60: setup is still running at 20, so it opens the result.
    expect(retimeMarkers(marks, [{ op: "trim", start: 20, end: 60 }])).toEqual([
      { t: 0, label: "setup" },
      { t: 10, label: "bug" },
      { t: 30, label: "fix" },
    ]);
    // A marker exactly at the trim start wins over the carried one.
    expect(retimeMarkers(marks, [{ op: "trim", start: 30, end: 60 }]).map((m) => [m.t, m.label])).toEqual([[0, "bug"], [20, "fix"]]);
    // Speed after a trim divides the trimmed times; order matters.
    expect(retimeMarkers(marks, [{ op: "trim", start: 20, end: 60 }, { op: "speed", factor: 2 }]).map((m) => m.t)).toEqual([0, 5, 15]);
    expect(retimeMarkers(marks, [{ op: "speed", factor: 2 }, { op: "trim", start: 10, end: 30 }]).map((m) => [m.t, m.label])).toEqual([
      [0, "setup"],
      [5, "bug"],
      [15, "fix"],
    ]);
  });
});

describe("chapters (#174)", () => {
  it("covers the video, opens with an intro, merges close points and a short tail", () => {
    const ch = buildChapters(
      [
        { start: 25, title: "Bug" },
        { start: 12, title: "Setup" },
        { start: 25.5, title: "too close" },
        { start: 58, title: "tail" },
        { start: 99, title: "past the end" },
      ],
      60,
      { minChapterSec: 5 },
    );
    expect(ch).toEqual([
      { start: 0, end: 12, title: "Intro" },
      { start: 12, end: 25, title: "Setup" },
      { start: 25, end: 60, title: "Bug" },
    ]);
    // A first point near 0 moves to 0 instead of adding an intro.
    expect(buildChapters([{ start: 0.4, title: "Start" }, { start: 30, title: "B" }], 60)[0]).toEqual({ start: 0, end: 30, title: "Start" });
    expect(buildChapters([], 60)).toEqual([]);
  });

  it("formats YouTube timestamps and flags the rules it breaks", () => {
    expect(youtubeTimestamp(0, false)).toBe("0:00");
    expect(youtubeTimestamp(75.9, false)).toBe("1:15");
    expect(youtubeTimestamp(3725, true)).toBe("1:02:05");
    expect(youtubeTimestamp(65, true)).toBe("0:01:05");
    const good = buildChapters([{ start: 0, title: "A" }, { start: 20, title: "B" }, { start: 40, title: "C" }], 60);
    expect(youtubeChapters(good, 60)).toEqual({ text: "0:00 A\n0:20 B\n0:40 C", issues: [] });
    const bad = youtubeChapters(buildChapters([{ start: 0, title: "A" }, { start: 5, title: "B" }], 60), 60);
    expect(bad.issues.join(" ")).toMatch(/at least 3 chapters/);
    expect(bad.issues.join(" ")).toMatch(/"A"/);
  });

  it("writes an escaped FFMETADATA file in milliseconds", () => {
    expect(escapeFfmetadata("a=b;c#d\\e")).toBe("a\\=b\\;c\\#d\\\\e");
    expect(ffmetadata([{ start: 0, end: 1.5, title: "Intro = start" }])).toBe(
      ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=Intro \\= start\n",
    );
  });

  it("picks the strongest, spaced scene changes as chapters", () => {
    const scenes = [
      { timeSec: 3, score: 0.9 },
      { timeSec: 15, score: 0.5 },
      { timeSec: 16, score: 0.8 },
      { timeSec: 40, score: 0.3 },
      { timeSec: 41, score: 0.2 },
    ];
    expect(scenePoints(scenes, 10, 12)).toEqual([
      { start: 0, title: "Scene 1" },
      { start: 16, title: "Scene 2" },
      { start: 40, title: "Scene 3" },
    ]);
    expect(scenePoints(scenes, 10, 2)).toHaveLength(2);
  });

  it("splits a transcript at pauses once a section is long enough", () => {
    const cues = [
      { start: 1, end: 4, text: "Welcome to the <i>demo</i> of the thing" },
      { start: 5, end: 9, text: "more intro" },
      { start: 20, end: 24, text: "Now we open the settings page and change every single option there is to change" },
      { start: 24.5, end: 30, text: "no pause, same section" },
      { start: 70, end: 75, text: "Wrap up" },
    ];
    const pts = transcriptPoints(cues, { gapSec: 2, minChapterSec: 10 });
    expect(pts.map((p) => p.start)).toEqual([1, 20, 70]);
    expect(pts[0]?.title).toBe("Welcome to the demo of the thing");
    expect(pts[1]?.title.endsWith("…")).toBe(true);
    expect(pts[1]!.title.length).toBeLessThanOrEqual(61);
  });

  it("muxes with stream copy, chapters from input 1, soft subs as mov_text in mp4", () => {
    const mp4 = buildChaptersMuxArgs("in.mp4", "meta.txt", "out.mp4", { container: ".mp4", subtitles: "s.srt", language: "eng" });
    expect(mp4.join(" ")).toBe(
      "-y -i in.mp4 -f ffmetadata -i meta.txt -i s.srt -map 0:v -map 0:a? -map 2:s:0 -map_metadata 0 -map_chapters 1 " +
        "-c copy -c:s mov_text -metadata:s:s:0 language=eng -movflags +faststart out.mp4",
    );
    const mkv = buildChaptersMuxArgs("in.mkv", "meta.txt", "out.mkv", { container: ".mkv" });
    expect(mkv).toContain("0:s?");
    expect(mkv).not.toContain("-movflags");
    expect(buildChaptersMuxArgs("a.mkv", "m", "b.mkv", { container: ".mkv", subtitles: "s.ass" })).toEqual(expect.arrayContaining(["-c:s", "copy"]));
  });

  it("parses ffprobe -show_chapters", () => {
    const json = JSON.stringify({
      chapters: [
        { start_time: "0.000000", end_time: "12.500000", tags: { title: "Intro" } },
        { start_time: "12.500000", end_time: "30.000000" },
        { start_time: "bad", end_time: "1" },
      ],
    });
    expect(parseChaptersProbe(json)).toEqual([
      { start: 0, end: 12.5, title: "Intro" },
      { start: 12.5, end: 30, title: "Chapter 2" },
    ]);
    expect(parseChaptersProbe("nope")).toEqual([]);
  });
});

describe("pipeline chapters (#174)", () => {
  it("records trims and speed changes as time ops", () => {
    const plan = planPipeline("in.mp4", "out.mp4", [
      { op: "trim", start: 10, end: 50 },
      { op: "scale", width: 160 },
      { op: "speed", factor: 2 },
    ], SRC);
    expect(plan.timeOps).toEqual([{ op: "trim", start: 10, end: 50 }, { op: "speed", factor: 2 }]);
    expect(plan.args).not.toContain("-map_chapters");
  });

  it("adds the FFMETADATA file as the last input and maps chapters from it", () => {
    const plan = planPipeline("in.mp4", "out.mp4", [{ op: "trim", start: 5, end: 25 }], SRC, {}, "standard", { chaptersFile: "ch.txt" });
    const a = plan.args;
    const meta = a.indexOf("ch.txt");
    expect(a.slice(meta - 3, meta + 1)).toEqual(["-f", "ffmetadata", "-i", "ch.txt"]);
    expect(a[a.indexOf("-map_chapters") + 1]).toBe("1");
    expect(a.at(-1)).toBe("out.mp4");
    // The leading-trim input seek stays on the video input, not the metadata.
    expect(a.indexOf("-ss")).toBeLessThan(a.indexOf("in.mp4"));
  });
});
