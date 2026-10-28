/**
 * Markers and chapters against real ffmpeg (#174): the FFMETADATA mux writes
 * chapters ffprobe reads back (what VLC/MPC show), soft subtitles land as a
 * toggleable mov_text/subrip track with the video stream-copied, pipeline
 * re-times markers through a trim and a speed change, and the chapters tool
 * builds chapters from markers and from scene changes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks, runCapture, runFfmpeg, probeMedia } from "../../utils/ffmpeg.js";
import {
  buildChapters,
  buildChaptersMuxArgs,
  ffmetadata,
  markerPoints,
  probeChapters,
  retimeMarkers,
  writeMarkers,
  type Marker,
} from "../../utils/chapters.js";
import { planPipeline } from "../../utils/pipeline.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);

// Outputs go under SCREENCAST_HOME, inside the allowed output dirs.
const home = mkdtempSync(join(tmpdir(), "sc-chapters-it-"));
process.env.SCREENCAST_HOME = home;
const p = (name: string) => join(home, name);

async function streams(path: string): Promise<Array<{ codec_type: string; codec_name: string; tags?: Record<string, string> }>> {
  const res = await runCapture(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_streams", path]);
  return JSON.parse(res.stdout).streams;
}

describe.skipIf(!AVAILABLE)("markers and chapters against real ffmpeg (#174)", { timeout: 120_000 }, () => {
  const av = p("av.mp4"); // 30 s testsrc + sine
  const scenes = p("scenes.mp4"); // 12 s red, 12 s blue, 12 s green
  const srt = p("subs.srt");
  let client: Client;

  beforeAll(async () => {
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p"];
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=30:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
      ...enc, "-c:a", "aac", "-shortest", av,
    ]);
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=12",
      "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=12",
      "-f", "lavfi", "-i", "color=c=green:s=320x240:r=30:d=12",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]", "-map", "[v]", ...enc, scenes,
    ]);
    writeFileSync(srt, "1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:12,000 --> 00:00:14,000\nSecond line\n");
    const { createServer } = await import("../../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "chapters-it", version: "0.0.0" });
    await client.connect(clientSide);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("muxes chapters and a soft mov_text track into mp4 with stream copy", async () => {
    const chapters = buildChapters([{ start: 0, title: "Intro" }, { start: 10, title: "Bug = here" }, { start: 20, title: "Fix" }], 30);
    const meta = p("meta.txt");
    writeFileSync(meta, ffmetadata(chapters));
    const out = p("chaptered.mp4");
    await runFfmpeg(buildChaptersMuxArgs(av, meta, out, { container: ".mp4", subtitles: srt, language: "eng" }));
    const got = await probeChapters(out);
    expect(got.map((c) => c.title)).toEqual(["Intro", "Bug = here", "Fix"]);
    expect(got[1]!.start).toBeCloseTo(10, 2);
    expect(got[2]!.end).toBeCloseTo(30, 1);
    const s = await streams(out);
    expect(s.map((x) => x.codec_type)).toEqual(expect.arrayContaining(["video", "audio", "subtitle"]));
    expect(s.find((x) => x.codec_type === "subtitle")?.codec_name).toBe("mov_text");
    expect(s.find((x) => x.codec_type === "subtitle")?.tags?.language).toBe("eng");
    expect(s.find((x) => x.codec_type === "video")?.codec_name).toBe("h264");
    expect((await probeMedia(out)).durationSec!).toBeCloseTo((await probeMedia(av)).durationSec!, 1);
  });

  it("muxes into mkv with the SRT copied as subrip", async () => {
    const meta = p("meta-mkv.txt");
    writeFileSync(meta, ffmetadata(buildChapters([{ start: 0, title: "A" }, { start: 15, title: "B" }], 30)));
    const out = p("chaptered.mkv");
    await runFfmpeg(buildChaptersMuxArgs(av, meta, out, { container: ".mkv", subtitles: srt }));
    expect((await probeChapters(out)).map((c) => [c.start, c.title])).toEqual([[0, "A"], [15, "B"]]);
    expect((await streams(out)).find((x) => x.codec_type === "subtitle")?.codec_name).toBe("subrip");
  });

  it("pipeline re-times markers through a trim and a speed change into chapters", async () => {
    const markers: Marker[] = [{ t: 2, label: "setup" }, { t: 12, label: "bug" }, { t: 20, label: "fix" }, { t: 28, label: "cut" }];
    const steps = [{ op: "trim" as const, start: 6, end: 26 }, { op: "speed" as const, factor: 2 }];
    const src = { width: 320, height: 240, fps: 30, durationSec: 30, hasAudio: true };
    const first = planPipeline(av, "unused.mp4", steps, src);
    const chapters = buildChapters(markerPoints(retimeMarkers(markers, first.timeOps)), first.durationSec!);
    expect(chapters.map((c) => [c.start, c.title])).toEqual([[0, "setup"], [3, "bug"], [7, "fix"]]);
    const meta = p("meta-pipe.txt");
    writeFileSync(meta, ffmetadata(chapters));
    const out = p("pipe.mp4");
    await runFfmpeg(planPipeline(av, out, steps, src, {}, "draft", { chaptersFile: meta }).args);
    const got = await probeChapters(out);
    expect(got.map((c) => c.title)).toEqual(["setup", "bug", "fix"]);
    expect(got[1]!.start).toBeCloseTo(3, 2);
    expect((await probeMedia(out)).durationSec!).toBeCloseTo(10, 0);
  });

  it("the pipeline tool carries the input's sidecar markers into the output (chapters: true)", async () => {
    writeMarkers(av, [{ t: 0, label: "start" }, { t: 15, label: "middle" }]);
    const res = await call("pipeline", { input: av, steps: [{ op: "trim", start: 10, end: 30 }], chapters: true, quality: "draft" });
    const out = res.outputPath as string;
    expect((await probeChapters(out)).map((c) => [c.start, c.title])).toEqual([[0, "start"], [5, "middle"]]);
    expect(res.markersPath).toBeTruthy();
  });

  it("the chapters tool writes marker chapters and returns YouTube text", async () => {
    writeMarkers(av, [{ t: 0, label: "Intro" }, { t: 10, label: "Bug appears" }, { t: 20, label: "Fixed" }]);
    const text = await call("chapters", { input: av, textOnly: true });
    expect(text.youtube).toBe("0:00 Intro\n0:10 Bug appears\n0:20 Fixed");
    expect(text.youtubeIssues).toBeUndefined();
    expect(text.outputPath).toBeUndefined();
    const res = await call("chapters", { input: av, subtitles: srt, output: "with-chapters.mp4" });
    const got = await probeChapters(res.outputPath as string);
    expect(got.map((c) => c.title)).toEqual(["Intro", "Bug appears", "Fixed"]);
    expect((await streams(res.outputPath as string)).some((x) => x.codec_name === "mov_text")).toBe(true);
    // Re-running on the result reads its embedded chapters when it has no sidecar.
    const again = await call("chapters", { input: res.outputPath, textOnly: true });
    expect(again.source).toBe("embedded chapters");
    expect(again.youtube).toBe(text.youtube);
  });

  it("the chapters tool finds chapters at scene changes", async () => {
    const res = await call("chapters", { input: scenes, from: "scenes", textOnly: true });
    expect((res.chapters as Array<{ start: number }>).map((c) => Math.round(c.start))).toEqual([0, 12, 24]);
  });
});
