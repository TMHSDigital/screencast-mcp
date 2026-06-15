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
