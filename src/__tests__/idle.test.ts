import { describe, it, expect } from "vitest";
import { buildIdleScanArgs, parseFreezes, parseSilences, intersect, cutsFor, buildCutIdleArgs } from "../utils/idle.js";

// What ffmpeg printed for a clip with a frozen, silent stretch from 2 s to 6 s.
const SCAN = `[Parsed_silencedetect_0 @ 0x1] silence_start: 1.999977
[Parsed_freezedetect_0 @ 0x2] lavfi.freezedetect.freeze_start: 2
[Parsed_silencedetect_0 @ 0x1] silence_end: 6.000023 | silence_duration: 4.000045
[Parsed_freezedetect_0 @ 0x2] lavfi.freezedetect.freeze_duration: 4
[Parsed_freezedetect_0 @ 0x2] lavfi.freezedetect.freeze_end: 6
[Parsed_freezedetect_0 @ 0x2] lavfi.freezedetect.freeze_start: 9.5`;

describe("cut_idle (#122)", () => {
  it("pairs freeze and silence markers, closing an open one at the end", () => {
    expect(parseFreezes(SCAN, 12)).toEqual([{ start: 2, end: 6 }, { start: 9.5, end: 12 }]);
    expect(parseSilences(SCAN, 12)).toEqual([{ start: 1.999977, end: 6.000023 }]);
  });

  it("counts a stretch as idle only where both video and audio are still", () => {
    expect(intersect(parseFreezes(SCAN, 12), parseSilences(SCAN, 12))).toEqual([{ start: 2, end: 6 }]);
    expect(intersect([{ start: 0, end: 5 }, { start: 8, end: 10 }], [{ start: 3, end: 9 }])).toEqual([
      { start: 3, end: 5 },
      { start: 8, end: 9 },
    ]);
  });

  it("keeps a pad at both edges and drops stretches that are too short", () => {
    expect(cutsFor([{ start: 2, end: 6 }, { start: 7, end: 8 }], 2, 0.4)).toEqual([{ start: 2.4, end: 5.6 }]);
    expect(cutsFor([{ start: 0, end: 2 }], 2, 1)).toEqual([]);
  });

  it("scans with freezedetect, plus silencedetect only when audio counts", () => {
    expect(buildIdleScanArgs("in.mp4", 2, true).join(" ")).toContain("-vf freezedetect=n=-60dB:d=2 -af silencedetect=n=-40dB:d=2");
    expect(buildIdleScanArgs("in.mp4", 2, false)).toContain("-an");
    expect(() => buildIdleScanArgs("in.mp4", 0, true)).toThrow();
  });

  it("drops the cut spans from video and audio with regenerated timestamps", () => {
    const a = buildCutIdleArgs("in.mp4", "o.mp4", [{ start: 2.4, end: 5.6 }, { start: 9, end: 10 }], true);
    expect(a[a.indexOf("-vf") + 1]).toBe("select='not(between(t,2.4,5.6)+between(t,9,10))',setpts=N/FRAME_RATE/TB");
    expect(a[a.indexOf("-af") + 1]).toBe("aselect='not(between(t,2.4,5.6)+between(t,9,10))',asetpts=N/SR/TB");
    expect(buildCutIdleArgs("in.mp4", "o.mp4", [{ start: 1, end: 2 }], false)).toContain("-an");
    expect(() => buildCutIdleArgs("in.mp4", "o.mp4", [], true)).toThrow(/Nothing to cut/);
  });
});
