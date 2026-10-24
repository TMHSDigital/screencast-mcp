import { describe, it, expect } from "vitest";
import {
  analysisSize,
  targetSize,
  meanDifference,
  diffFrames,
  buildRawGrabArgs,
  buildSsimArgs,
  buildHighlightArgs,
  parseSsim,
} from "../utils/diff.js";

/** A w x h gray bitmap filled with `v`, with optional filled rectangles. */
function bitmap(w: number, h: number, v = 0, rects: Array<[number, number, number, number, number]> = []): Uint8Array {
  const b = new Uint8Array(w * h).fill(v);
  for (const [x, y, rw, rh, rv] of rects) {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) b[yy * w + xx] = rv;
  }
  return b;
}

describe("frame differencing (#116)", () => {
  it("analyses at most 320 px wide with even, aspect-kept sides", () => {
    expect(analysisSize(1920, 1080)).toEqual({ width: 320, height: 180 });
    expect(analysisSize(200, 101)).toEqual({ width: 200, height: 102 });
  });

  it("sizes full as the union of monitors, and passes regions through", () => {
    const monitors = [
      { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true },
      { index: 1, x: 1920, y: -200, width: 1280, height: 1024, primary: false },
    ];
    expect(targetSize({ kind: "full" }, monitors)).toEqual({ x: 0, y: -200, width: 3200, height: 1280 });
    expect(targetSize({ kind: "monitor", index: 1 }, monitors)).toEqual({ x: 1920, y: -200, width: 1280, height: 1024 });
    expect(targetSize({ kind: "region", x: 5, y: 6, w: 70, h: 80 }, [])).toEqual({ x: 5, y: 6, width: 70, height: 80 });
  });

  it("reports identical frames as unchanged", () => {
    const a = bitmap(64, 48, 100);
    const d = diffFrames(a, a.slice(), 64, 48);
    expect(d).toEqual({ meanDiff: 0, changedFraction: 0, regions: [] });
  });

  it("ignores noise below the threshold", () => {
    const a = bitmap(64, 48, 100);
    const b = bitmap(64, 48, 105);
    expect(diffFrames(a, b, 64, 48).regions).toEqual([]);
  });

  it("boxes a changed area on cell boundaries, scaled and offset to screen pixels", () => {
    const a = bitmap(64, 48, 0);
    const b = bitmap(64, 48, 0, [[17, 9, 12, 10, 255]]); // touches cells x 2-3, y 1-2
    const d = diffFrames(a, b, 64, 48, { scale: 2, origin: { x: 1000, y: 500 } });
    expect(d.regions).toEqual([{ x: 1000 + 16 * 2, y: 500 + 8 * 2, width: 16 * 2, height: 16 * 2 }]);
    expect(d.changedFraction).toBeCloseTo(4 / 48, 5);
  });

  it("keeps separate changes as separate boxes, largest first", () => {
    const a = bitmap(80, 40, 0);
    const b = bitmap(80, 40, 0, [[0, 0, 8, 8, 200], [48, 16, 24, 16, 200]]);
    const d = diffFrames(a, b, 80, 40);
    expect(d.regions).toEqual([
      { x: 48, y: 16, width: 24, height: 16 },
      { x: 0, y: 0, width: 8, height: 8 },
    ]);
  });

  it("rejects mismatched frames", () => {
    expect(() => diffFrames(new Uint8Array(10), new Uint8Array(12), 2, 5)).toThrow();
    expect(() => meanDifference(new Uint8Array(3), new Uint8Array(4))).toThrow();
  });

  it("builds raw grab, SSIM, and highlight args", () => {
    const g = buildRawGrabArgs({ kind: "region", x: 10, y: 20, w: 300, h: 200 }, [], { width: 300, height: 200 }).join(" ");
    expect(g).toContain("-f gdigrab -framerate 30");
    expect(g).toContain("-offset_x 10 -offset_y 20 -video_size 300x200");
    expect(g).toContain("format=gray -f rawvideo -");
    expect(buildSsimArgs("a.png", "b.png", { width: 320, height: 180 }).join(" ")).toContain("[x][y]ssim");
    const h = buildHighlightArgs("b.png", [{ x: 1, y: 2, width: 3, height: 4 }], "o.png");
    expect(h[h.indexOf("-vf") + 1]).toBe("drawbox=x=1:y=2:w=3:h=4:color=red@0.9:t=3");
    expect(buildHighlightArgs("b.png", [], "o.png")).not.toContain("-vf");
  });

  it("parses the SSIM score", () => {
    expect(parseSsim("[Parsed_ssim_4 @ 0x1] SSIM Y:0.987 (18.9) All:0.987123 (18.89)")).toBeCloseTo(0.987123, 6);
    expect(parseSsim("nothing")).toBeNull();
  });
});
