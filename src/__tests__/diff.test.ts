import { describe, it, expect } from "vitest";
import {
  analysisSize,
  detectionSize,
  MAX_DETECTION_WIDTH,
  SettleTracker,
  targetDiffOptions,
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

/**
 * A source-sized frame shrunk to `size` by area averaging (what ffmpeg's
 * flags=area does), with one rectangle brightened by `delta` on a 0 base.
 * Returns the before/after analysis bitmaps without allocating the source.
 */
function shrunkChange(
  src: { width: number; height: number },
  size: { width: number; height: number },
  rect: { x: number; y: number; w: number; h: number },
  delta: number,
): [Uint8Array, Uint8Array] {
  const fx = src.width / size.width;
  const fy = src.height / size.height;
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const after = new Uint8Array(size.width * size.height);
  for (let y = 0; y < size.height; y++) {
    const oy = overlap(y * fy, (y + 1) * fy, rect.y, rect.y + rect.h) / fy;
    if (oy === 0) continue;
    for (let x = 0; x < size.width; x++) {
      const ox = overlap(x * fx, (x + 1) * fx, rect.x, rect.x + rect.w) / fx;
      after[y * size.width + x] = Math.round(delta * ox * oy);
    }
  }
  return [new Uint8Array(size.width * size.height), after];
}

describe("change detection on large targets (#234)", () => {
  const label = { x: 1234, y: 567, w: 100, h: 16 }; // a changed 100x16 label
  const sources = {
    "1080p": { width: 1920, height: 1080 },
    "4K": { width: 3840, height: 2160 },
    "three monitors": { width: 5760, height: 1080 },
  };

  it("sizes analysis to the source: ~4 source px per analysis px, capped", () => {
    expect(detectionSize(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(detectionSize(3840, 2160)).toEqual({ width: 960, height: 540 });
    expect(detectionSize(5760, 1080)).toEqual({ width: 1440, height: 270 });
    expect(detectionSize(15360, 2160).width).toBe(MAX_DETECTION_WIDTH);
    expect(detectionSize(800, 600)).toEqual({ width: 320, height: 240 });
    expect(detectionSize(200, 101)).toEqual({ width: 200, height: 102 });
  });

  for (const [name, src] of Object.entries(sources)) {
    it(`finds a 100x16 label change on ${name}`, () => {
      const size = detectionSize(src.width, src.height);
      const [a, b] = shrunkChange(src, size, label, 90);
      const d = diffFrames(a, b, size.width, size.height, {
        scaleX: src.width / size.width,
        scaleY: src.height / size.height,
      });
      expect(d.regions.length).toBeGreaterThan(0);
      const r = d.regions[0];
      // The box sits on the label, in source pixels, within one cell of its edges.
      const cell = (src.width / size.width) * 8;
      expect(r.x).toBeLessThan(label.x + label.w);
      expect(r.y).toBeLessThan(label.y + label.h);
      expect(r.x + r.width).toBeGreaterThan(label.x);
      expect(r.y + r.height).toBeGreaterThan(label.y);
      expect(r.x).toBeGreaterThanOrEqual(label.x - cell);
      expect(r.x + r.width).toBeLessThanOrEqual(label.x + label.w + cell);
    });
  }

  it("(the old fixed 320 px analysis missed it on 4K)", () => {
    const src = sources["4K"];
    const size = analysisSize(src.width, src.height);
    const [a, b] = shrunkChange(src, size, label, 90);
    expect(diffFrames(a, b, size.width, size.height).regions).toEqual([]);
  });
});

describe("settle mode sees slow progress (#234)", () => {
  const W = 320;
  const H = 40;
  // A bar growing one analysis pixel per frame: each step alone is under the threshold.
  const bar = (len: number) => bitmap(W, H, 0, len > 0 ? [[0, 0, len, 8, 60]] : []);

  it("does not settle while a slow bar is still growing, then settles once it stops", () => {
    const t = new SettleTracker(bar(0), W, H);
    expect(diffFrames(bar(10), bar(11), W, H).regions).toEqual([]); // one step: invisible
    let quietRun = 0;
    let longestQuiet = 0;
    for (let len = 1; len <= 40; len++) {
      quietRun = t.push(bar(len)).length > 0 ? 0 : quietRun + 1;
      longestQuiet = Math.max(longestQuiet, quietRun);
    }
    expect(longestQuiet).toBeLessThanOrEqual(2);
    for (let i = 0; i < 5; i++) expect(t.push(bar(40))).toEqual([]);
  });
});

describe("screen_diff boxes with mismatched aspect ratios (#211)", () => {
  it("maps each axis separately onto b's pixels", () => {
    // a is 1920x1080; b is 1920x1200 and gets stretched to a's analysis size.
    const size = detectionSize(1920, 1080);
    const b = { width: 1920, height: 1200 };
    const change = { x: 800, y: 900, w: 100, h: 60 }; // in b's pixels
    const [ra, rb] = shrunkChange(b, size, change, 200);
    const r = diffFrames(ra, rb, size.width, size.height, {
      scaleX: b.width / size.width,
      scaleY: b.height / size.height,
    }).regions[0];
    expect(r.y).toBeLessThanOrEqual(change.y);
    expect(r.y + r.height).toBeGreaterThanOrEqual(change.y + change.h);
    expect(r.y + r.height).toBeLessThan(change.y + change.h + 40);
    expect(r.x).toBeLessThanOrEqual(change.x);
    expect(r.x + r.width).toBeGreaterThanOrEqual(change.x + change.w);
  });
});

describe("wait_for_change boxes match its screenshot (#233)", () => {
  it("maps boxes to the target's own pixels, not the desktop", () => {
    // A 1000x600 window at (2500, -300) on a monitor left of and above the primary.
    const area = { x: 2500, y: -300, width: 1000, height: 600 };
    const size = detectionSize(area.width, area.height);
    const change = { x: 400, y: 200, w: 120, h: 40 }; // in screenshot pixels
    const [a, b] = shrunkChange(area, size, change, 200);
    const r = diffFrames(a, b, size.width, size.height, targetDiffOptions(area, size)).regions[0];
    expect(r.x).toBeGreaterThanOrEqual(change.x - 32);
    expect(r.x).toBeLessThanOrEqual(change.x);
    expect(r.y).toBeGreaterThanOrEqual(change.y - 32);
    expect(r.y).toBeLessThanOrEqual(change.y);
    expect(r.x + r.width).toBeLessThanOrEqual(area.width);
  });
});
