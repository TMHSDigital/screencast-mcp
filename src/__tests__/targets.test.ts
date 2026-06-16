import { describe, it, expect } from "vitest";
import {
  parseTarget,
  resolveQuality,
  buildCaptureArgs,
  buildScreenshotArgs,
  buildAudioInputArgs,
  resolveMonitor,
  QUALITY_PRESETS,
} from "../utils/targets.js";
import type { Monitor } from "../utils/monitors.js";

// A 4480x1440 dual-monitor desktop: primary 2560x1440 at origin, second
// 1920x1440 starting at x=2560.
const MONITORS: Monitor[] = [
  { index: 0, x: 0, y: 0, width: 2560, height: 1440, primary: true },
  { index: 1, x: 2560, y: 0, width: 1920, height: 1440, primary: false },
];

describe("buildAudioInputArgs", () => {
  it("returns no args when audio is absent or empty", () => {
    expect(buildAudioInputArgs()).toEqual([]);
    expect(buildAudioInputArgs({ device: "" })).toEqual([]);
  });
  it("builds a dshow input with an unquoted device spec", () => {
    expect(buildAudioInputArgs({ device: "virtual-audio-capturer" })).toEqual([
      "-f", "dshow", "-i", "audio=virtual-audio-capturer",
    ]);
  });
});

describe("buildCaptureArgs audio", () => {
  it("adds a second dshow input and an aac codec when audio is set", () => {
    const a = buildCaptureArgs({ kind: "full" }, {
      output: "o.mp4",
      audio: { device: "Stereo Mix" },
    }).join(" ");
    expect(a).toContain("-f dshow -i audio=Stereo Mix");
    expect(a).toContain("-c:a aac");
  });
  it("omits audio args by default (video-only)", () => {
    const a = buildCaptureArgs({ kind: "full" }, { output: "o.mp4" }).join(" ");
    expect(a).not.toContain("dshow");
    expect(a).not.toContain("-c:a");
  });
});

describe("parseTarget", () => {
  it("parses full (explicit and empty)", () => {
    expect(parseTarget("full")).toEqual({ kind: "full" });
    expect(parseTarget("")).toEqual({ kind: "full" });
    expect(parseTarget("FULL")).toEqual({ kind: "full" });
  });

  it("parses monitor index", () => {
    expect(parseTarget("monitor:1")).toEqual({ kind: "monitor", index: 1 });
  });

  it("parses window title with spaces and colons", () => {
    expect(parseTarget("window:My Game - Level 1")).toEqual({
      kind: "window",
      title: "My Game - Level 1",
    });
  });

  it("parses region", () => {
    expect(parseTarget("region:10,20,640,480")).toEqual({
      kind: "region",
      x: 10,
      y: 20,
      w: 640,
      h: 480,
    });
  });

  it("rejects malformed targets", () => {
    expect(() => parseTarget("monitor:x")).toThrow();
    expect(() => parseTarget("region:1,2,3")).toThrow();
    expect(() => parseTarget("region:1,2,0,480")).toThrow();
    expect(() => parseTarget("window:")).toThrow();
    expect(() => parseTarget("bogus")).toThrow();
  });
});

describe("resolveQuality", () => {
  it("maps each preset to libx264 with its crf", () => {
    for (const q of ["draft", "standard", "high"] as const) {
      const args = resolveQuality(q);
      expect(args).toContain("libx264");
      expect(args).toContain(String(QUALITY_PRESETS[q].crf));
      expect(args).toContain("yuv420p");
    }
  });
});

describe("resolveMonitor", () => {
  it("returns the requested monitor", () => {
    expect(resolveMonitor(1, MONITORS).x).toBe(2560);
  });
  it("throws for an unknown index", () => {
    expect(() => resolveMonitor(5, MONITORS)).toThrow();
  });
});

describe("buildCaptureArgs", () => {
  it("captures the full desktop with gdigrab and fragmented mp4", () => {
    const args = buildCaptureArgs({ kind: "full" }, { output: "out.mp4" });
    expect(args).toContain("gdigrab");
    expect(args.join(" ")).toContain("-i desktop");
    expect(args).toContain("-framerate");
    expect(args.join(" ")).toContain("+frag_keyframe");
    expect(args[args.length - 1]).toBe("out.mp4");
  });

  it("maps monitor:1 to the second display's offset and size", () => {
    const args = buildCaptureArgs(
      { kind: "monitor", index: 1 },
      { output: "m1.mp4", monitors: MONITORS },
    );
    const s = args.join(" ");
    expect(s).toContain("-offset_x 2560");
    expect(s).toContain("-offset_y 0");
    expect(s).toContain("-video_size 1920x1440");
  });

  it("maps monitor:0 to the primary at the origin", () => {
    const s = buildCaptureArgs(
      { kind: "monitor", index: 0 },
      { output: "m0.mp4", monitors: MONITORS },
    ).join(" ");
    expect(s).toContain("-offset_x 0");
    expect(s).toContain("-video_size 2560x1440");
  });

  it("encodes a region as offset + size", () => {
    const s = buildCaptureArgs(
      { kind: "region", x: 100, y: 50, w: 800, h: 600 },
      { output: "r.mp4" },
    ).join(" ");
    expect(s).toContain("-offset_x 100");
    expect(s).toContain("-offset_y 50");
    expect(s).toContain("-video_size 800x600");
  });

  it("rounds an odd region down to even dimensions (libx264 needs even W/H)", () => {
    const s = buildCaptureArgs(
      { kind: "region", x: 10, y: 20, w: 101, h: 101 },
      { output: "odd.mp4" },
    ).join(" ");
    // Offset is unchanged; only the size is rounded down to the nearest even.
    expect(s).toContain("-offset_x 10");
    expect(s).toContain("-offset_y 20");
    expect(s).toContain("-video_size 100x100");
  });

  it("rounds an odd monitor size down to even", () => {
    const s = buildCaptureArgs(
      { kind: "region", x: 0, y: 0, w: 1919, h: 1199 },
      { output: "m.mp4" },
    ).join(" ");
    expect(s).toContain("-video_size 1918x1198");
  });

  it("rejects a region too small to record after even-rounding", () => {
    expect(() =>
      buildCaptureArgs(
        { kind: "region", x: 0, y: 0, w: 1, h: 50 },
        { output: "tiny.mp4" },
      ),
    ).toThrow(/too small to record/);
  });

  it("refuses an unresolved window target (must become a region first)", () => {
    // gdigrab `title=` grabs a blank surface for GPU-composited windows, so a
    // window target must be resolved to its on-screen rectangle by
    // resolveCaptureTarget before args are built. Building directly must throw.
    expect(() =>
      buildCaptureArgs({ kind: "window", title: "Notepad" }, { output: "w.mp4" }),
    ).toThrow();
  });

  it("rejects an out-of-range fps", () => {
    expect(() =>
      buildCaptureArgs({ kind: "full" }, { output: "x.mp4", fps: 0 }),
    ).toThrow();
    expect(() =>
      buildCaptureArgs({ kind: "full" }, { output: "x.mp4", fps: 999 }),
    ).toThrow();
  });

  it("does not wire any audio input in Phase 1", () => {
    const s = buildCaptureArgs({ kind: "full" }, { output: "x.mp4" }).join(" ");
    expect(s).not.toContain("dshow");
    expect(s).not.toContain("-f audio");
  });
});

describe("buildScreenshotArgs", () => {
  it("grabs a single frame to the output path", () => {
    const args = buildScreenshotArgs({ kind: "full" }, "shot.png");
    expect(args.join(" ")).toContain("-frames:v 1");
    expect(args[args.length - 1]).toBe("shot.png");
  });

  it("keeps an odd region size for a screenshot (PNG needs no even dims)", () => {
    const s = buildScreenshotArgs(
      { kind: "region", x: 0, y: 0, w: 101, h: 101 },
      "odd.png",
    ).join(" ");
    expect(s).toContain("-video_size 101x101");
  });
});
