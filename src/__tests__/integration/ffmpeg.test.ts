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
import { defined } from "../testUtils.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { binaryWorks, runCapture, runFfmpeg, runFfmpegBuffer, probeMedia } from "../../utils/ffmpeg.js";
import { sequencePattern } from "../../utils/paths.js";
import {
  buildTrimArgs,
  buildClipArgs,
  buildCompressArgs,
  buildSampleAtTimestampArgs,
  buildOverlayArgs,
  concatCopyBlocker,
  hasHiddenFrames,
  editOutputExt,
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
import { bundledFontPath, systemFontsDir, FALLBACK_FAMILIES } from "../../utils/fonts.js";
import { prepareCalloutAssets } from "../../utils/calloutAssets.js";
import { encodeInlineImages } from "../../utils/images.js";
import { animLadder, buildAnimArgs } from "../../utils/anim.js";
import { buildArrowImageArgs, buildCalloutArgs } from "../../utils/callout.js";
import { buildBackdropArgs } from "../../utils/backdrop.js";
import { planBadges, groupBadges, buildKeystrokeArgs } from "../../utils/keystrokes.js";
import { buildBurnSubtitlesArgs, buildTranscribeArgs, parseSrt, normalizeCues } from "../../utils/captions.js";
import { buildIdleScanArgs, parseFreezes, parseSilences, intersect, cutsFor, buildCutIdleArgs, MAX_CUTS } from "../../utils/idle.js";
import { keyframesToViews, buildZoomArgs, planClickZoom } from "../../utils/zoom.js";
import { loudnessTarget, buildLoudnessMeasureArgs, buildLoudnessApplyArgs, parseLoudnorm, buildDenoiseArgs, buildNoiseFloorArgs, parseNoiseFloor } from "../../utils/audio.js";
import { analysisSize, diffFrames, buildRawFrameArgs, buildSsimArgs, parseSsim } from "../../utils/diff.js";
import { evenTimes, formatTimecode, sheetGrid, buildTileArgs, buildSheetArgs, buildPosterArgs } from "../../utils/sheet.js";
import { runEditJob, partialPath, type ToolExtra } from "../../utils/jobs.js";
import { planPipeline, type PipelineStep } from "../../utils/pipeline.js";
import { exportAnimation } from "../../utils/animExport.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);
const REQUIRED = !!process.env.REQUIRE_FFMPEG;
// The BtbN Windows ARM64 build CI uses ships without libvpx (#246); the .webm
// fixture needs it, so that one case skips there instead of failing.
const HAS_LIBVPX =
  AVAILABLE && /\blibvpx-vp9\b/.test(spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "");

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

/** Raw gray pixels of a rectangle of the frame at `t` seconds. */
function regionPixels(path: string, t: number, x: number, y: number, w: number, h: number): Buffer {
  const res = spawnSync(FFMPEG, [
    "-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
    "-vf", `crop=${w}:${h}:${x}:${y},format=gray`,
    "-f", "rawvideo", "-",
  ]);
  return res.stdout ?? Buffer.alloc(0);
}

/** Average luma (0-255) of a rectangle of the frame at `t` seconds. (A true
 * average: scale=1:1's default scaler samples sparsely and misses thin text.) */
function regionLuma(path: string, t: number, x: number, y: number, w: number, h: number): number {
  const px = regionPixels(path, t, x, y, w, h);
  return px.length > 0 ? px.reduce((s, v) => s + v, 0) / px.length : -1;
}

/** Share of left/right neighbours in a rectangle that differ by more than 16
 * levels: how many sharp edges (text strokes) survive. A blur spreads edges
 * into gentle ramps and a mosaic keeps them only at block borders. */
function regionDetail(path: string, t: number, x: number, y: number, w: number, h: number): number {
  const px = regionPixels(path, t, x, y, w, h);
  let sum = 0;
  let n = 0;
  for (let row = 0; row < h; row++) {
    for (let col = 1; col < w; col++) {
      sum += Math.abs((px[row * w + col] ?? 0) - (px[row * w + col - 1] ?? 0)) > 16 ? 1 : 0;
      n++;
    }
  }
  return n > 0 && px.length === w * h ? sum / n : -1;
}

/** Brightest pixel in a rectangle: answers "is any text drawn here". */
function regionMaxLuma(path: string, t: number, x: number, y: number, w: number, h: number): number {
  const px = regionPixels(path, t, x, y, w, h);
  return px.length > 0 ? Math.max(...px) : -1;
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

  it("trim leaves no hidden frames from before start; exact: false keeps them (#203)", async () => {
    // av has a keyframe every 30 frames, so a 7.5 s start sits mid-GOP.
    const count = (f: string) =>
      Number(
        spawnSync("ffprobe", [
          "-v", "error", "-ignore_editlist", "1", "-select_streams", "v:0", "-count_packets",
          "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", f,
        ], { encoding: "utf8" }).stdout.trim(),
      );
    const exact = p("trim-exact.mp4");
    const copy = p("trim-copy.mp4");
    await runFfmpeg(buildTrimArgs(av, exact, { start: 7.5, duration: 2 }));
    await runFfmpeg(buildTrimArgs(av, copy, { start: 7.5, duration: 2, exact: false }));
    expect(count(exact)).toBeLessThanOrEqual(61);
    expect(count(copy)).toBeGreaterThan(count(exact));
  });

  it("compress with an odd maxWidth writes an even-width file (#239)", async () => {
    const out = p("compress-odd.mp4");
    await runFfmpeg(buildCompressArgs(av, out, { level: "heavy", maxWidth: 237 }));
    expect((await probeMedia(out)).width).toBe(236);
  });

  it("a % in output dirs and names stays literal (#238)", async () => {
    const pct = p("50%1 pct");
    mkdirSync(pct);
    const still = join(pct, "b%dx.png");
    await runFfmpeg(buildSampleAtTimestampArgs(av, 1, still));
    expect(existsSync(still)).toBe(true);
    await runFfmpeg(buildSampleByFpsArgs(av, 1, sequencePattern(pct, "frame_%05d.png"), 2));
    expect(readdirSync(pct).filter((f) => f.startsWith("frame_"))).toEqual(["frame_00001.png", "frame_00002.png"]);
  });

  /** Per-stream durations, sample rates and channel counts from ffprobe. */
  const streams = (f: string) => {
    const out = spawnSync(FFPROBE, [
      "-v", "error", "-show_entries", "stream=codec_type,duration,sample_rate,channels", "-of", "json", f,
    ], { encoding: "utf8" }).stdout;
    const list = (JSON.parse(out).streams ?? []) as { codec_type: string; duration?: string; sample_rate?: string; channels?: number }[];
    const v = list.find((x) => x.codec_type === "video");
    const a = list.find((x) => x.codec_type === "audio");
    return {
      v: v?.duration !== undefined ? Number(v.duration) : null,
      a: a?.duration !== undefined ? Number(a.duration) : null,
      rate: a?.sample_rate !== undefined ? Number(a.sample_rate) : null,
      channels: a?.channels ?? null,
    };
  };

  it("crossfades on video length when a clip's audio runs longer (#205)", async () => {
    // 3 s of video carrying 4 s of audio: the container says 4 s.
    const long = p("long-audio.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", long,
    ]);
    const info = await probeMedia(long);
    expect(info.videoDurationSec!).toBeCloseTo(3, 1);
    const out = p("xfade-205.mp4");
    await runFfmpeg(buildXfadeArgs(long, short, [info.videoDurationSec!, 4], out, { width: 320, height: 240, duration: 1, quality: "draft" }, [true, true]));
    const st = streams(out);
    // 3 + 4 - 1 = 6 s of each, in step.
    expect(st.v!).toBeCloseTo(6, 0);
    expect(Math.abs(st.a! - st.v!)).toBeLessThan(0.1);
  });

  it("xfade keeps narration when the other clip is silent (#188)", async () => {
    const out = p("xfade-silent.mp4");
    await runFfmpeg(buildXfadeArgs(short, vOnly, [4, 4], out, { width: 320, height: 240, quality: "draft" }, [true, false]));
    const st = streams(out);
    expect(st.a).not.toBeNull();
    expect(st.a!).toBeCloseTo(7, 0);
  });

  it("overlay keeps the main audio and length, and a PiP video plays from start (#188, #230)", async () => {
    const main = p("main-mono.mp4");
    const pip = p("pip-stereo.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-shortest", main,
    ]);
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc2=duration=9:size=80x60:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=9",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest", pip,
    ]);
    const out = p("overlay-pip.mp4");
    await runFfmpeg(buildOverlayArgs(main, pip, out, { x: 10, y: 10, start: 3, end: 5, durationSec: 6 }));
    const st = streams(out);
    expect(st.v!).toBeCloseTo(6, 0);
    expect(st.channels).toBe(1);
    const frameMd5 = (t: number) =>
      spawnSync(FFMPEG, ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "crop=80:60:10:10", "-f", "md5", "-"], { encoding: "utf8" }).stdout.trim();
    expect(new Set([frameMd5(3.2), frameMd5(3.6), frameMd5(4.4)]).size).toBe(3);
  });

  it("the vertical_reel export is 48 kHz (#188)", async () => {
    const reel = p("reel-48k.mp4");
    await runFfmpeg(buildExportPresetArgs(short, reel, "vertical_reel"));
    expect(streams(reel).rate).toBe(48000);
  });

  it("blur redacts a 4x4 region (#188)", async () => {
    const out = p("blur-tiny.mp4");
    await runFfmpeg(buildRedactArgs(av, out, [{ x: 10, y: 10, width: 4, height: 4 }], { style: "blur", pad: 0 }, { width: 320, height: 240 }));
    expect((await probeMedia(out)).videoCodec).toBe("h264");
  });

  it("concat re-encodes mismatched inputs into one valid file with both clips (#206)", async () => {
    const big = p("big-av.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=640x480:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", big,
    ]);
    const inputs = [vOnly, big];
    const infos = await Promise.all(inputs.map((f) => probeMedia(f)));
    expect(concatCopyBlocker(inputs, infos)).toMatch(/differs/);
    const out = p("concat-mixed.mp4");
    await runFfmpeg(buildAssembleArgs(inputs, infos.map((i) => i.videoDurationSec!), out, { width: 320, height: 240, quality: "draft" }, infos.map((i) => i.audioCodec !== null)));
    const info = await probeMedia(out);
    expect([info.width, info.height]).toEqual([320, 240]);
    const st = streams(out);
    expect(st.v!).toBeCloseTo(6, 0);
    expect(st.a!).toBeCloseTo(6, 0);
  });

  it("a stream-copy trim is detected as holding hidden frames (#203)", async () => {
    const copy = p("trim-hidden.mp4");
    await runFfmpeg(buildTrimArgs(av, copy, { start: 7.5, duration: 2, exact: false }));
    expect(hasHiddenFrames(await probeMedia(copy))).toBe(true);
    const exact = p("trim-clean.mp4");
    await runFfmpeg(buildTrimArgs(av, exact, { start: 7.5, duration: 2 }));
    expect(hasHiddenFrames(await probeMedia(exact))).toBe(false);
  });

  it.runIf(HAS_LIBVPX)("edits a .webm input into an .mp4, and normalizes audio to a .wav (#187)", async () => {
    const webm = p("in.webm");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest", webm,
    ]);
    const cropped = p(`crop-webm${editOutputExt(webm)}`);
    await runFfmpeg(buildCropArgs(webm, cropped, { x: 0, y: 0, width: 160, height: 120 }));
    expect((await probeMedia(cropped)).width).toBe(160);
    const t = loudnessTarget("podcast");
    const measured = parseLoudnorm((await runCapture(FFMPEG, buildLoudnessMeasureArgs(av, t))).stderr);
    const wav = p("normalized.wav");
    await runFfmpeg(buildLoudnessApplyArgs(av, wav, t, measured));
    const w = await probeMedia(wav);
    expect(w.audioCodec).toBe("pcm_s16le");
    expect(w.videoCodec).toBeNull();
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

  it("steam_trailer and vertical_reel meet the media-layer spec (#107)", async () => {
    const stream = (path: string, sel: string, entries: string) => {
      const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", sel, "-show_entries", `stream=${entries}`, "-of", "json", path], { encoding: "utf8" });
      return JSON.parse(r.stdout).streams[0] as Record<string, string | number>;
    };
    const steam = p("steam.mp4");
    await runFfmpeg(buildExportPresetArgs(av, steam, "steam_trailer"));
    const v = stream(steam, "v:0", "width,height,profile,bit_rate,pix_fmt,r_frame_rate");
    expect([v.width, v.height, v.profile, v.pix_fmt, v.r_frame_rate]).toEqual([1920, 1080, "High", "yuv420p", "30/1"]);
    expect(Number(v.bit_rate)).toBeGreaterThan(5_000_000); // padded CBR: above Steam's floor even for easy footage
    const a = stream(steam, "a:0", "codec_name,sample_rate,channels");
    expect([a.codec_name, a.sample_rate, a.channels]).toEqual(["aac", "48000", 2]);
    const loud = parseLoudnorm((await runCapture(FFMPEG, buildLoudnessMeasureArgs(steam, loudnessTarget("youtube")))).stderr);
    expect(loud.input_i).toBeGreaterThan(-16);
    expect(loud.input_i).toBeLessThan(-12);

    const reel = p("reel.mp4");
    await runFfmpeg(buildExportPresetArgs(av, reel, "vertical_reel"));
    const rv = await probeMedia(reel);
    expect([rv.width, rv.height]).toEqual([1080, 1920]);
    // The 4:3 footage fills the centred 1080x1080 square's width: 1080x810.
    expect(regionLuma(reel, 1, 0, 0, 1080, 400)).toBeGreaterThan(20); // a blurred fill above it, not black bars
    expect(regionLuma(reel, 1, 0, 0, 1080, 400)).not.toBeCloseTo(regionLuma(reel, 1, 0, 600, 1080, 700), 0);
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
    await runFfmpeg(buildXfadeArgs(short, short, [4, 4], out, { width: 320, height: 240, duration: 1, quality: "draft" }, [true, true]));
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

  it("two-pass loudnorm lands on the target, and denoise lowers steady noise (#123)", async () => {
    const t = loudnessTarget("podcast");
    const measured = parseLoudnorm((await runCapture(FFMPEG, buildLoudnessMeasureArgs(av, t))).stderr);
    const out = p("loudnorm.mp4");
    await runFfmpeg(buildLoudnessApplyArgs(av, out, t, measured));
    const after = parseLoudnorm((await runCapture(FFMPEG, buildLoudnessMeasureArgs(out, t))).stderr);
    expect(Math.abs(after.input_i - t.i)).toBeLessThan(1);
    expect((await probeMedia(out)).videoCodec).toBe("h264"); // copied, still there

    const noise = p("noise.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "anoisesrc=d=3:c=white:a=0.1", noise]);
    const quiet = p("denoised.wav");
    const floor = parseNoiseFloor((await runCapture(FFMPEG, buildNoiseFloorArgs(noise))).stdout);
    expect(floor!).toBeCloseTo(-24.8, 0);
    await runFfmpeg(buildDenoiseArgs(noise, quiet, "strong", floor));
    // Steady noise near the floor is cut hard (measured ~20 dB at strong).
    expect(await meanVolume(quiet)).toBeLessThan((await meanVolume(noise)) - 10);
  });

  it("zoom fills the frame with a keyframe's rectangle once reached (#119)", async () => {
    const src = p("zoom-src.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=3:r=30", "-vf", "drawbox=x=160:y=120:w=80:h=60:color=white:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
    const out = p("zoomed.mp4");
    const views = keyframesToViews([{ t: 1, x: 160, y: 120, width: 80, height: 60 }, { t: 2.5, full: true }], 320, 240);
    await runFfmpeg(buildZoomArgs(src, out, views, { width: 320, height: 240, fps: 30 }, 0.5, "draft"));
    expect(regionLuma(out, 0.2, 0, 0, 320, 240)).toBeLessThan(150); // not zoomed yet: mostly gray
    expect(regionLuma(out, 1.5, 20, 20, 280, 200)).toBeGreaterThan(235); // the white box fills the frame
    const info = await probeMedia(out);
    expect([info.width, info.height]).toEqual([320, 240]);
  });

  it("zoom follows clicks and rings each one, only while it is fresh (#119)", async () => {
    const src = p("click-src.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=3:r=30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
    // Rings only (the view never leaves the full frame), so pixels map 1:1.
    const ringed = p("ringed.mp4");
    const full = keyframesToViews([{ t: 0, full: true }], 320, 240);
    await runFfmpeg(buildZoomArgs(src, ringed, full, { width: 320, height: 240, fps: 30 }, 0.5, "draft", {
      clicks: [{ t: 1, x: 100, y: 100 }],
      color: "white",
    }));
    expect(regionMaxLuma(ringed, 0.5, 80, 80, 40, 40)).toBeLessThan(140); // before the click: plain gray
    expect(regionMaxLuma(ringed, 1.2, 80, 80, 40, 40)).toBeGreaterThan(180); // the ring
    expect(regionMaxLuma(ringed, 2.2, 80, 80, 40, 40)).toBeLessThan(140); // gone after RING_SEC
    // Click-planned zoom keeps the size and duration.
    const zoomed = p("click-zoomed.mp4");
    const kfs = planClickZoom([{ t: 0.8, x: 240, y: 180 }], 320, 240, { holdSec: 1, transition: 0.5 });
    await runFfmpeg(buildZoomArgs(src, zoomed, keyframesToViews(kfs, 320, 240), { width: 320, height: 240, fps: 30 }, 0.5, "draft"));
    const info = await probeMedia(zoomed);
    expect([info.width, info.height]).toEqual([320, 240]);
    expect(info.durationSec).toBeCloseTo(3, 0);
  });

  it("pipeline runs trim -> crop -> scale -> export_preset as one process, matching the tools one by one (#125)", async () => {
    // Sequential: four tool calls, four files. trim starts on a keyframe (every
    // second in av), so its stream copy is frame-accurate too.
    const [t1, t2, t3, seq] = [p("seq1.mp4"), p("seq2.mp4"), p("seq3.mp4"), p("seq4.mp4")];
    await runFfmpeg(buildTrimArgs(av, t1, { start: 2, end: 6 }));
    await runFfmpeg(buildCropArgs(t1, t2, { x: 40, y: 20, width: 240, height: 180 }));
    await runFfmpeg(buildScaleArgs(t2, t3, { width: 160 }));
    await runFfmpeg(buildExportPresetArgs(t3, seq, "square"));
    // Fused: one ffmpeg invocation.
    const fused = p("fused.mp4");
    const steps: PipelineStep[] = [
      { op: "trim", start: 2, end: 6 },
      { op: "crop", x: 40, y: 20, width: 240, height: 180 },
      { op: "scale", width: 160 },
      { op: "export_preset", platform: "square" },
    ];
    const plan = planPipeline(av, fused, steps, { width: 320, height: 240, fps: 30, durationSec: 10, hasAudio: true });
    expect(plan.args.filter((a) => a === "-i")).toHaveLength(1);
    await runFfmpeg(plan.args);

    const [a, b] = [await probeMedia(seq), await probeMedia(fused)];
    expect([b.width, b.height]).toEqual([1080, 1080]);
    expect([plan.width, plan.height]).toEqual([1080, 1080]);
    expect(b.durationSec!).toBeCloseTo(a.durationSec!, 1);
    expect(b.audioCodec).toBe("aac");
    const ssim = await runCapture(FFMPEG, ["-v", "info", "-i", seq, "-i", fused, "-lavfi", "[0][1]ssim", "-f", "null", "-"]);
    expect(parseSsim(ssim.stderr)).toBeGreaterThan(0.95);
  });

  it("pipeline fuses speed, redact, and callout, keeps audio in step, and can end in a GIF (#125)", async () => {
    const out = p("pipe-mixed.mp4");
    const steps: PipelineStep[] = [
      { op: "speed", factor: 2 },
      { op: "redact", regions: [{ x: 200, y: 100, width: 80, height: 60 }] },
      { op: "callout", items: [{ type: "box", x: 10, y: 10, width: 60, height: 40, color: "red" }] },
    ];
    const assets = { 2: { fontFile: bundledFontPath("bold"), textFiles: [null], arrowFiles: [null] } };
    const plan = planPipeline(av, out, steps, { width: 320, height: 240, fps: 30, durationSec: 10, hasAudio: true }, assets, "draft");
    await runFfmpeg(plan.args);
    const info = await probeMedia(out);
    expect(info.durationSec!).toBeCloseTo(5, 0); // 10 s at 2x
    expect(plan.durationSec).toBe(5);
    expect(regionLuma(out, 1, 210, 110, 60, 40)).toBeLessThan(20); // the redaction box
    expect(regionMaxLuma(out, 1, 12, 10, 56, 4)).toBeGreaterThan(40); // the callout's top edge

    // export_gif tail: stage one writes an mp4, the ladder writes the GIF.
    const stage = p("pipe-stage.mp4");
    const gifPlan = planPipeline(av, stage, [{ op: "trim", start: 0, duration: 2 }, { op: "export_gif", width: 160, fps: 8 }], {
      width: 320, height: 240, fps: 30, durationSec: 10, hasAudio: true,
    });
    expect(gifPlan.gif).toEqual({ width: 160, fps: 8 });
    await runFfmpeg(gifPlan.args);
    const gif = await exportAnimation(stage, p("pipe.gif"), gifPlan.gif!);
    expect(gif.withinBudget).toBe(true);
    expect((await probeMedia(p("pipe.gif"))).width).toBe(160);
  });

  it("cut_idle removes a frozen, silent stretch and keeps audio in sync (#122)", async () => {
    const idle = p("idle.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "testsrc2=s=160x120:d=2", "-f", "lavfi", "-i", "color=c=gray:s=160x120:d=3", "-f", "lavfi", "-i", "testsrc2=s=160x120:d=2",
      "-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=3", "-f", "lavfi", "-i", "sine=f=660:d=2",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v];[3][4][5]concat=n=3:v=0:a=1[a]",
      "-map", "[v]", "-map", "[a]", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", idle,
    ]);
    const scan = await runCapture(FFMPEG, buildIdleScanArgs(idle, 1.5, true));
    const cuts = cutsFor(intersect(parseFreezes(scan.stderr, 7), parseSilences(scan.stderr, 7)), 1.5, 0.3);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.start).toBeCloseTo(2.3, 1);
    expect(cuts[0]?.end).toBeCloseTo(4.7, 1);
    const out = p("idle-cut.mp4");
    await runFfmpeg(buildCutIdleArgs(idle, out, cuts, true, "draft"));
    const info = await probeMedia(out);
    expect(Math.abs(info.durationSec! - 4.6)).toBeLessThan(0.2);
  });

  it("zoom, cut_idle and pipeline speed+zoom keep video and audio the same length on VFR input (#186)", async () => {
    // 3 s at 30 fps then 3 s at 5 fps, with 6 s of audio: an idle-ish screen recording.
    const vfr = p("vfr.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "testsrc2=s=160x120:r=30:d=3", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=5:d=3",
      "-f", "lavfi", "-i", "sine=f=440:d=6",
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
      "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", vfr,
    ]);
    const streams = async (f: string) => {
      const r = await runCapture(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", f]);
      const s = JSON.parse(r.stdout).streams as Array<{ codec_type: string; duration: string }>;
      return Object.fromEntries(s.map((x) => [x.codec_type, Number(x.duration)])) as { video: number; audio: number };
    };
    const size = { width: 160, height: 120, fps: 30 };

    const zoomed = p("vfr-zoom.mp4");
    await runFfmpeg(buildZoomArgs(vfr, zoomed, keyframesToViews([{ t: 1, x: 40, y: 30, width: 80, height: 60 }, { t: 4, full: true }], 160, 120), size, 0.5, "draft"));
    let d = await streams(zoomed);
    expect(Math.abs(d.video - d.audio)).toBeLessThan(0.1);
    expect(d.video).toBeCloseTo(6, 0);

    const cut = p("vfr-cut.mp4");
    await runFfmpeg(buildCutIdleArgs(vfr, cut, [{ start: 4, end: 4.5 }], true, "draft"));
    d = await streams(cut);
    expect(Math.abs(d.video - d.audio)).toBeLessThan(0.25);
    expect(d.video).toBeCloseTo(5.5, 0);

    const piped = p("vfr-speed-zoom.mp4");
    const plan = planPipeline(vfr, piped, [{ op: "speed", factor: 2 }, { op: "zoom", keyframes: [{ t: 1, x: 40, y: 30, width: 80, height: 60 }] }], {
      ...size, durationSec: 6, hasAudio: true,
    });
    await runFfmpeg(plan.args);
    d = await streams(piped);
    expect(plan.durationSec).toBe(3);
    expect(Math.abs(d.video - d.audio)).toBeLessThan(0.1);
    expect(d.video).toBeCloseTo(3, 0);
  });

  it("zoom and cut_idle render far past ffmpeg's expression and command-line limits (#225)", async () => {
    const src = p("long-src.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:d=60:r=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
    // 300 keyframes (150 clicks' worth) and 200 rings: tens of KB of filter graph.
    const clicks = Array.from({ length: 150 }, (_, i) => ({ t: i * 0.39, x: 20 + (i % 7) * 20, y: 20 + (i % 5) * 20 }));
    const kfs = Array.from({ length: 300 }, (_, i) =>
      i % 2 ? { t: i * 0.19 + 0.1, full: true } : { t: i * 0.19 + 0.1, x: (i % 9) * 10, y: (i % 4) * 10, width: 64, height: 48 },
    );
    const zoomed = p("long-zoom.mp4");
    await runFfmpeg(buildZoomArgs(src, zoomed, keyframesToViews(kfs, 160, 120), { width: 160, height: 120, fps: 10 }, 0.1, "draft", {
      clicks: [...clicks, ...clicks.slice(0, 50)].map((c, i) => ({ ...c, t: i * 0.29 })),
      color: "white",
    }));
    expect((await probeMedia(zoomed)).durationSec).toBeCloseTo(60, 0);
    const clickZoomed = p("long-click-zoom.mp4");
    const planned = planClickZoom(clicks, 160, 120, { holdSec: 0.1, transition: 0.1 });
    expect(planned.length).toBeGreaterThan(100);
    await runFfmpeg(buildZoomArgs(src, clickZoomed, keyframesToViews(planned, 160, 120), { width: 160, height: 120, fps: 10 }, 0.1, "draft"));
    expect((await probeMedia(clickZoomed)).durationSec).toBeCloseTo(60, 0);
    // MAX_CUTS cuts of 0.07 s; the timeline shrinks by exactly the cut time (#186).
    const cuts = Array.from({ length: MAX_CUTS }, (_, i) => ({ start: i * 0.3 + 0.05, end: i * 0.3 + 0.12 }));
    const cut = p("long-cut.mp4");
    await runFfmpeg(buildCutIdleArgs(src, cut, cuts, false, "draft"));
    expect((await probeMedia(cut)).durationSec).toBeCloseTo(60 - MAX_CUTS * 0.07, 0);
  });

  it("burn_subtitles draws the cue text only while the cue is on (#120)", async () => {
    const srt = p("cues.srt");
    writeFileSync(srt, "1\n00:00:01,000 --> 00:00:03,000\nHELLO WORLD CAPTION\n");
    const plain = p("plain.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", plain]);
    const out = p("captioned.mp4");
    await runFfmpeg(buildBurnSubtitlesArgs(plain, srt, out, dirname(bundledFontPath("regular")), "social", "draft"));
    // White text on black in the bottom band during the cue, nothing outside it.
    expect(regionMaxLuma(out, 2, 60, 240, 520, 110)).toBeGreaterThan(200);
    expect(regionMaxLuma(out, 0.5, 60, 240, 520, 110)).toBeLessThan(30);
  });

  it.runIf(process.platform === "win32" && !!process.env.SCREENCAST_WHISPER_MODEL)("transcribe writes recognisable text with the whisper filter (#120)", async () => {
    const speech = p("speech.wav");
    // Windows speech synthesis makes the input; CI's Windows leg caches a
    // whisper model and sets SCREENCAST_WHISPER_MODEL (#192).
    const { spawnSync } = await import("node:child_process");
    spawnSync("powershell", ["-NoProfile", "-Command",
      `Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.SetOutputToWaveFile('${speech.replace(/'/g, "''")}');$s.Speak('Open the settings page');$s.Dispose()`]);
    const raw = p("raw.srt");
    await runFfmpeg(buildTranscribeArgs(speech, process.env.SCREENCAST_WHISPER_MODEL!, raw, "en"));
    const cues = normalizeCues(parseSrt(readFileSync(raw, "utf8")));
    expect(cues.map((c) => c.text).join(" ").toLowerCase()).toContain("settings");
  });

  it("callout draws a box, a text label with a %, and an arrow, each only in its window (#121)", async () => {
    const arrow = p("arrow.png");
    const text = { type: "text" as const, x: 120, y: 150, text: "100% done", size: 24, from: 1, to: 3 };
    const arrowItem = { type: "arrow" as const, x1: 200, y1: 60, x2: 300, y2: 60, color: "white", thickness: 10, from: 1, to: 3 };
    const items = [
      { type: "box" as const, x: 10, y: 10, width: 60, height: 40, fill: true, color: "white", from: 1, to: 3 },
      text,
      arrowItem,
    ];
    await runFfmpeg(buildArrowImageArgs(arrowItem, arrow));
    const label = p("label.txt");
    writeFileSync(label, text.text);
    const out = p("callout.mp4");
    await runFfmpeg(buildCalloutArgs(vOnly, out, items, { fontFile: bundledFontPath("bold"), textFiles: [null, label, null], arrowFiles: [null, null, arrow] }, "draft"));
    // Inside the window every annotation is visible ...
    expect(regionLuma(out, 2, 20, 20, 40, 20)).toBeGreaterThan(220); // filled white box
    expect(regionLuma(out, 2, 240, 55, 30, 10)).toBeGreaterThan(200); // arrow shaft at y=60
    // ... and the source shows through before it starts.
    expect(regionLuma(out, 0.3, 20, 20, 40, 20)).toBeLessThan(220);
    expect((await probeMedia(out)).durationSec!).toBeCloseTo(4, 0);
  });

  it("backdrop pads onto the background with rounded corners and a drop shadow (#171)", async () => {
    const white = p("white.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=white:s=320x240:r=30:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", white]);
    const out = p("backdrop.mp4");
    const { args, layout } = buildBackdropArgs(white, out, { colors: ["black"], padding: 40, radius: 24, shadow: 0 }, { width: 320, height: 240 });
    await runFfmpeg(args);
    const info = await probeMedia(out);
    expect([info.width, info.height]).toEqual([400, 320]);
    expect([layout.x, layout.y]).toEqual([40, 40]);
    expect(info.durationSec!).toBeCloseTo(2, 0);
    expect(regionLuma(out, 1, 150, 130, 100, 60)).toBeGreaterThan(230); // the content
    expect(regionLuma(out, 1, 4, 4, 30, 30)).toBeLessThan(25); // the background in the padding
    expect(regionLuma(out, 1, 40, 40, 4, 4)).toBeLessThan(60); // the rounded-off corner shows the background
    expect(regionLuma(out, 1, 40, 150, 4, 4)).toBeGreaterThan(200); // a straight edge is not cut

    // A shadow darkens the background just below the content, not far from it.
    const shadowed = p("backdrop-shadow.mp4");
    await runFfmpeg(buildBackdropArgs(vOnly, shadowed, { colors: ["white"], padding: 40, radius: 0, shadow: 16, shadowOpacity: 0.8 }, { width: 320, height: 240 }).args);
    expect(regionLuma(shadowed, 1, 100, 283, 120, 6)).toBeLessThan(200);
    // White is ~225 on older ffmpeg (limited range), 255 on FFmpeg 8; either is well clear of the shadow.
    expect(regionLuma(shadowed, 1, 0, 0, 20, 20)).toBeGreaterThan(215);
  });

  it("backdrop frames a PNG still on an aspect canvas with a gradient preset (#171)", async () => {
    const shot = p("shot.png");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=white:s=301x201", "-frames:v", "1", shot]);
    const out = p("framed.png");
    await runFfmpeg(buildBackdropArgs(shot, out, { preset: "rec", aspect: "1:1", padding: 60 }, { width: 301, height: 201 }, true).args);
    const info = await probeMedia(out);
    expect([info.width, info.height]).toEqual([1080, 1080]);
    expect(regionLuma(out, 0, 440, 500, 200, 80)).toBeGreaterThan(230); // the scaled-up shot
    const top = regionLuma(out, 0, 0, 0, 40, 40);
    const bottom = regionLuma(out, 0, 1040, 1040, 40, 40);
    expect(top).toBeGreaterThan(bottom + 20); // red #FF4545 fading to dark oxblood
  });

  it("keystroke_overlay burns a badge from the event log only while it lingers (#169)", async () => {
    const black = p("keys-black.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", black]);
    const badges = planBadges([{ t: 0.5, type: "key", x: 0, y: 0, inFrame: true, keys: "Ctrl+Shift+P" }]);
    const groups = groupBadges(badges);
    const label = p("badge.txt");
    writeFileSync(label, groups[0]!.label);
    const out = p("keys.mp4");
    await runFfmpeg(buildKeystrokeArgs(black, out, groups, { fontFile: bundledFontPath("bold"), textFiles: { [groups[0]!.label]: label } }, {}, { height: 360 }, "draft"));
    // The badge sits bottom-centre: white text on the dark panel at 1 s, gone at 2.5 s.
    expect(regionMaxLuma(out, 1, 200, 280, 240, 70)).toBeGreaterThan(200);
    expect(regionMaxLuma(out, 2.5, 200, 280, 240, 70)).toBeLessThan(40);
    expect(regionMaxLuma(out, 1, 160, 40, 320, 120)).toBeLessThan(40); // nothing elsewhere
  });

  it("pipeline re-times keystroke badges through a trim and frames the result with backdrop (#169, #171)", async () => {
    const black = p("keys-black2.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", black]);
    // A click at 4.5 s of the source is at 1.5 s after trimming the first 3 s.
    const badges = planBadges([{ t: 4.5, type: "down", x: 10, y: 10, inFrame: true, button: "left" }]);
    const label = p("click.txt");
    writeFileSync(label, "Click");
    const out = p("keys-pipeline.mp4");
    const steps: PipelineStep[] = [
      { op: "trim", start: 3, end: 6 },
      { op: "keystroke_overlay", size: 24 },
      { op: "backdrop", colors: ["#202020"], padding: 20, shadow: 0 },
    ];
    const plan = planPipeline(black, out, steps, { width: 320, height: 240, fps: 30, durationSec: 6, hasAudio: false }, {}, "draft", {
      keystrokes: { 1: { badges, fontFile: bundledFontPath("bold"), textFiles: { Click: label } } },
    });
    await runFfmpeg(plan.args);
    const info = await probeMedia(out);
    expect([info.width, info.height]).toEqual([360, 280]);
    expect(info.durationSec!).toBeCloseTo(3, 0);
    // The badge, inside the framed content's bottom half, at 2 s but not at 0.5 s.
    expect(regionMaxLuma(out, 2, 100, 190, 160, 60)).toBeGreaterThan(200);
    expect(regionMaxLuma(out, 0.5, 100, 190, 160, 60)).toBeLessThan(60);
  });

  it.runIf(FALLBACK_FAMILIES.japanese.bold.some((f) => existsSync(join(systemFontsDir(), f))))(
    "callout draws Japanese text with a system fallback font, not tofu (#231)",
    async () => {
      const black = p("black.mp4");
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", black]);
      // Two different characters at block-aligned spots. Missing glyphs all
      // draw the same box, so with Inter the two crops match; real glyphs differ.
      const items = [
        { type: "text" as const, x: 16, y: 16, text: "日", size: 64, background: false },
        { type: "text" as const, x: 16, y: 128, text: "本", size: 64, background: false },
      ];
      const render = async (name: string, fontFile?: string) => {
        const work = mkdtempSync(join(dir, `${name}-`));
        const assets = await prepareCalloutAssets(items, work, "", fontFile);
        const out = p(`${name}.mp4`);
        await runFfmpeg(buildCalloutArgs(black, out, items, assets, "high"));
        return { out, assets };
      };
      const meanDiff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;
      const glyphs = (out: string): [Buffer, Buffer] => [regionPixels(out, 0.5, 16, 16, 96, 96), regionPixels(out, 0.5, 16, 128, 96, 96)];

      const tofu = await render("ja-tofu", bundledFontPath("bold"));
      expect(tofu.assets.warnings.join(" ")).toMatch(/no glyph for 日/);
      const [t1, t2] = glyphs(tofu.out);
      expect(meanDiff(t1, t2)).toBeLessThan(1);

      const real = await render("ja-fallback");
      expect(real.assets.warnings).toEqual([]);
      expect(real.assets.fallbackFonts.map((f) => f.item)).toEqual([0, 1]);
      const [g1, g2] = glyphs(real.out);
      // Ink is present, the two characters differ, and neither is the box.
      expect(Math.max(...g1)).toBeGreaterThan(200);
      expect(meanDiff(g1, g2)).toBeGreaterThan(5);
      expect(meanDiff(g1, t1)).toBeGreaterThan(5);
    },
  );

  it("redact_region box fills the region solid", async () => {
    const out = p("redact.mp4");
    await runFfmpeg(buildRedactArgs(av, out, [{ x: 0, y: 0, width: 64, height: 64 }], {}, { width: 320, height: 240 }));
    // testsrc is bright/colourful in the top-left; a solid black box reads ~0.
    expect(regionLuma(out, 1, 8, 8, 48, 48)).toBeLessThan(10);
    expect(regionLuma(av, 1, 8, 8, 48, 48)).toBeGreaterThan(20);
  });

  it("blur and pixelate wipe the detail of a thin text-line region (#204)", async () => {
    // Dense noise: nearly every pixel is a sharp edge, like small text.
    const noisy = p("noise.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=gray:size=320x240:rate=30:d=2,noise=alls=100:allf=t",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p", noisy,
    ]);
    // A text line (blur used to get radius 4) and a short token (pixelate used
    // to make 4 px blocks, about two per character).
    const shapes = [
      { x: 10, y: 100, width: 300, height: 18 },
      { x: 40, y: 160, width: 64, height: 16 },
    ];
    // A mosaic keeps edges only at its block borders: 1 in 16 columns at most.
    const limits = { blur: 0.02, pixelate: 1 / 12, box: 0.001 } as const;
    for (const [n, r] of shapes.entries()) {
      const inner = (f: string) => regionDetail(f, 1, r.x + 4, r.y + 2, r.width - 8, r.height - 4);
      expect(inner(noisy)).toBeGreaterThan(0.5);
      for (const style of ["blur", "pixelate", "box"] as const) {
        const out = p(`strength-${n}-${style}.mp4`);
        await runFfmpeg(buildRedactArgs(noisy, out, [r], { style }, { width: 320, height: 240 }));
        expect(inner(out), `${style} ${r.width}x${r.height}`).toBeLessThan(limits[style]);
      }
    }
  });

  it("redacts several regions, each only inside its own time window (#204)", async () => {
    const out = p("redact-windows.mp4");
    await runFfmpeg(
      buildRedactArgs(
        av,
        out,
        [
          { x: 0, y: 0, width: 64, height: 64, start: 0, end: 3 },
          { x: 200, y: 100, width: 64, height: 64, start: 5 },
        ],
        {},
        { width: 320, height: 240 },
      ),
    );
    expect(regionLuma(out, 1, 8, 8, 48, 48)).toBeLessThan(10);
    expect(regionLuma(out, 6, 8, 8, 48, 48)).toBeGreaterThan(20);
    expect(regionLuma(out, 6, 208, 108, 48, 48)).toBeLessThan(10);
    expect(regionLuma(out, 1, 208, 108, 48, 48)).toBeGreaterThan(20);
  });

  it("redacts a rotated input in its displayed frame (#204)", async () => {
    // A 320x240 file tagged to display rotated by 90 degrees, i.e. as 240x320.
    const rot = p("rotated.mp4");
    await runFfmpeg(["-y", "-display_rotation", "90", "-i", vOnly, "-c", "copy", rot]);
    const info = await probeMedia(rot);
    expect([info.width, info.height]).toEqual([240, 320]);
    // Only inside the displayed frame: y + h = 314 > the stored height of 240.
    const box = { x: 176, y: 250, width: 64, height: 64 };
    const out = p("rotated-redact.mp4");
    await runFfmpeg(buildRedactArgs(rot, out, [box], {}, info));
    expect(regionMaxLuma(out, 1, box.x, box.y, box.width, box.height)).toBeLessThan(20);
    expect(regionLuma(rot, 1, box.x, box.y, box.width, box.height)).toBeGreaterThan(20);
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
    for (const [i, t] of times.entries()) {
      const label = join(work, `l${i}.txt`);
      writeFileSync(label, formatTimecode(t));
      await runFfmpeg(buildTileArgs(av, t, join(work, `tile_${String(i).padStart(3, "0")}.png`), 160, bundledFontPath("bold"), label));
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
    await runFfmpeg(buildAnimArgs(av, big, "gif", defined(ladder[0]), { duration: 3 }));
    await runFfmpeg(buildAnimArgs(av, small, "gif", ladder.at(-1)!, { duration: 3 }));
    const bigInfo = await probeMedia(big);
    expect(bigInfo.videoCodec).toBe("gif");
    expect(bigInfo.width).toBe(320);
    expect(statSync(small).size).toBeLessThan(statSync(big).size / 2);

    const webp = p("anim.webp");
    await runFfmpeg(buildAnimArgs(av, webp, "webp", defined(animLadder("webp", 12, 320)[0]), { duration: 3 }));
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
    const r = defined(d.regions[0]);
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
    expect(images[0]?.mimeType).toBe("image/jpeg");
    const decoded = p("decoded.jpg");
    writeFileSync(decoded, Buffer.from(defined(images[0]).data, "base64"));
    const info = await probeMedia(decoded);
    expect([info.width, info.height]).toEqual([200, 150]);
  });
});
