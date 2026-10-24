import { describe, it, expect } from "vitest";
import { animLadder, nextLadderIndex, buildAnimArgs } from "../utils/anim.js";

describe("animated export (#124)", () => {
  it("builds a GIF ladder that steps fps, width, and palette down", () => {
    const l = animLadder("gif", 12, 960);
    expect(l[0]).toEqual({ fps: 12, width: 960, colors: 256 });
    expect(l.at(-1)).toEqual({ fps: 4, width: 316, colors: 16 });
    for (let i = 1; i < l.length; i++) {
      expect(l[i].width).toBeLessThan(l[i - 1].width);
      expect(l[i].width % 2).toBe(0);
    }
  });

  it("builds a WebP ladder over quality instead of palette size", () => {
    const l = animLadder("webp", 12, 960);
    expect(l[0]).toEqual({ fps: 12, width: 960, quality: 75 });
    expect(l.every((s) => s.colors === undefined)).toBe(true);
  });

  it("skips ahead in proportion to how far over budget an attempt was", () => {
    expect(nextLadderIndex(0, 1_100_000, 1_000_000, 6)).toBe(1); // just over: one step
    expect(nextLadderIndex(0, 3_000_000, 1_000_000, 6)).toBe(2); // 3x over: two steps
    expect(nextLadderIndex(0, 119_000_000, 1_000_000, 6)).toBe(5); // never past the last step
    expect(nextLadderIndex(5, 9_000_000, 1_000_000, 6)).toBeNull(); // smallest step already tried
  });

  it("uses a diff-stats palette and rectangle diffs for GIF", () => {
    const a = buildAnimArgs("in.mp4", "o.gif", "gif", { fps: 10, width: 640, colors: 128 }, { start: 2, duration: 5 });
    expect(a.slice(0, 6)).toEqual(["-y", "-ss", "2", "-t", "5", "-i"]);
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf).toContain("fps=10,scale=640:-1:flags=lanczos");
    expect(vf).toContain("palettegen=stats_mode=diff:max_colors=128");
    expect(vf).toContain("paletteuse=dither=sierra2_4a:diff_mode=rectangle");
    expect(a.at(-1)).toBe("o.gif");
  });

  it("encodes WebP with libwebp_anim at the step's quality", () => {
    const a = buildAnimArgs("in.mp4", "o.webp", "webp", { fps: 12, width: 960, quality: 55 }).join(" ");
    expect(a).toContain("-c:v libwebp_anim -lossless 0 -q:v 55");
    expect(a).toContain("-loop 0");
  });

  it("rejects bad settings and clip windows", () => {
    expect(() => buildAnimArgs("i", "o.gif", "gif", { fps: 0, width: 640 })).toThrow();
    expect(() => buildAnimArgs("i", "o.gif", "gif", { fps: 10, width: 640 }, { duration: 0 })).toThrow(/duration/);
  });
});
