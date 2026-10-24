/**
 * ffmpeg-backed integration tests for the edit / watch / produce builders.
 *
 * The unit tests only assert argument strings, so a builder can emit args that
 * look right yet produce the wrong media (#75 trim length, #77 music_bed
 * loudness). These tests run the REAL builders through ffmpeg against fixtures
 * generated on the fly with lavfi (nothing binary is committed) and assert on
 * the probed result.
 *
 * They run whenever ffmpeg + ffprobe are available and are skipped otherwise.
 * Set REQUIRE_FFMPEG=1 (CI's ubuntu leg does) to turn a missing ffmpeg into a
 * failure instead of a silent skip.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryWorks, runCapture, runFfmpeg, runFfmpegBuffer, probeMedia } from "../../utils/ffmpeg.js";
import {
  buildTrimArgs,
  buildClipArgs,
  buildSpeedArgs,
  buildCropArgs,
  buildScaleArgs,
  buildExtractAudioArgs,
  buildRedactArgs,
  buildSampleByFpsArgs,
  planFpsSampling,
  buildSceneScanArgs,
  parseSceneScan,
  pickSceneFrames,
} from "../../utils/media.js";
import {
  buildXfadeArgs,
  buildAssembleArgs,
  buildMusicBedArgs,
  buildTitleCardArgs,
  buildReframeArgs,
  buildExportPresetArgs,
} from "../../utils/produce.js";
import { bundledFontPath } from "../../utils/fonts.js";
import { encodeInlineImages } from "../../utils/images.js";
import { animLadder, buildAnimArgs } from "../../utils/anim.js";
import { buildArrowImageArgs, buildCalloutArgs } from "../../utils/callout.js";
import { analysisSize, diffFrames, buildRawFrameArgs, buildSsimArgs, parseSsim } from "../../utils/diff.js";
import { evenTimes, formatTimecode, sheetGrid, buildTileArgs, buildSheetArgs, buildPosterArgs } from "../../utils/sheet.js";
import { runEditJob, partialPath, type ToolExtra } from "../../utils/jobs.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);
const REQUIRED = !!process.env.REQUIRE_FFMPEG;

describe("ffmpeg availability", () => {
  it.runIf(REQUIRED)("ffmpeg and ffprobe are installed (REQUIRE_FFMPEG=1)", () => {
    expect(AVAILABLE).toBe(true);
  });
});

/** Mean volume (dB) of a file's audio via volumedetect. */
async function meanVolume(path: string): Promise<number> {
  const res = await runCapture(FFMPEG, ["-hide_banner", "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
  const m = res.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  if (!m) throw new Error(`no volumedetect output for ${path}`);
  return Number(m[1]);
}

/** Average luma (0-255) of a rectangle of the frame at `t` seconds. */
function regionLuma(path: string, t: number, x: number, y: number, w: number, h: number): number {
  const res = spawnSync(FFMPEG, [
    "-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
    "-vf", `crop=${w}:${h}:${x}:${y},scale=1:1,format=gray`,
    "-f", "rawvideo", "-",
  ]);
  return res.stdout && res.stdout.length > 0 ? res.stdout[0] : -1;
}

describe.skipIf(!AVAILABLE)("edit and produce builders against real ffmpeg", { timeout: 120_000 }, () => {
  // The apostrophe in the fixture dir also exercises filtergraph path escaping
  // (#87): title_card's text file lands in here.
  let dir = "";
  let av = ""; // 10s 320x240 testsrc + 440Hz sine, keyframe every second
  let vOnly = ""; // 4s video-only
  let short = ""; // 4s with audio
  let music = ""; // 3s 880Hz sine

  const p = (name: string) => join(dir, name);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "screencast-it-O'Brien-"));
    av = p("av.mp4");
    vOnly = p("vonly.mp4");
    short = p("short.mp4");
    music = p("music.wav");
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p"];
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=10:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
      ...enc, "-c:a", "aac", "-shortest", av,
    ]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=30", ...enc, vOnly]);
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc2=duration=4:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=4",
      ...enc, "-c:a", "aac", "-shortest", short,
    ]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=3", music]);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("trim start+end yields end - start seconds (#75)", async () => {
    const out = p("trim-end.mp4");
    await runFfmpeg(buildTrimArgs(av, out, { start: 3, end: 6 }));
    expect((await probeMedia(out)).durationSec!).toBeCloseTo(3, 0);
  });

  it("trim start+duration yields duration seconds", async () => {
    const out = p("trim-dur.mp4");
    await runFfmpeg(buildTrimArgs(av, out, { start: 2, duration: 4 }));
    expect((await probeMedia(out)).durationSec!).toBeCloseTo(4, 0);
  });

  it("clip is frame-accurate", async () => {
    const out = p("clip.mp4");
    await runFfmpeg(buildClipArgs(av, out, { start: 2.5, end: 5 }));
    expect(Math.abs((await probeMedia(out)).durationSec! - 2.5)).toBeLessThan(0.15);
  });

  it("speed 2x halves the duration and keeps audio", async () => {
    const out = p("speed.mp4");
    await runFfmpeg(buildSpeedArgs(av, out, 2, true));
    const info = await probeMedia(out);
    expect(Math.abs(info.durationSec! - 5)).toBeLessThan(0.2);
    expect(info.audioCodec).toBe("aac");
  });

  it("crop and scale produce the requested dimensions", async () => {
    const cropped = p("crop.mp4");
    await runFfmpeg(buildCropArgs(av, cropped, { x: 10, y: 20, width: 100, height: 80 }, { width: 320, height: 240 }));
    const c = await probeMedia(cropped);
    expect([c.width, c.height]).toEqual([100, 80]);

    const scaled = p("scale.mp4");
    await runFfmpeg(buildScaleArgs(av, scaled, { width: 160 }));
    const s = await probeMedia(scaled);
    expect([s.width, s.height]).toEqual([160, 120]);
  });

  it("reframe and export_preset hit the platform canvas", async () => {
    const reframed = p("reframe.mp4");
    await runFfmpeg(buildReframeArgs(vOnly, reframed, "1:1", "pad", "draft"));
    const r = await probeMedia(reframed);
    expect([r.width, r.height]).toEqual([1080, 1080]);

    const exported = p("export.mp4");
    await runFfmpeg(buildExportPresetArgs(short, exported, "x"));
    const e = await probeMedia(exported);
    expect([e.width, e.height]).toEqual([1920, 1080]);
    expect(e.audioCodec).toBe("aac");
  });

  it("extract_audio writes an audio-only file", async () => {
    const out = p("audio.mp3");
    await runFfmpeg(buildExtractAudioArgs(av, out, "mp3"));
    const info = await probeMedia(out);
    expect(info.audioCodec).toBe("mp3");
    expect(info.videoCodec).toBeNull();
  });

  it("xfade overlaps the clips by the transition duration", async () => {
    const out = p("xfade.mp4");
    await runFfmpeg(buildXfadeArgs(short, short, 4, out, { width: 320, height: 240, duration: 1, quality: "draft" }, true));
    const info = await probeMedia(out);
    expect(Math.abs(info.durationSec! - 7)).toBeLessThan(0.2);
    expect(info.audioCodec).toBe("aac");
  });

  it("assemble_highlights keeps audio when only some clips have it", async () => {
    const out = p("assemble.mp4");
    await runFfmpeg(
      buildAssembleArgs([short, vOnly], [4, 4], out, { width: 320, height: 240, quality: "draft" }, [true, false]),
    );
    const info = await probeMedia(out);
    expect(Math.abs(info.durationSec! - 8)).toBeLessThan(0.2);
    expect(info.audioCodec).toBe("aac");
  });

  it("music_bed leaves the original track at unity level (#77)", async () => {
    const out = p("bed.mp4");
    await runFfmpeg(buildMusicBedArgs(av, music, out, 10, true, { musicVolume: 0 }));
    const [src, mixed] = await Promise.all([meanVolume(av), meanVolume(out)]);
    expect(Math.abs(mixed - src)).toBeLessThan(0.5);
  });

  it("title_card renders from a path containing an apostrophe (#87)", async () => {
    const textFile = p("title.txt");
    writeFileSync(textFile, "It's a title: 100%");
    const out = p("title.mp4");
    await runFfmpeg(buildTitleCardArgs(textFile, bundledFontPath("bold"), out, { width: 320, height: 240, duration: 1, quality: "draft" }));
    const info = await probeMedia(out);
    expect([info.width, info.height]).toEqual([320, 240]);
    // The text must actually be drawn: a "%" used to make drawtext render
    // nothing at all (it expands %{...} sequences), leaving a blank card.
    expect(regionLuma(out, 0.5, 20, 100, 280, 40)).toBeGreaterThan(15);
  });

  it("callout draws a box, a text label with a %, and an arrow, each only in its window (#121)", async () => {
    const arrow = p("arrow.png");
    const items = [
      { type: "box" as const, x: 10, y: 10, width: 60, height: 40, fill: true, color: "white", from: 1, to: 3 },
      { type: "text" as const, x: 120, y: 150, text: "100% done", size: 24, from: 1, to: 3 },
      { type: "arrow" as const, x1: 200, y1: 60, x2: 300, y2: 60, color: "white", thickness: 10, from: 1, to: 3 },
    ];
    await runFfmpeg(buildArrowImageArgs(items[2], arrow));
    const label = p("label.txt");
    writeFileSync(label, items[1].text);
    const out = p("callout.mp4");
    await runFfmpeg(buildCalloutArgs(vOnly, out, items, { fontFile: bundledFontPath("bold"), textFiles: [null, label, null], arrowFiles: [null, null, arrow] }, "draft"));
    // Inside the window every annotation is visible ...
    expect(regionLuma(out, 2, 20, 20, 40, 20)).toBeGreaterThan(220); // filled white box
    expect(regionLuma(out, 2, 240, 55, 30, 10)).toBeGreaterThan(200); // arrow shaft at y=60
    // ... and the source shows through before it starts.
    expect(regionLuma(out, 0.3, 20, 20, 40, 20)).toBeLessThan(220);
    expect((await probeMedia(out)).durationSec!).toBeCloseTo(4, 0);
  });

  it("redact_region box fills the region solid", async () => {
    const out = p("redact.mp4");
    await runFfmpeg(buildRedactArgs(av, out, [{ x: 0, y: 0, width: 64, height: 64 }], {}, { width: 320, height: 240 }));
    // testsrc is bright/colourful in the top-left; a solid black box reads ~0.
    expect(regionLuma(out, 1, 8, 8, 48, 48)).toBeLessThan(10);
    expect(regionLuma(av, 1, 8, 8, 48, 48)).toBeGreaterThan(20);
  });

  it("fps sampling honours a clamped plan and the -frames:v backstop (#80)", async () => {
    const plan = planFpsSampling((await probeMedia(av)).durationSec, 30, 5);
    expect(plan.clamped).toBe(true);
    const framesDir = p("capped");
    mkdirSync(framesDir);
    await runFfmpeg(buildSampleByFpsArgs(av, plan.fps, join(framesDir, "f_%05d.png"), 5));
    const n = readdirSync(framesDir).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);

    // Backstop alone: an unclamped 30 fps request still stops at the cap.
    const backstopDir = p("backstop");
    mkdirSync(backstopDir);
    await runFfmpeg(buildSampleByFpsArgs(av, 30, join(backstopDir, "f_%05d.png"), 3));
    expect(readdirSync(backstopDir)).toHaveLength(3);
  });

  it("a contact sheet tiles labelled frames into one image of the expected size (#115)", async () => {
    const work = p("sheet-work");
    mkdirSync(work);
    const times = evenTimes(10, 6);
    for (let i = 0; i < times.length; i++) {
      const label = join(work, `l${i}.txt`);
      writeFileSync(label, formatTimecode(times[i]));
      await runFfmpeg(buildTileArgs(av, times[i], join(work, `tile_${String(i).padStart(3, "0")}.png`), 160, bundledFontPath("bold"), label));
    }
    const grid = sheetGrid(times.length);
    const sheet = p("sheet.png");
    await runFfmpeg(buildSheetArgs(join(work, "tile_%03d.png"), grid, sheet));
    const info = await probeMedia(sheet);
    // 3 columns x 160 px + 2 x 4 px padding + 2 x 4 px margin; 320x240 source -> 120 px tall tiles.
    expect([grid.columns, grid.rows]).toEqual([3, 2]);
    expect(info.width).toBe(3 * 160 + 2 * 4 + 2 * 4);
    expect(info.height).toBe(2 * 120 + 1 * 4 + 2 * 4);
  });

  it("a poster frame is a single image capped at the requested width (#115)", async () => {
    const poster = p("poster.png");
    await runFfmpeg(buildPosterArgs(av, 10, poster, 200));
    const info = await probeMedia(poster);
    expect([info.width, info.height]).toEqual([200, 150]);
  });

  it("GIF and WebP exports come out as animated images, smaller down the ladder (#124)", async () => {
    const ladder = animLadder("gif", 12, 320);
    const big = p("big.gif");
    const small = p("small.gif");
    await runFfmpeg(buildAnimArgs(av, big, "gif", ladder[0], { duration: 3 }));
    await runFfmpeg(buildAnimArgs(av, small, "gif", ladder.at(-1)!, { duration: 3 }));
    const bigInfo = await probeMedia(big);
    expect(bigInfo.videoCodec).toBe("gif");
    expect(bigInfo.width).toBe(320);
    expect(statSync(small).size).toBeLessThan(statSync(big).size / 2);

    const webp = p("anim.webp");
    await runFfmpeg(buildAnimArgs(av, webp, "webp", animLadder("webp", 12, 320)[0], { duration: 3 }));
    expect(readFileSync(webp).subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(statSync(webp).size).toBeGreaterThan(1000);
  });

  it("screen diff finds a box drawn onto an image, in its pixel coordinates (#116)", async () => {
    const a = p("diff-a.png");
    const b = p("diff-b.png");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=gray:s=640x360", "-frames:v", "1", a]);
    await runFfmpeg(["-y", "-i", a, "-vf", "drawbox=x=400:y=100:w=80:h=60:color=white:t=fill", "-frames:v", "1", b]);
    const size = analysisSize(640, 360);
    const [ra, rb] = await Promise.all([runFfmpegBuffer(buildRawFrameArgs(a, size)), runFfmpegBuffer(buildRawFrameArgs(b, size))]);
    expect(ra.length).toBe(size.width * size.height);
    const d = diffFrames(ra, rb, size.width, size.height, { scale: 640 / size.width });
    expect(d.regions).toHaveLength(1);
    const r = d.regions[0];
    // The box (400,100)-(480,160) must lie inside the reported region, give or take one cell.
    expect(r.x).toBeLessThanOrEqual(400);
    expect(r.y).toBeLessThanOrEqual(100);
    expect(r.x + r.width).toBeGreaterThanOrEqual(480);
    expect(r.y + r.height).toBeGreaterThanOrEqual(160);
    expect(r.width).toBeLessThan(80 + 2 * 16);

    const ssim = await runCapture(FFMPEG, buildSsimArgs(a, b, size));
    expect(parseSsim(ssim.stderr)).toBeLessThan(1);
    expect(parseSsim((await runCapture(FFMPEG, buildSsimArgs(a, a, size))).stderr)).toBeCloseTo(1, 5);
  });

  it("a scene scan finds each cut in a three-scene clip (#114)", async () => {
    // red (0-2s) -> blue (2-4s) -> testsrc (4-6s)
    const scenes = p("scenes.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2,format=yuv420p",
      "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2,format=yuv420p",
      "-f", "lavfi", "-i", "testsrc=s=320x240:d=2,format=yuv420p",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", scenes,
    ]);
    const scan = await runCapture(FFMPEG, buildSceneScanArgs(scenes, 0.1));
    expect(scan.code).toBe(0);
    const times = pickSceneFrames(parseSceneScan(scan.stdout), 10);
    expect(times).toHaveLength(3);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(2, 1);
    expect(times[2]).toBeCloseTo(4, 1);
  });

  it("dedupe drops repeated frames from a static clip (#114)", async () => {
    const still = p("still.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=4", "-c:v", "libx264", "-preset", "ultrafast", still]);
    const plain = p("plain");
    const deduped = p("deduped");
    mkdirSync(plain);
    mkdirSync(deduped);
    await runFfmpeg(buildSampleByFpsArgs(still, 2, join(plain, "f_%05d.png"), 100));
    await runFfmpeg(buildSampleByFpsArgs(still, 2, join(deduped, "f_%05d.png"), 100, true));
    expect(readdirSync(plain).length).toBeGreaterThanOrEqual(7);
    expect(readdirSync(deduped).length).toBe(1);
  });

  it("runEditJob writes the output atomically and reports progress (#81)", async () => {
    const out = p("job-ok.mp4");
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra = { _meta: { progressToken: "t" }, sendNotification, signal: new AbortController().signal } as unknown as ToolExtra;
    await runEditJob(buildScaleArgs(av, out, { width: 160 }), { output: out, durationSec: 10, extra });
    expect(existsSync(out)).toBe(true);
    expect(existsSync(partialPath(out))).toBe(false);
    const percents = sendNotification.mock.calls.map((c) => c[0].params.progress);
    expect(percents.at(-1)).toBe(100);
    expect(percents.length).toBeGreaterThan(1);
  });

  it("a failed runEditJob leaves no file at the output (#81)", async () => {
    const out = p("job-fail.mp4");
    // An unknown filter makes ffmpeg exit non-zero after opening the input.
    const bad = ["-y", "-i", av, "-vf", "nosuchfilter", out];
    await expect(runEditJob(bad, { output: out, durationSec: 10 })).rejects.toThrow(/ffmpeg failed/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(partialPath(out))).toBe(false);
  });

  it("a cancelled runEditJob kills ffmpeg and leaves no partial file (#81)", async () => {
    const out = p("job-cancel.mp4");
    const ac = new AbortController();
    const extra = { signal: ac.signal, sendNotification: vi.fn() } as unknown as ToolExtra;
    // A long lavfi source keeps ffmpeg busy until it is cancelled.
    const slow = ["-y", "-f", "lavfi", "-i", "testsrc=duration=600:size=1280x720:rate=30", "-c:v", "libx264", "-preset", "veryslow", out];
    const job = runEditJob(slow, { output: out, durationSec: 600, extra });
    setTimeout(() => ac.abort(), 500);
    await expect(job).rejects.toThrow(/cancelled/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(partialPath(out))).toBe(false);
  });

  it("inline images are downscaled JPEGs and capped by count (#79)", async () => {
    const frame = p("frame.png");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1", frame]);
    const { images, omitted } = await encodeInlineImages([frame, frame, frame], 200, 2);
    expect(images).toHaveLength(2);
    expect(omitted).toBe(1);
    expect(images[0].mimeType).toBe("image/jpeg");
    const decoded = p("decoded.jpg");
    writeFileSync(decoded, Buffer.from(images[0].data, "base64"));
    const info = await probeMedia(decoded);
    expect([info.width, info.height]).toEqual([200, 150]);
  });
});
