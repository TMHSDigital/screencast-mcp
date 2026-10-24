import { describe, it, expect } from "vitest";
import {
  loudnessTarget,
  buildLoudnessMeasureArgs,
  buildLoudnessApplyArgs,
  parseLoudnorm,
  audioCodecFor,
  buildDenoiseArgs,
  buildNoiseFloorArgs,
  parseNoiseFloor,
  noiseFloorSetting,
  LOUDNESS_PRESETS,
} from "../utils/audio.js";

const REPORT = `[Parsed_loudnorm_0 @ 0x1]
{
	"input_i" : "-47.85",
	"input_tp" : "-43.72",
	"input_lra" : "0.00",
	"input_thresh" : "-57.85",
	"output_i" : "-13.96",
	"output_tp" : "-9.90",
	"output_lra" : "0.00",
	"output_thresh" : "-23.96",
	"normalization_type" : "dynamic",
	"target_offset" : "-0.04"
}`;

describe("audio polish (#123)", () => {
  it("resolves presets and LUFS numbers to targets", () => {
    expect(loudnessTarget(undefined)).toEqual(LOUDNESS_PRESETS.youtube);
    expect(loudnessTarget("broadcast")).toEqual({ i: -23, tp: -1, lra: 7 });
    expect(loudnessTarget(-18)).toEqual({ i: -18, tp: -1, lra: 11 });
    expect(() => loudnessTarget(0)).toThrow(/between -70 and -5/);
  });

  it("parses loudnorm's JSON report out of stderr", () => {
    const m = parseLoudnorm(`noise before\n${REPORT}\nnoise after`);
    expect(m).toEqual({ input_i: -47.85, input_tp: -43.72, input_lra: 0, input_thresh: -57.85, target_offset: -0.04, output_i: -13.96 });
  });

  it("explains silence and a missing report", () => {
    expect(() => parseLoudnorm(REPORT.replace('"-47.85"', '"-inf"'))).toThrow(/silent/);
    expect(() => parseLoudnorm("no report here")).toThrow(/Could not measure/);
  });

  it("measures, then applies a linear correction with the measured values", () => {
    const t = LOUDNESS_PRESETS.podcast;
    expect(buildLoudnessMeasureArgs("in.mp4", t)).toContain("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json");
    const a = buildLoudnessApplyArgs("in.mp4", "out.mp4", t, parseLoudnorm(REPORT));
    const af = a[a.indexOf("-af") + 1];
    expect(af).toContain("measured_I=-47.85:measured_TP=-43.72:measured_LRA=0:measured_thresh=-57.85:offset=-0.04");
    expect(af).toContain("linear=true");
    expect(a).toEqual(expect.arrayContaining(["-c:v", "copy", "-ar", "48000"]));
    expect(a.slice(a.indexOf("-map"), a.indexOf("-map") + 4)).toEqual(["-map", "0:v?", "-map", "0:a:0"]);
  });

  it("picks an audio encoder that fits the output container", () => {
    expect(audioCodecFor("x.wav")).toEqual(["-c:a", "pcm_s16le"]);
    expect(audioCodecFor("x.MP3")).toEqual(["-c:a", "libmp3lame", "-b:a", "192k"]);
    expect(audioCodecFor("x.mp4")).toEqual(["-c:a", "aac", "-b:a", "192k"]);
  });

  it("estimates the noise floor as the 10th-percentile window RMS", () => {
    const out = Array.from({ length: 20 }, (_, i) => `frame:${i}\nlavfi.astats.Overall.RMS_level=${-60 + i}`).join("\n");
    expect(parseNoiseFloor(out)).toBe(-58);
    expect(parseNoiseFloor("lavfi.astats.Overall.RMS_level=-inf\n")).toBeNull();
  });

  it("sets afftdn's floor 5 dB above the measured one, within its range", () => {
    expect(noiseFloorSetting(-40)).toBe(-35);
    expect(noiseFloorSetting(-24.8)).toBe(-20);
    expect(noiseFloorSetting(-99)).toBe(-80);
    expect(noiseFloorSetting(null)).toBe(-50);
  });

  it("denoises with afftdn at the requested strength and measured floor, copying video", () => {
    expect(buildDenoiseArgs("in.mp4", "o.mp4", "strong", -40)).toContain("afftdn=nr=20:nf=-35");
    expect(buildDenoiseArgs("in.mp4", "o.mp4")).toContain("afftdn=nr=12:nf=-50");
    expect(buildNoiseFloorArgs("in.mp4").join(" ")).toContain("asetnsamples=4800,astats=metadata=1:reset=1");
    expect(() => buildDenoiseArgs("in.mp4", "o.mp4", "max" as never)).toThrow(/Unknown/);
  });
});
