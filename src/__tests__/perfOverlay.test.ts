/** perf_overlay (#335): the chart's values, scale, and filter graph. Pure. */
import { describe, it, expect } from "vitest";
import { buildPerfOverlayArgs, chartScale, chartValues } from "../utils/perfOverlay.js";
import type { PerfSample } from "../utils/perf.js";

const s = (t: number, cpu: number, rssMB = 100): PerfSample => ({ t, sysCpu: 10, sysMem: 50, cpu, rssMB });

describe("perf_overlay (#335)", () => {
  it("bins samples by time, keeps the highest, and carries the last value", () => {
    expect(chartValues([s(0, 10), s(0.5, 30), s(2, 90)], "cpu", 4, 4)).toEqual([30, 30, 90, 90]);
    expect(chartValues([s(3, 50)], "cpu", 4, 4)).toEqual([null, null, null, 50]);
    expect(chartValues([s(9, 50)], "cpu", 4, 4)).toEqual([null, null, null, null]);
    expect(() => chartValues([], "cpu", 0)).toThrow(/no duration/);
  });

  it("scales percentages to 100 and memory to its peak", () => {
    expect(chartScale("cpu", [5, 40])).toBe(100);
    expect(chartScale("rssMB", [120, 260])).toBe(300);
    expect(chartScale("rssMB", [null])).toBe(1);
  });

  it("draws bars (busy ones red), a moving playhead, and places the chart", () => {
    const args = buildPerfOverlayArgs("in.mp4", "out.mp4", [10, 95, null, 50], {
      metric: "cpu",
      corner: "bottom_left",
      width: 160,
      height: 64,
      videoWidth: 640,
      videoHeight: 360,
      durationSec: 6,
      hasAudio: true,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph.match(/drawbox=/g)).toHaveLength(3);
    expect(graph).toContain("color=0xFF5252");
    expect(graph).toContain("overlay=x='min(158,t/6*160)'");
    expect(graph).toContain("[0:v][g]overlay=x=7:y=289");
    expect(args).toEqual(expect.arrayContaining(["-map", "0:a?", "-c:a", "copy"]));
    expect(() => buildPerfOverlayArgs("i", "o", [1], { metric: "cpu", corner: "top_left", width: 800, height: 64, videoWidth: 640, videoHeight: 360, durationSec: 1, hasAudio: false })).toThrow(/larger than the video/);
  });
});
