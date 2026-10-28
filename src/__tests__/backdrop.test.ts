import { describe, it, expect } from "vitest";
import {
  backdropLayout,
  backdropColors,
  backdropSteps,
  buildBackdropArgs,
  roundedMaskExpr,
  BACKDROP_PRESETS,
} from "../utils/backdrop.js";
import { planPipeline } from "../utils/pipeline.js";

describe("backdropLayout (#171)", () => {
  it("pads the content by 6% of the longer side by default, on an even canvas", () => {
    const L = backdropLayout(1920, 1080);
    expect(L.padding).toBe(116);
    expect([L.canvasW, L.canvasH]).toEqual([1920 + 232, 1080 + 232]);
    expect([L.x, L.y, L.contentW, L.contentH]).toEqual([116, 116, 1920, 1080]);
    expect(L.scaled).toBe(false);
    expect(L.radius).toBe(23);
    expect(L.shadow).toBe(48);
    expect(L.shadowOffset).toBe(24);
  });

  it("keeps an odd-sized source unscaled but makes the canvas even", () => {
    const L = backdropLayout(321, 241, { padding: 11 });
    expect(L.padding).toBe(12); // rounded to even, so a 4:2:0 pad does not shift it
    expect(L.canvasW % 2).toBe(0);
    expect(L.canvasH % 2).toBe(0);
    expect([L.contentW, L.contentH]).toEqual([321, 241]);
  });

  it("fits the content inside the padding on an aspect canvas", () => {
    const L = backdropLayout(1920, 1080, { aspect: "9:16", padding: 60 });
    expect([L.canvasW, L.canvasH]).toEqual([1080, 1920]);
    expect(L.contentW).toBe(960);
    expect(L.contentH).toBe(540);
    expect(L.scaled).toBe(true);
    expect(L.x).toBe(60);
    expect(L.x % 2 + L.y % 2).toBe(0);
    expect(L.y + L.contentH).toBeLessThanOrEqual(1920);
  });

  it("clamps the radius to half the short side and the shadow drop to the space below", () => {
    const L = backdropLayout(100, 40, { radius: 500, padding: 0, shadow: 30 });
    expect(L.radius).toBe(20);
    expect(L.shadowOffset).toBe(0);
  });

  it("turns off corners and shadow with 0, and rejects bad numbers", () => {
    const L = backdropLayout(640, 480, { radius: 0, shadow: 0 });
    expect(L.radius).toBe(0);
    expect(L.shadow).toBe(0);
    expect(() => backdropLayout(640, 480, { padding: -1 })).toThrow(/padding/);
    expect(() => backdropLayout(640, 480, { aspect: "1:1", padding: 600 })).toThrow(/no room/);
  });
});

describe("backdropColors", () => {
  it("uses the desktop preset by default, a named preset, or explicit colors", () => {
    expect(backdropColors({})).toEqual([...BACKDROP_PRESETS.desktop]);
    expect(backdropColors({ preset: "rec" })).toEqual(["#FF4545", "#5C0F1A"]);
    expect(backdropColors({ colors: ["navy"] })).toEqual(["navy"]);
  });

  it("rejects an empty or too-long list and filtergraph metacharacters", () => {
    expect(() => backdropColors({ colors: [] })).toThrow(/1 to 4/);
    expect(() => backdropColors({ colors: ["a", "b", "c", "d", "e"] })).toThrow(/1 to 4/);
    expect(() => backdropColors({ colors: ["red;drawtext"] })).toThrow(/Invalid colors\[0\]/);
  });
});

describe("roundedMaskExpr", () => {
  // Evaluate the geq expression in JS for a W x H plane.
  const evalMask = (expr: string, X: number, Y: number, W: number, H: number) =>
    Function("X", "Y", "W", "H", "max", "clip", "hypot", `return ${expr};`)(
      X, Y, W, H, Math.max, (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)), Math.hypot,
    ) as number;

  it("is opaque inside, clear in the very corner, and the hole is its inverse", () => {
    const m = roundedMaskExpr(10);
    expect(evalMask(m, 50, 50, 100, 100)).toBe(255);
    expect(evalMask(m, 0, 0, 100, 100)).toBe(0);
    expect(evalMask(m, 99, 99, 100, 100)).toBe(0);
    expect(evalMask(m, 0, 50, 100, 100)).toBe(255); // a straight edge is not rounded
    expect(evalMask(roundedMaskExpr(10, true), 0, 0, 100, 100)).toBe(255);
    expect(evalMask(roundedMaskExpr(10, true), 50, 50, 100, 100)).toBe(0);
  });
});

describe("backdropSteps / buildBackdropArgs", () => {
  it("draws the static frame once from single-frame sources and overlays it on the padded content", () => {
    const { steps, out } = backdropSteps({ preset: "amber" }, { width: 320, height: 240 }, "[0:v]", 1, "t");
    const g = steps.join(";");
    expect(g).toContain("gradients=s=360x280:c0=#FFB454:c1=#FF4545:n=2:x0=0:y0=0:x1=360:y1=280");
    expect(g).toContain("trim=end_frame=1");
    expect(g).toContain("gblur=sigma=4.00");
    expect(g).toContain("[tbs][thole]alphamerge");
    expect(g).toContain("[0:v]pad=360:280:20:20:color=black[tpad]");
    expect(g).toContain("[tpad][tframe]overlay=0:0[tbd]");
    expect(out).toBe("[tbd]");
  });

  it("uses a solid color source for one color and skips the shadow at 0", () => {
    const g = backdropSteps({ colors: ["#112233"], shadow: 0 }, { width: 100, height: 100 }, "[in]", 1, "").steps.join(";");
    expect(g).toContain("color=c=#112233:s=");
    expect(g).not.toContain("gblur");
    expect(g).not.toContain("gradients");
  });

  it("reads a wallpaper as an extra input, scaled to cover", () => {
    const { steps, extraInputs } = backdropSteps({ image: "C:/wall.jpg" }, { width: 640, height: 360 }, "[0:v]", 3, "");
    expect(extraInputs).toEqual(["-i", "C:/wall.jpg"]);
    expect(steps[0]).toMatch(/^\[3:v\]scale=\d+:\d+:force_original_aspect_ratio=increase,crop=/);
  });

  it("scales the content first on an aspect canvas", () => {
    const g = backdropSteps({ aspect: "1:1" }, { width: 1920, height: 1080 }, "[0:v]", 1, "").steps.join(";");
    expect(g).toMatch(/\[0:v\]scale=\d+:\d+,setsar=1,pad=1080:1080:/);
  });

  it("writes an mp4 with the audio copied, or a single RGB still", () => {
    const v = buildBackdropArgs("in.mp4", "out.mp4", {}, { width: 320, height: 240 });
    expect(v.args).toContain("0:a?");
    expect(v.args.at(-1)).toBe("out.mp4");
    expect(v.args.join(" ")).toContain("format=yuv420p[vout]");
    const s = buildBackdropArgs("in.png", "o%d.png", {}, { width: 320, height: 240 }, true);
    expect(s.args.join(" ")).toContain("overlay=0:0:format=rgb[bd]");
    expect(s.args.slice(-5)).toEqual(["-frames:v", "1", "-update", "1", "o%d.png"]);
  });
});

describe("backdrop as a pipeline step", () => {
  const src = { width: 320, height: 240, fps: 30, durationSec: 10, hasAudio: true };

  it("changes the frame size for later steps and reads a wallpaper as the next input", () => {
    const plan = planPipeline("in.mp4", "out.mp4", [{ op: "backdrop", image: "wall.png", padding: 20 }, { op: "scale", width: 180 }], src);
    expect(plan.summary[0]).toBe("backdrop to 360x280");
    expect(plan.width).toBe(180);
    expect(plan.args).toEqual(expect.arrayContaining(["-i", "wall.png"]));
    expect(plan.args.join(" ")).toContain("[1:v]scale=360:280");
  });
});
