/** Ranged fast-forward (#320): range checks, filters, saved time, and times
 * moved through a sped-up span. Pure. */
import { describe, it, expect } from "vitest";
import { buildSpeedRangesArgs, checkSpeedRanges, rangesSavedSec, speedRangeFilters } from "../utils/idle.js";
import { cutShift, mapTime, mapWindow } from "../utils/timeline.js";
import { retimeMarkers } from "../utils/chapters.js";
import { planPipeline } from "../utils/pipeline.js";

describe("speed ranges (#320)", () => {
  it("sorts and checks ranges", () => {
    expect(checkSpeedRanges([{ start: 5, end: 6, factor: 2 }, { start: 1, end: 2.00049, factor: 4 }], 10)).toEqual([
      { start: 1, end: 2, factor: 4 },
      { start: 5, end: 6, factor: 2 },
    ]);
    expect(() => checkSpeedRanges([], 10)).toThrow(/at least one/);
    expect(() => checkSpeedRanges([{ start: 2, end: 1, factor: 2 }], 10)).toThrow(/end must be after start/);
    expect(() => checkSpeedRanges([{ start: 1, end: 2, factor: 0.5 }], 10)).toThrow(/above 1/);
    expect(() => checkSpeedRanges([{ start: 11, end: 12, factor: 2 }], 10)).toThrow(/after the video ends/);
    expect(() => checkSpeedRanges([{ start: 1, end: 3, factor: 2 }, { start: 2, end: 4, factor: 2 }], 10)).toThrow(/overlap/);
  });

  it("builds one linear video and audio filter, thinned back to the source rate", () => {
    const f = speedRangeFilters([{ start: 2, end: 6, factor: 4 }], 30);
    expect(f.video).toBe("setpts='(T-(clip(T-2,0,4)*0.75))/TB',fps=30");
    // The range keeps its first second of audio: 4 s at 4x.
    expect(f.audio).toBe("asetnsamples=n=256:p=0,aselect='not(between(t,3,6))',asetpts=N/SR/TB");
    expect(speedRangeFilters([{ start: 2, end: 6, factor: 4 }], null).video).not.toMatch(/fps=/);
    const args = buildSpeedRangesArgs("in.mp4", "out.mp4", [{ start: 2, end: 6, factor: 4 }], { withAudio: false, fps: 30 });
    expect(args).toContain("-an");
    expect(rangesSavedSec([{ start: 2, end: 6, factor: 4 }, { start: 8, end: 9, factor: 2 }])).toBeCloseTo(3.5, 6);
  });

  it("moves times through a sped-up span proportionally", () => {
    const spans = [{ start: 2, end: 6, factor: 4 }];
    expect(cutShift(1, spans)).toBe(0);
    expect(cutShift(4, spans)).toBeCloseTo(1.5, 6);
    expect(cutShift(8, spans)).toBeCloseTo(3, 6);
    expect(mapTime(4, [{ op: "cut", spans }])).toBeCloseTo(2.5, 6);
    expect(mapWindow(5, 7, [{ op: "cut", spans }])).toEqual([2.75, 4]);
    expect(retimeMarkers([{ t: 8, label: "after" }], [{ op: "cut", spans }])[0]?.t).toBe(5);
    // A removed span (no factor) still removes all of itself.
    expect(cutShift(8, [{ start: 2, end: 6 }])).toBe(4);
  });

  it("plans pipeline speed segments and cut_idle speed", () => {
    const src = { width: 320, height: 240, fps: 30, durationSec: 10, hasAudio: true };
    const plan = planPipeline("in.mp4", "out.mp4", [{ op: "speed", segments: [{ start: 2, end: 6, factor: 4 }] }], src, {});
    expect(plan.summary).toEqual(["speed up 1 range(s), 3s saved"]);
    expect(plan.durationSec).toBeCloseTo(7, 6);
    const idle = planPipeline("in.mp4", "out.mp4", [{ op: "cut_idle", action: "speed", factor: 8 }], src, {}, "standard", { idle: [{ start: 3, end: 7 }] });
    expect(idle.summary).toEqual(["cut_idle 1 stretch(es) sped up x8, 2.8s saved"]);
    expect(() => planPipeline("in.mp4", "out.mp4", [{ op: "speed" }], src, {})).toThrow(/factor or segments/);
  });
});
