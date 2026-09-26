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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryWorks, runCapture, runFfmpeg, probeMedia } from "../../utils/ffmpeg.js";
import {
  buildTrimArgs,
  buildClipArgs,
  buildSpeedArgs,
  buildCropArgs,
  buildScaleArgs,
  buildExtractAudioArgs,
  buildRedactArgs,
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
  });

  it("redact_region box fills the region solid", async () => {
    const out = p("redact.mp4");
    await runFfmpeg(buildRedactArgs(av, out, [{ x: 0, y: 0, width: 64, height: 64 }], {}, { width: 320, height: 240 }));
    // testsrc is bright/colourful in the top-left; a solid black box reads ~0.
    expect(regionLuma(out, 1, 8, 8, 48, 48)).toBeLessThan(10);
    expect(regionLuma(av, 1, 8, 8, 48, 48)).toBeGreaterThan(20);
  });
});
