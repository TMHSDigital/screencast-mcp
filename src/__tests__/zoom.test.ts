import { describe, it, expect } from "vitest";
import { keyframesToViews, viewExpr, buildZoomArgs, planAutoZoom, planClickZoom, fitView, ringFilters, ringSize, RING_SEC } from "../utils/zoom.js";

/** Evaluate a zoompan expression at input time `it` (clip as in ffmpeg),
 * rounded to hide float noise from the summed eases. */
function evalExpr(expr: string, it: number): number {
  const v = new Function("clip", "it", `return ${expr};`)(
    (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)),
    it,
  ) as number;
  return Math.round(v * 1e9) / 1e9;
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

  it("keeps the expression flat for any number of keyframes (#225)", () => {
    const kfs = Array.from({ length: 300 }, (_, i) =>
      i % 2 ? { t: i + 1, full: true } : { t: i + 1, x: 100, y: 100, width: 320, height: 180 },
    );
    const z = viewExpr(keyframesToViews(kfs, W, H), "z", 0.6);
    expect(z).not.toMatch(/if\(/);
    expect(evalExpr(z, 1)).toBe(4);
    expect(evalExpr(z, 2)).toBe(1);
    expect(evalExpr(z, 299)).toBe(4);
    expect(evalExpr(z, 400)).toBe(1);
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

  it("zooms toward clicks, pans between clicks close in time, and zooms out after the hold (#119)", () => {
    const kfs = planClickZoom(
      [
        { t: 1, x: 200, y: 150 },
        { t: 1.8, x: 1000, y: 600 }, // same run: pan
        { t: 2, x: 1001, y: 601 }, // same spot: no new keyframe
        { t: 8, x: 640, y: 360 }, // new run after a gap
      ],
      W,
      H,
      { holdSec: 2, transition: 0.6 },
    );
    expect(kfs.map((k) => (k.full ? `out@${k.t}` : `in@${k.t}`))).toEqual(["in@1", "in@1.8", "out@4", "in@8", "out@10"]);
    const first = kfs[0];
    expect(first.x).toBe(0); // centred on the click, then clamped inside the frame
    expect(200).toBeGreaterThan(first.x!);
    expect(200).toBeLessThan(first.x! + first.width!);
    expect(first.width).toBeCloseTo(W / 2.5, 0); // the default max zoom
    expect(planClickZoom([], W, H)).toEqual([]);
  });

  it("keeps click keyframes at least one transition apart", () => {
    const kfs = planClickZoom([{ t: 0.1, x: 100, y: 100 }, { t: 0.2, x: 1100, y: 600 }], W, H, { transition: 0.6, holdSec: 2 });
    const times = kfs.map((k) => k.t);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });

  it("draws one timed, centred ring per click, before the zoom", () => {
    const steps = ringFilters([{ t: 1.5, x: 100, y: 80 }, { t: 3, x: 400, y: 300 }], W, H, 30, "#FFB454");
    const D = ringSize(W, H);
    expect(D).toBe(64);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain(`color=c=#FFB454:s=${D}x${D}:r=30:d=${RING_SEC}`);
    expect(steps[0]).toContain("setpts=PTS+1.5/TB[ring0]");
    expect(steps[1]).toBe(`[in][ring0]overlay=x=${100 - D / 2}:y=${80 - D / 2}:eof_action=pass[r0]`);
    expect(steps[3].endsWith("[out]")).toBe(true);
    const args = buildZoomArgs("in.mp4", "o.mp4", keyframesToViews([{ t: 1, full: true }], W, H), { width: W, height: H, fps: 30 }, 0.6, "draft", {
      clicks: [{ t: 1, x: 10, y: 10 }],
      color: "red",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph.startsWith("[0:v]null[in];color=c=red")).toBe(true);
    expect(graph).toContain("[out]scale=2560:1440,zoompan=");
    expect(args).toContain("0:a?");
    expect(args).not.toContain("-vf");
  });
});
