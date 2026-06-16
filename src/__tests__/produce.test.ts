import { describe, it, expect } from "vitest";
import {
  xfadeOffsets,
  videoNormalizeChain,
  buildXfadeArgs,
  buildAssembleArgs,
  buildTitleCardArgs,
  buildMusicBedArgs,
  reframeFilter,
  buildReframeArgs,
  buildExportPresetArgs,
  PLATFORM_PRESETS,
  ASPECT_DIMS,
} from "../utils/produce.js";

describe("xfadeOffsets", () => {
  it("computes cumulative offsets for an xfade chain", () => {
    // durations 5, 4, 6 with a 1s transition:
    //   join clip 1: 5 - 1 = 4
    //   join clip 2: (5 + 4) - 2 = 7
    expect(xfadeOffsets([5, 4, 6], 1)).toEqual([4, 7]);
  });
  it("returns one offset per join and never goes negative", () => {
    expect(xfadeOffsets([2, 2], 1)).toEqual([1]);
    expect(xfadeOffsets([0.5, 5], 1)).toEqual([0]);
  });
});

describe("videoNormalizeChain", () => {
  it("fits, letterboxes, squares pixels, and pins fps", () => {
    const c = videoNormalizeChain(1920, 1080, 30);
    expect(c).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(c).toContain("pad=1920:1080");
    expect(c).toContain("setsar=1");
    expect(c).toContain("fps=30");
  });
});

describe("buildXfadeArgs", () => {
  it("sets the offset from the first clip duration and maps video only without audio", () => {
    const s = buildXfadeArgs("a.mp4", "b.mp4", 5, "o.mp4", { duration: 1 }, false).join(" ");
    expect(s).toContain("xfade=transition=fade:duration=1:offset=4");
    expect(s).toContain("-map [vout]");
    expect(s).toContain("-an");
    expect(s).not.toContain("acrossfade");
  });
  it("adds an audio crossfade when both clips have audio", () => {
    const s = buildXfadeArgs("a.mp4", "b.mp4", 5, "o.mp4", { transition: "wipeleft" }, true).join(" ");
    expect(s).toContain("transition=wipeleft");
    expect(s).toContain("acrossfade=d=1");
    expect(s).toContain("-map [aout]");
    expect(s).toContain("-c:a aac");
  });
  it("rejects a first clip shorter than the transition", () => {
    expect(() => buildXfadeArgs("a", "b", 0.5, "o", { duration: 1 })).toThrow();
  });
});

describe("buildAssembleArgs", () => {
  it("uses the concat filter for hard cuts", () => {
    const s = buildAssembleArgs(["a.mp4", "b.mp4", "c.mp4"], [3, 3, 3], "o.mp4", {}, true).join(" ");
    expect(s).toContain("concat=n=3:v=1:a=1[vout][aout]");
    expect(s).toContain("-i a.mp4");
    expect(s).toContain("-i c.mp4");
  });
  it("chains xfade with cumulative offsets for a named transition", () => {
    const s = buildAssembleArgs(["a", "b", "c"], [5, 4, 6], "o.mp4", { transition: "fade", duration: 1 }, false).join(" ");
    expect(s).toContain("[v0][v1]xfade=transition=fade:duration=1:offset=4");
    expect(s).toContain("xfade=transition=fade:duration=1:offset=7[vout]");
  });
  it("requires at least two clips", () => {
    expect(() => buildAssembleArgs(["only.mp4"], [3], "o.mp4")).toThrow();
  });
  it("requires a duration per clip for an xfade transition", () => {
    expect(() => buildAssembleArgs(["a", "b"], [5], "o.mp4", { transition: "fade" })).toThrow();
  });
});

describe("buildTitleCardArgs", () => {
  it("builds a color source, a silent track, and centered drawtext", () => {
    const s = buildTitleCardArgs("text.txt", "font.ttf", "o.mp4", { duration: 4 }).join(" ");
    expect(s).toContain("color=c=black:s=1920x1080:d=4");
    expect(s).toContain("anullsrc");
    expect(s).toContain("drawtext=fontfile=font.ttf:textfile=text.txt");
    expect(s).toContain("x=(w-text_w)/2:y=(h-text_h)/2");
    expect(s).toContain("-shortest");
  });
  it("rejects a non-positive duration or fontSize", () => {
    expect(() => buildTitleCardArgs("t", "f", "o", { duration: 0 })).toThrow();
    expect(() => buildTitleCardArgs("t", "f", "o", { fontSize: 0 })).toThrow();
  });
});

describe("buildMusicBedArgs", () => {
  it("loops the music, fades, levels, and mixes when the video has audio", () => {
    const s = buildMusicBedArgs("v.mp4", "m.mp3", "o.mp4", 10, true, { musicVolume: 0.3, fadeOut: 2 }).join(" ");
    expect(s).toContain("-stream_loop -1 -i m.mp3");
    expect(s).toContain("afade=t=in:st=0:d=1");
    expect(s).toContain("afade=t=out:st=8:d=2");
    expect(s).toContain("volume=0.3");
    expect(s).toContain("amix=inputs=2");
    expect(s).toContain("-c:v copy");
    expect(s).toContain("-t 10");
  });
  it("ducks via a sidechain when requested", () => {
    const s = buildMusicBedArgs("v.mp4", "m.mp3", "o.mp4", 10, true, { duck: true }).join(" ");
    expect(s).toContain("sidechaincompress");
  });
  it("uses the music as the only track when the video has no audio", () => {
    const s = buildMusicBedArgs("v.mp4", "m.mp3", "o.mp4", 10, false).join(" ");
    expect(s).not.toContain("amix");
    expect(s).toContain("[aout]");
  });
  it("requires a known positive video duration", () => {
    expect(() => buildMusicBedArgs("v", "m", "o", 0, true)).toThrow();
  });
});

describe("reframeFilter / buildReframeArgs", () => {
  it("pads (scale-to-fit + letterbox) by default", () => {
    const f = reframeFilter(1080, 1920, "pad");
    expect(f).toContain("force_original_aspect_ratio=decrease");
    expect(f).toContain("pad=1080:1920");
  });
  it("crops (scale-to-fill + center crop)", () => {
    const f = reframeFilter(1080, 1080, "crop");
    expect(f).toContain("force_original_aspect_ratio=increase");
    expect(f).toContain("crop=1080:1080");
  });
  it("maps each aspect to canonical dimensions and re-encodes", () => {
    const s = buildReframeArgs("in.mp4", "o.mp4", "9:16", "pad").join(" ");
    expect(s).toContain(`pad=${ASPECT_DIMS["9:16"].w}:${ASPECT_DIMS["9:16"].h}`);
    expect(s).toContain("libx264");
    expect(s).toContain("-c:a copy");
  });
  it("rejects an unknown aspect", () => {
    // @ts-expect-error testing a bad value at runtime
    expect(() => buildReframeArgs("i", "o", "3:2")).toThrow();
  });
});

describe("buildExportPresetArgs / PLATFORM_PRESETS", () => {
  it("applies the platform aspect, fps, and bitrate", () => {
    const s = buildExportPresetArgs("in.mp4", "o.mp4", "tiktok").join(" ");
    const p = PLATFORM_PRESETS.tiktok;
    expect(s).toContain(`pad=${ASPECT_DIMS[p.aspect].w}:${ASPECT_DIMS[p.aspect].h}`);
    expect(s).toContain(`-b:v ${p.videoBitrate}`);
    expect(s).toContain(`-r ${p.fps}`);
    expect(s).toContain("+faststart");
  });
  it("covers every platform with a 16:9 / 9:16 / 1:1 aspect", () => {
    for (const platform of Object.keys(PLATFORM_PRESETS) as Array<keyof typeof PLATFORM_PRESETS>) {
      const spec = PLATFORM_PRESETS[platform];
      expect(ASPECT_DIMS[spec.aspect]).toBeDefined();
    }
  });
  it("rejects an unknown platform", () => {
    // @ts-expect-error testing a bad value at runtime
    expect(() => buildExportPresetArgs("i", "o", "myspace")).toThrow();
  });
});
