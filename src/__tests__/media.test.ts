import { describe, it, expect } from "vitest";
import {
  parseFrameRate,
  parseMediaInfo,
  buildProbeArgs,
  buildSampleByFpsArgs,
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
  buildCompressArgs,
  buildExtractAudioArgs,
  buildClipArgs,
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
  it("samples by fps", () => {
    const a = buildSampleByFpsArgs("in.mp4", 2, "out/frame_%05d.png");
    expect(a.join(" ")).toContain("-vf fps=2");
  });
  it("rejects a non-positive fps", () => {
    expect(() => buildSampleByFpsArgs("in.mp4", 0, "p.png")).toThrow();
  });
  it("samples at a timestamp", () => {
    const a = buildSampleAtTimestampArgs("in.mp4", 3.5, "f.png");
    expect(a.join(" ")).toContain("-ss 3.5");
    expect(a.join(" ")).toContain("-frames:v 1");
  });
  it("rejects a negative timestamp", () => {
    expect(() => buildSampleAtTimestampArgs("in.mp4", -1, "f.png")).toThrow();
  });
});

describe("buildTrimArgs", () => {
  it("trims by start + end", () => {
    const a = buildTrimArgs("in.mp4", "out.mp4", { start: 2, end: 6 });
    expect(a.join(" ")).toContain("-ss 2");
    expect(a.join(" ")).toContain("-to 6");
    expect(a.join(" ")).toContain("-c copy");
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
});

describe("buildScaleArgs", () => {
  it("uses -2 for the omitted side", () => {
    expect(buildScaleArgs("in.mp4", "o.mp4", { width: 1280 }).join(" ")).toContain("scale=1280:-2");
    expect(buildScaleArgs("in.mp4", "o.mp4", { height: 720 }).join(" ")).toContain("scale=-2:720");
  });
  it("requires at least one side", () => {
    expect(() => buildScaleArgs("i", "o", {})).toThrow();
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
    expect(s).toContain("[0:v][1:v]overlay=12:8");
  });
  it("scales the overlay and time-gates it", () => {
    const s = buildOverlayArgs("base.mp4", "logo.png", "o.mp4", {
      x: 0, y: 0, start: 1, end: 4, scale: { width: 200 },
    }).join(" ");
    expect(s).toContain("[1:v]scale=200:-1[ovl]");
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
    expect(buildCompressArgs("in.mp4", "o.mp4", { maxWidth: 1280 }).join(" ")).toContain("scale='min(1280,iw)':-2");
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
