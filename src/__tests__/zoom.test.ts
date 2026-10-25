import { describe, it, expect } from "vitest";
import { keyframesToViews, viewExpr, buildZoomArgs, planAutoZoom, fitView } from "../utils/zoom.js";

/** Evaluate a zoompan expression at input time `it` (if/lt/clip as in ffmpeg). */
function evalExpr(expr: string, it: number): number {
  const js = expr.replace(/\bif\(/g, "IF(").replace(/\blt\(/g, "LT(");
  return new Function("IF", "LT", "it", `return ${js};`)(
    (c: number, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => (a < b ? 1 : 0),
    it,
  );
}

const W = 1280;
const H = 720;

describe("zoom (#119)", () => {
  it("turns rectangles into zoom + centre, adding a full-frame start", () => {
    const v = keyframesToViews([{ t: 2, x: 640, y: 360, width: 320, height: 180 }, { t: 5, full: true }], W, H);
    expect(v).toEqual([
      { t: 0, z: 1, cx: 640, cy: 360 },
      { t: 2, z: 4, cx: 800, cy: 450 },
      { t: 5, z: 1, cx: 640, cy: 360 },
    ]);
  });

  it("caps zoom, and fits non-matching aspect ratios inside the rectangle", () => {
    expect(keyframesToViews([{ t: 0, x: 0, y: 0, width: 10, height: 10 }], W, H)[0].z).toBe(6);
    expect(keyframesToViews([{ t: 0, x: 0, y: 0, width: 640, height: 100 }], W, H)[0].z).toBe(2);
    expect(() => keyframesToViews([], W, H)).toThrow();
    expect(() => keyframesToViews([{ t: -1, full: true }], W, H)).toThrow();
  });

  it("holds each view, then eases into the next over the transition", () => {
    const views = keyframesToViews([{ t: 2, x: 640, y: 360, width: 320, height: 180 }, { t: 5, full: true }], W, H);
    const z = viewExpr(views, "z", 0.6);
    expect(evalExpr(z, 0)).toBe(1);
    expect(evalExpr(z, 1.39)).toBe(1); // still holding before the ease
    expect(evalExpr(z, 1.7)).toBeCloseTo(2.5, 5); // halfway: smoothstep(0.5) = 0.5
    expect(evalExpr(z, 2)).toBe(4); // reached at the keyframe
    expect(evalExpr(z, 4)).toBe(4); // holding
    expect(evalExpr(z, 5)).toBe(1); // back out
    expect(evalExpr(z, 99)).toBe(1);
    const cx = viewExpr(views, "cx", 0.6);
    expect(evalExpr(cx, 1.55)).toBeGreaterThan(640);
    expect(evalExpr(cx, 1.55)).toBeLessThan(720); // eased: slow at the start
  });

  it("shortens the transition when keyframes are closer than it", () => {
    const views = keyframesToViews([{ t: 0.2, x: 0, y: 0, width: 640, height: 360 }], W, H);
    const z = viewExpr(views, "z", 0.6);
    expect(evalExpr(z, 0)).toBe(1);
    expect(evalExpr(z, 0.2)).toBe(2);
  });

  it("renders with zoompan on a 2x upscale at the source size and frame rate", () => {
    const a = buildZoomArgs("in.mp4", "o.mp4", keyframesToViews([{ t: 1, full: true }], W, H), { width: W, height: H, fps: 30 });
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf.startsWith("scale=2560:1440,zoompan=z='")).toBe(true);
    expect(vf).toContain(":d=1:s=1280x720:fps=30");
    expect(vf).toContain("x='clip((");
    const big = buildZoomArgs("in.mp4", "o.mp4", keyframesToViews([{ t: 1, full: true }], 3840, 2160), { width: 3840, height: 2160, fps: 60 });
    expect(big[big.indexOf("-vf") + 1].startsWith("scale=3840:2160,")).toBe(true);
  });

  it("fits a view around a change: padded, frame-shaped, at least min size, inside the frame", () => {
    expect(fitView({ x: 880, y: 430, width: 80, height: 40 }, W, H, 512, 288)).toEqual({ x: 664, y: 306, width: 512, height: 288 });
    expect(fitView({ x: 1250, y: 700, width: 30, height: 20 }, W, H, 512, 288)).toEqual({ x: 768, y: 432, width: 512, height: 288 });
  });

  it("plans a zoom into a localised change and back out, ignoring whole-screen changes", () => {
    const w = 64;
    const h = 36;
    const blank = new Uint8Array(w * h).fill(100);
    const withBox = blank.slice();
    for (let y = 16; y < 20; y++) for (let x = 40; x < 48; x++) withBox[y * w + x] = 250;
    const navy = new Uint8Array(w * h).fill(20);
    // 0.25 s steps: still, box appears at 1 s, stays, box gone at 2 s, still, full change at 4 s.
    const frames = [blank, blank, blank, blank, withBox, withBox, withBox, withBox, blank, blank, blank, blank, blank, blank, blank, blank, navy, navy];
    const kfs = planAutoZoom(frames, w, h, W, H, { step: 0.25, holdSec: 1 });
    expect(kfs).toHaveLength(2);
    expect(kfs[0].t).toBe(1);
    expect(kfs[0].full).toBeUndefined();
    expect(kfs[0].x! + kfs[0].width! / 2).toBeGreaterThan(800); // centred on the box, right of centre
    expect(kfs[1]).toEqual({ t: 3, full: true }); // last change at 2 s + 1 s hold
  });
});
