import { describe, it, expect } from "vitest";
import {
  parseFrameRate,
  parseMediaInfo,
  buildProbeArgs,
  buildSampleByFpsArgs,
  planFpsSampling,
  buildSceneScanArgs,
  parseSceneScan,
  pickSceneFrames,
  DEFAULT_MAX_FRAMES,
  buildSampleAtTimestampArgs,
  buildTrimArgs,
  buildConcatListContent,
  buildConcatArgs,
  buildConvertArgs,
  enableExpr,
  buildCropArgs,
  buildScaleArgs,
  atempoChain,
  buildSpeedArgs,
  buildOverlayArgs,
  blurRadius,
  pixelateFilter,
  editOutputExt,
  assertEditContainer,
  isAudioOnlyPath,
  hasHiddenFrames,
  concatCopyBlocker,
  type MediaInfo,
  buildCompressArgs,
  buildExtractAudioArgs,
  buildClipArgs,
  copyAudioExtension,
} from "../utils/media.js";

describe("parseFrameRate", () => {
  it("parses rational and integer rates", () => {
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("25")).toBe(25);
  });
  it("returns null for unusable rates", () => {
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate("0/1")).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });
});

describe("parseMediaInfo", () => {
  it("flattens an ffprobe document", () => {
    const probe = {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          avg_frame_rate: "30/1",
        },
        { codec_type: "audio", codec_name: "aac" },
      ],
      format: { duration: "12.5", format_name: "mov,mp4,m4a", size: "1048576" },
    };
    expect(parseMediaInfo(probe)).toEqual({
      durationSec: 12.5,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      format: "mov,mp4,m4a",
      sizeBytes: 1048576,
      videoDurationSec: 12.5,
      pixFmt: null,
      videoFrames: null,
      sampleRate: null,
      channels: null,
    });
  });

  it("tolerates a video-only file", () => {
    const info = parseMediaInfo({
      streams: [{ codec_type: "video", codec_name: "h264", width: 800, height: 600, r_frame_rate: "60/1" }],
      format: { duration: "1.0" },
    });
    expect(info.audioCodec).toBeNull();
    expect(info.fps).toBe(60);
    expect(info.sizeBytes).toBeNull();
  });
});

describe("probe and sample arg builders", () => {
  it("builds probe args", () => {
    expect(buildProbeArgs("a.mp4")).toContain("-show_streams");
    expect(buildProbeArgs("a.mp4")[buildProbeArgs("a.mp4").length - 1]).toBe("a.mp4");
  });
  it("samples by fps with a -frames:v backstop", () => {
    const a = buildSampleByFpsArgs("in.mp4", 2, "out/frame_%05d.png");
    expect(a.join(" ")).toContain("-vf fps=2");
    expect(a.join(" ")).toContain(`-frames:v ${DEFAULT_MAX_FRAMES}`);
    expect(buildSampleByFpsArgs("in.mp4", 2, "p.png", 7).join(" ")).toContain("-frames:v 7");
  });
  it("rejects a non-positive fps", () => {
    expect(() => buildSampleByFpsArgs("in.mp4", 0, "p.png")).toThrow();
  });
  it("planFpsSampling keeps a rate that fits under the cap (#80)", () => {
    expect(planFpsSampling(10, 2, 100)).toEqual({ fps: 2, requestedFrames: 20, clamped: false });
  });
  it("planFpsSampling lowers a rate that would exceed the cap, spanning the video (#80)", () => {
    // 30 fps on a 1-hour recording would be 108,000 frames.
    const plan = planFpsSampling(3600, 30, 100);
    expect(plan.clamped).toBe(true);
    expect(plan.requestedFrames).toBe(108_000);
    expect(Math.ceil(3600 * plan.fps)).toBeLessThanOrEqual(100);
    expect(plan.fps).toBeGreaterThan(0.027);
  });
  it("planFpsSampling leaves the rate alone when the duration is unknown", () => {
    expect(planFpsSampling(null, 30, 100)).toEqual({ fps: 30, requestedFrames: null, clamped: false });
  });
  it("samples at a timestamp", () => {
    const a = buildSampleAtTimestampArgs("in.mp4", 3.5, "f.png");
    expect(a.join(" ")).toContain("-ss 3.5");
    expect(a.join(" ")).toContain("-frames:v 1");
    // A % in the name stays literal instead of becoming a sequence (#238).
    expect(a.slice(-3)).toEqual(["-update", "1", "f.png"]);
  });
  it("rejects a negative timestamp", () => {
    expect(() => buildSampleAtTimestampArgs("in.mp4", -1, "f.png")).toThrow();
  });
});

describe("buildTrimArgs", () => {
  it("trims by start + end", () => {
    const a = buildTrimArgs("in.mp4", "out.mp4", { start: 2, end: 6 });
    expect(a.join(" ")).toContain("-ss 2");
    // -to after an input -ss acts as a duration; the builder emits end - start.
    expect(a.join(" ")).toContain("-t 4");
    expect(a).not.toContain("-to");
    // Re-encodes by default so nothing before start ships in the file (#203).
    expect(a.join(" ")).toContain("-c:v libx264");
    expect(a.join(" ")).not.toContain("-c copy");
  });
  it("stream-copies only with exact: false", () => {
    const a = buildTrimArgs("in.mp4", "out.mp4", { start: 2, end: 6, exact: false });
    expect(a.join(" ")).toContain("-c copy");
    expect(a.join(" ")).not.toContain("libx264");
  });
  it("trims by start + duration", () => {
    const a = buildTrimArgs("in.mp4", "out.mp4", { start: 2, duration: 4 });
    expect(a.join(" ")).toContain("-t 4");
  });
  it("rejects bad combinations", () => {
    expect(() => buildTrimArgs("i", "o", { start: 0 })).toThrow();
    expect(() => buildTrimArgs("i", "o", { start: 0, end: 5, duration: 5 })).toThrow();
    expect(() => buildTrimArgs("i", "o", { start: 5, end: 2 })).toThrow();
  });
});

describe("concat", () => {
  it("builds a list file with escaping", () => {
    const list = buildConcatListContent(["a.mp4", "b's.mp4"]);
    expect(list).toContain("file 'a.mp4'");
    // A single quote in a path is escaped for the concat demuxer as '\''.
    expect(list).toContain("b'\\''s.mp4");
  });
  it("requires at least two inputs", () => {
    expect(() => buildConcatListContent(["only.mp4"])).toThrow();
  });
  it("builds concat args", () => {
    expect(buildConcatArgs("list.txt", "out.mp4").join(" ")).toContain("-f concat");
  });
});

describe("buildConvertArgs", () => {
  it("uses a palette filter for gif", () => {
    expect(buildConvertArgs("in.mp4", "o.gif", "gif").join(" ")).toContain("palettegen");
  });
  it("uses vp9 for webm", () => {
    expect(buildConvertArgs("in.mp4", "o.webm", "webm").join(" ")).toContain("libvpx-vp9");
  });
  it("uses h264 + faststart for mp4", () => {
    const s = buildConvertArgs("in.webm", "o.mp4", "mp4").join(" ");
    expect(s).toContain("libx264");
    expect(s).toContain("+faststart");
  });
});

describe("enableExpr", () => {
  it("builds between/gte/lte and an always-on empty string", () => {
    expect(enableExpr(1, 3)).toBe("between(t,1,3)");
    expect(enableExpr(2, undefined)).toBe("gte(t,2)");
    expect(enableExpr(undefined, 5)).toBe("lte(t,5)");
    expect(enableExpr()).toBe("");
  });
  it("rejects end <= start", () => {
    expect(() => enableExpr(5, 2)).toThrow();
  });
});

describe("buildCropArgs", () => {
  it("builds a crop filter and re-encodes", () => {
    const s = buildCropArgs("in.mp4", "o.mp4", { x: 10, y: 20, width: 100, height: 50 }).join(" ");
    expect(s).toContain("crop=100:50:10:20");
    expect(s).toContain("libx264");
    expect(s).toContain("-c:a copy");
  });
  it("rejects a region that runs off the frame", () => {
    expect(() =>
      buildCropArgs("in.mp4", "o.mp4", { x: 1900, y: 0, width: 100, height: 50 }, { width: 1920, height: 1080 }),
    ).toThrow(/outside/);
  });
  it("rejects non-integer or non-positive dimensions", () => {
    expect(() => buildCropArgs("i", "o", { x: 0, y: 0, width: 0, height: 50 })).toThrow();
    expect(() => buildCropArgs("i", "o", { x: -1, y: 0, width: 10, height: 10 })).toThrow();
  });
  it("rejects odd dimensions with a clear error (yuv420p needs even)", () => {
    expect(() => buildCropArgs("i", "o", { x: 0, y: 0, width: 101, height: 100 })).toThrow(/even/);
    expect(() => buildCropArgs("i", "o", { x: 0, y: 0, width: 100, height: 101 })).toThrow(/even/);
  });
});

describe("buildScaleArgs", () => {
  it("uses -2 for the omitted side", () => {
    expect(buildScaleArgs("in.mp4", "o.mp4", { width: 1280 }).join(" ")).toContain("scale=1280:-2");
    expect(buildScaleArgs("in.mp4", "o.mp4", { height: 720 }).join(" ")).toContain("scale=-2:720");
  });
  it("requires at least one side", () => {
    expect(() => buildScaleArgs("i", "o", {})).toThrow();
  });
  it("rejects an explicit odd dimension (the omitted side is safe via -2)", () => {
    expect(() => buildScaleArgs("i", "o", { width: 101, height: 101 })).toThrow(/even/);
    expect(() => buildScaleArgs("i", "o", { width: 101 })).toThrow(/even/);
    expect(buildScaleArgs("i", "o", { width: 100 }).join(" ")).toContain("scale=100:-2");
  });
});

describe("copyAudioExtension", () => {
  it("maps each codec family to a container that can hold it", () => {
    expect(copyAudioExtension("aac")).toBe("m4a");
    expect(copyAudioExtension("alac")).toBe("m4a");
    expect(copyAudioExtension("mp3")).toBe("mp3");
    expect(copyAudioExtension("opus")).toBe("ogg");
    expect(copyAudioExtension("vorbis")).toBe("ogg");
    expect(copyAudioExtension("flac")).toBe("flac");
    expect(copyAudioExtension("pcm_s16le")).toBe("wav");
  });
  it("falls back to Matroska audio for anything unrecognized", () => {
    expect(copyAudioExtension("ac3")).toBe("mka");
    expect(copyAudioExtension(null)).toBe("mka");
  });
});

describe("atempoChain / buildSpeedArgs", () => {
  it("keeps a single atempo within range", () => {
    expect(atempoChain(1.5)).toBe("atempo=1.5");
  });
  it("chains atempo stages beyond the 0.5-2.0 range", () => {
    expect(atempoChain(4)).toBe("atempo=2.0,atempo=2");
    expect(atempoChain(0.25)).toBe("atempo=0.5,atempo=0.5");
  });
  it("retempos audio when present and drops it otherwise", () => {
    const withAudio = buildSpeedArgs("in.mp4", "o.mp4", 2, true).join(" ");
    expect(withAudio).toContain("setpts=PTS/2");
    expect(withAudio).toContain("atempo=2");
    expect(withAudio).toContain("-c:a aac");
    const noAudio = buildSpeedArgs("in.mp4", "o.mp4", 2, false).join(" ");
    expect(noAudio).toContain("-an");
  });
  it("rejects a non-positive factor", () => {
    expect(() => buildSpeedArgs("i", "o", 0, false)).toThrow();
  });
});

describe("buildOverlayArgs", () => {
  it("composites a second input at x:y", () => {
    const s = buildOverlayArgs("base.mp4", "logo.png", "o.mp4", { x: 12, y: 8 }).join(" ");
    expect(s).toContain("-i base.mp4");
    expect(s).toContain("-i logo.png");
    expect(s).toContain("[0:v][ovl]overlay=12:8[v]");
    // The main input's audio, not the overlay's (#188).
    expect(s).toContain("-map [v] -map 0:a?");
  });
  it("starts the overlay's clock at start and caps the output at the main length (#230, #188)", () => {
    const s = buildOverlayArgs("base.mp4", "pip.mp4", "o.mp4", { x: 0, y: 0, start: 3, end: 5, durationSec: 6 }).join(" ");
    expect(s).toContain("[1:v]setpts=PTS-STARTPTS+3/TB[ovl]");
    expect(s).toContain("-t 6");
  });
  it("scales the overlay and time-gates it", () => {
    const s = buildOverlayArgs("base.mp4", "logo.png", "o.mp4", {
      x: 0, y: 0, start: 1, end: 4, scale: { width: 200 },
    }).join(" ");
    expect(s).toContain("[1:v]setpts=PTS-STARTPTS+1/TB,scale=200:-1[ovl]");
    expect(s).toContain("enable='between(t,1,4)'");
  });
});

describe("buildCompressArgs", () => {
  it("maps levels to a CRF ladder", () => {
    expect(buildCompressArgs("in.mp4", "o.mp4", { level: "light" }).join(" ")).toContain("-crf 23");
    expect(buildCompressArgs("in.mp4", "o.mp4").join(" ")).toContain("-crf 28");
    expect(buildCompressArgs("in.mp4", "o.mp4", { level: "heavy" }).join(" ")).toContain("-crf 32");
  });
  it("only downscales with the width cap", () => {
    expect(buildCompressArgs("in.mp4", "o.mp4", { maxWidth: 1280 }).join(" ")).toContain("scale='trunc(min(1280,iw)/2)*2':-2");
  });
  it("rounds an odd width cap down to even (#239)", () => {
    expect(buildCompressArgs("in.mp4", "o.mp4", { maxWidth: 637 }).join(" ")).toContain("scale='trunc(min(637,iw)/2)*2':-2");
  });
});

describe("buildExtractAudioArgs", () => {
  it("strips video and selects the codec", () => {
    expect(buildExtractAudioArgs("in.mp4", "o.mp3", "mp3").join(" ")).toContain("libmp3lame");
    expect(buildExtractAudioArgs("in.mp4", "o.wav", "wav").join(" ")).toContain("pcm_s16le");
    expect(buildExtractAudioArgs("in.mp4", "o.m4a", "copy").join(" ")).toContain("-c:a copy");
    expect(buildExtractAudioArgs("in.mp4", "o.mp3", "mp3").join(" ")).toContain("-vn");
  });
});

describe("buildClipArgs", () => {
  it("re-encodes a frame-accurate segment with -ss + -t", () => {
    const s = buildClipArgs("in.mp4", "o.mp4", { start: 2, end: 6 }).join(" ");
    expect(s).toContain("-ss 2");
    expect(s).toContain("-t 4");
    expect(s).toContain("libx264");
    expect(s).not.toContain("-c copy");
  });
  it("rejects end <= start", () => {
    expect(() => buildClipArgs("i", "o", { start: 5, end: 5 })).toThrow();
  });
});

describe("scene sampling (#114)", () => {
  it("builds a low-res scene scan with the threshold escaped for the filtergraph", () => {
    const a = buildSceneScanArgs("in.mp4", 0.2);
    expect(a[a.indexOf("-vf") + 1]).toBe(String.raw`scale=320:-2,select='gt(scene\,0.2)',metadata=print:file=-`);
    expect(() => buildSceneScanArgs("in.mp4", 0)).toThrow(/between 0 and 1/);
    expect(() => buildSceneScanArgs("in.mp4", 1)).toThrow(/between 0 and 1/);
  });
  it("parses metadata=print output into time/score pairs", () => {
    const out = "frame:0    pts:30720   pts_time:2\nlavfi.scene_score=0.400000\r\nframe:1    pts:61440   pts_time:4.5\nlavfi.scene_score=0.906905\n";
    expect(parseSceneScan(out)).toEqual([{ timeSec: 2, score: 0.4 }, { timeSec: 4.5, score: 0.906905 }]);
    expect(parseSceneScan("")).toEqual([]);
  });
  it("keeps the opening frame plus the strongest changes, in time order", () => {
    const changes = [
      { timeSec: 1, score: 0.2 }, { timeSec: 2, score: 0.9 }, { timeSec: 3, score: 0.5 }, { timeSec: 4, score: 0.1 },
    ];
    expect(pickSceneFrames(changes, 3)).toEqual([0, 2, 3]);
    expect(pickSceneFrames(changes, 100)).toEqual([0, 1, 2, 3, 4]);
    expect(pickSceneFrames([], 10)).toEqual([0]);
    expect(pickSceneFrames(changes, 1)).toEqual([0]);
  });
  it("dedupe adds mpdecimate and variable-rate output", () => {
    const a = buildSampleByFpsArgs("in.mp4", 2, "p_%05d.png", 50, true).join(" ");
    expect(a).toContain("-vf fps=2,mpdecimate");
    expect(a).toContain("-fps_mode vfr");
  });
});

describe("blurRadius (#188)", () => {
  it("keeps both planes' radii legal on tiny regions", () => {
    expect(blurRadius({ w: 4, h: 4 })).toBe("lr=2:lp=3:cr=1:cp=3");
    expect(blurRadius({ w: 2, h: 6 })).toBe("lr=1:lp=3:cr=0:cp=3");
  });
  it("never goes below the minimum radius where the region allows it (#204)", () => {
    expect(blurRadius({ w: 300, h: 18 })).toBe("lr=8:lp=3:cr=4:cp=3"); // was lr=4, often readable
    expect(blurRadius({ w: 40, h: 40 })).toBe("lr=10:lp=3:cr=10:cp=3");
    expect(blurRadius({ w: 400, h: 300 })).toBe("lr=20:lp=3:cr=20:cp=3");
  });
});

describe("pixelate blocks (#204)", () => {
  it("uses blocks of at least 16 px, square, whatever the region's size", () => {
    expect(pixelateFilter({ w: 64, h: 16 })).toBe("scale=4:1:flags=area,scale=64:16:flags=neighbor");
    expect(pixelateFilter({ w: 300, h: 18 })).toBe("scale=16:1:flags=area,scale=300:18:flags=neighbor");
    expect(pixelateFilter({ w: 800, h: 400 })).toBe("scale=16:8:flags=area,scale=800:400:flags=neighbor");
    expect(pixelateFilter({ w: 8, h: 8 })).toBe("scale=1:1:flags=area,scale=8:8:flags=neighbor");
  });
});

describe("display size of rotated video (#204)", () => {
  const probe = (side: unknown) => ({
    streams: [{ codec_type: "video", width: 320, height: 240, side_data_list: side } as never],
    format: {},
  });
  it("swaps width and height for a 90-degree display matrix", () => {
    const info = parseMediaInfo(probe([{ side_data_type: "Display Matrix", rotation: -90 }]));
    expect(info).toMatchObject({ width: 240, height: 320, rotation: -90 });
    expect(parseMediaInfo(probe([{ rotation: 180 }]))).toMatchObject({ width: 320, height: 240, rotation: 180 });
    expect(parseMediaInfo(probe(undefined)).rotation).toBeUndefined();
  });
});

describe("edit output containers (#187)", () => {
  it("maps inputs whose container cannot hold H.264/AAC to .mp4", () => {
    expect(editOutputExt("in.webm")).toBe(".mp4");
    expect(editOutputExt("in.MKV")).toBe(".mkv");
    expect(editOutputExt("in")).toBe(".mp4");
  });
  it("keeps audio-only containers for audio tools", () => {
    expect(editOutputExt("voice.wav", { audio: true })).toBe(".wav");
    expect(editOutputExt("voice.wav")).toBe(".mp4");
    expect(isAudioOnlyPath("out.MP3")).toBe(true);
    expect(isAudioOnlyPath("out.mp4")).toBe(false);
  });
  it("rejects an explicit .webm output with a clear message", () => {
    expect(() => assertEditContainer("out.webm")).toThrow(/cannot hold/);
    expect(() => assertEditContainer("out.mp4")).not.toThrow();
    expect(() => assertEditContainer(undefined)).not.toThrow();
  });
});

describe("concat stream-copy checks (#206, #203)", () => {
  const base: MediaInfo = {
    durationSec: 3, videoDurationSec: 3, width: 320, height: 240, fps: 30,
    videoCodec: "h264", audioCodec: "aac", format: "mov,mp4,m4a", sizeBytes: 1,
    pixFmt: "yuv420p", videoFrames: 90, sampleRate: 48000, channels: 2,
  };
  it("allows a copy for matching inputs", () => {
    expect(concatCopyBlocker(["a", "b"], [base, { ...base }])).toBeNull();
  });
  it("names the first differing field", () => {
    expect(concatCopyBlocker(["a", "b"], [base, { ...base, width: 640 }])).toMatch(/width differs/);
    expect(concatCopyBlocker(["a", "b"], [base, { ...base, audioCodec: null, sampleRate: null, channels: null }])).toMatch(/audio codec/);
  });
  it("flags frames hidden behind an edit list", () => {
    // A stream-copy trim: 3 s at 30 fps playing, 300 packets in the file.
    const trimmed = { ...base, videoFrames: 300 };
    expect(hasHiddenFrames(trimmed)).toBe(true);
    expect(hasHiddenFrames(base)).toBe(false);
    expect(concatCopyBlocker(["a", "b"], [base, trimmed])).toMatch(/hidden frames/);
  });
});
