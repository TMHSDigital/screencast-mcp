/** compose (#338): layout geometry, timing, and the filter graph. Pure. */
import { describe, it, expect } from "vitest";
import { buildComposeArgs, cellSize, composeDuration, gridShape, type ComposeSource } from "../utils/compose.js";

const src = (over: Partial<ComposeSource> = {}): ComposeSource => ({
  path: "a.mp4", width: 1920, height: 1080, durationSec: 10, hasAudio: true, skipSec: 0, ...over,
});

describe("compose (#338)", () => {
  it("shapes layouts", () => {
    expect(gridShape("side_by_side", 3)).toEqual({ cols: 3, rows: 1 });
    expect(gridShape("stack", 2)).toEqual({ cols: 1, rows: 2 });
    expect(gridShape("grid", 5)).toEqual({ cols: 3, rows: 2 });
  });

  it("sizes cells from the first input, capped and fitted", () => {
    expect(cellSize({ width: 640, height: 360 }, { cols: 2, rows: 1 })).toEqual({ width: 640, height: 360 });
    // 4K sources: capped at 1080 tall, then shrunk so three fit in 3840 wide.
    expect(cellSize({ width: 3840, height: 2160 }, { cols: 3, rows: 1 })).toEqual({ width: 1280, height: 720 });
    expect(cellSize({ width: 641, height: 361 }, { cols: 1, rows: 1 })).toEqual({ width: 642, height: 362 });
  });

  it("times the output by the longest or shortest input after skips", () => {
    const s = [src({ durationSec: 10, skipSec: 2 }), src({ durationSec: 6 })];
    expect(composeDuration(s, "longest")).toBe(8);
    expect(composeDuration(s, "shortest")).toBe(6);
  });

  it("builds one xstack graph with holds, labels, skips and the chosen audio", () => {
    const s = [src({ skipSec: 2, label: { textFile: "l0.txt", fontFile: "f.ttf" } }), src({ path: "b.mp4", durationSec: 6, hasAudio: false })];
    const args = buildComposeArgs(s, "out.mp4", { layout: "side_by_side", endWith: "longest", audio: 0, fps: 30 });
    expect(args.slice(0, 6)).toEqual(["-y", "-ss", "2.000", "-i", "a.mp4", "-i"]);
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("tpad=stop_mode=clone:stop_duration=2.000[c1]");
    expect(graph).toContain("textfile=l0.txt:expansion=none");
    expect(graph).toContain("xstack=inputs=2:layout=0_0|1920_0:fill=black[v]");
    expect(graph).toContain("[0:a]apad[a]");
    expect(args[args.indexOf("-t") + 1]).toBe("8.000");
    expect(() => buildComposeArgs(s, "o.mp4", { layout: "stack", endWith: "longest", audio: 1, fps: 30 })).toThrow(/has no audio/);
    expect(() => buildComposeArgs([s[0]!], "o.mp4", { layout: "stack", endWith: "longest", audio: "none", fps: 30 })).toThrow(/2 to 9/);
    const mixed = buildComposeArgs(s, "o.mp4", { layout: "grid", endWith: "shortest", audio: "mix", fps: 30 });
    expect(mixed[mixed.indexOf("-filter_complex") + 1]).toContain("[0:a]amix=inputs=1");
  });
});
