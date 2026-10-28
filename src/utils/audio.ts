/**
 * Audio polish (#123): EBU R128 loudness normalization and noise reduction.
 *
 * Normalization is two-pass loudnorm: the first pass measures the input, the
 * second applies a linear gain using those measurements, so the result hits
 * the target without the pumping of single-pass (dynamic) mode. Video, when
 * present, is stream-copied. Builders and the parser are pure.
 */
import { extname } from "node:path";
import { ScreencastError } from "./errors.js";
import { isAudioOnlyPath } from "./media.js";

export type LoudnessPreset = "youtube" | "podcast" | "broadcast";

export interface LoudnessTarget {
  /** Integrated loudness, LUFS. */
  i: number;
  /** True peak ceiling, dBTP. */
  tp: number;
  /** Loudness range, LU. */
  lra: number;
}

/** Common delivery targets: YouTube/streaming, spoken-word podcasts, and EBU
 * R128 broadcast. */
export const LOUDNESS_PRESETS: Record<LoudnessPreset, LoudnessTarget> = {
  youtube: { i: -14, tp: -1, lra: 11 },
  podcast: { i: -16, tp: -1.5, lra: 11 },
  broadcast: { i: -23, tp: -1, lra: 7 },
};

/** Resolve a preset name or a LUFS number to a full target. Pure. */
export function loudnessTarget(target: LoudnessPreset | number | undefined): LoudnessTarget {
  if (target === undefined) return LOUDNESS_PRESETS.youtube;
  if (typeof target === "number") {
    if (!Number.isFinite(target) || target < -70 || target > -5) {
      throw new ScreencastError("target LUFS must be between -70 and -5 (e.g. -14).");
    }
    return { i: target, tp: -1, lra: 11 };
  }
  const p = LOUDNESS_PRESETS[target];
  if (!p) throw new ScreencastError(`Unknown loudness target "${target}".`);
  return p;
}

const filterTarget = (t: LoudnessTarget) => `I=${t.i}:TP=${t.tp}:LRA=${t.lra}`;

/** Pass 1: measure the input; the JSON block lands on stderr. */
export function buildLoudnessMeasureArgs(input: string, t: LoudnessTarget): string[] {
  return ["-hide_banner", "-nostats", "-i", input, "-vn", "-af", `loudnorm=${filterTarget(t)}:print_format=json`, "-f", "null", "-"];
}

export interface LoudnessMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
  output_i?: number;
}

/** Pull the last loudnorm JSON block out of ffmpeg's stderr. Pure. */
export function parseLoudnorm(stderr: string): LoudnessMeasurement {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  const lastBlock = blocks?.at(-1);
  if (lastBlock === undefined) throw new ScreencastError("Could not measure loudness (no loudnorm report). Does the file have audio?");
  const raw = JSON.parse(lastBlock) as Record<string, string>;
  const num = (k: string) => Number(raw[k]);
  const m: LoudnessMeasurement = {
    input_i: num("input_i"),
    input_tp: num("input_tp"),
    input_lra: num("input_lra"),
    input_thresh: num("input_thresh"),
    target_offset: num("target_offset"),
    ...(raw.output_i !== undefined ? { output_i: num("output_i") } : {}),
  };
  if (!Number.isFinite(m.input_i)) {
    throw new ScreencastError("The audio is silent (loudness is -inf), so there is nothing to normalize.");
  }
  return m;
}

/** Copy the video through, unless the output is audio-only (.wav/.mp3/.m4a),
 * where a video map makes the muxer fail (#187). */
function keepVideoArgs(output: string): string[] {
  return isAudioOnlyPath(output)
    ? ["-map", "0:a:0", "-vn"]
    : ["-map", "0:v?", "-map", "0:a:0", "-c:v", "copy"];
}

/** Audio encoder for an output path: PCM for .wav, MP3 for .mp3, else AAC. */
export function audioCodecFor(output: string): string[] {
  switch (extname(output).toLowerCase()) {
    case ".wav":
      return ["-c:a", "pcm_s16le"];
    case ".mp3":
      return ["-c:a", "libmp3lame", "-b:a", "192k"];
    default:
      return ["-c:a", "aac", "-b:a", "192k"];
  }
}

/** loudnorm for a target: linear, from a pass-1 measurement, or single-pass
 * (dynamic) without one. Shared with pipeline (#244). Pure. */
export function loudnormFilter(t: LoudnessTarget, m?: LoudnessMeasurement): string {
  if (!m) return `loudnorm=${filterTarget(t)}`;
  const measured =
    `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
    `measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  return `loudnorm=${filterTarget(t)}:${measured}:linear=true`;
}

/** Pass 2: apply a linear correction from the measurement. loudnorm works at
 * 192 kHz internally, so the output rate is set back to 48 kHz. */
export function buildLoudnessApplyArgs(input: string, output: string, t: LoudnessTarget, m: LoudnessMeasurement): string[] {
  return [
    "-y", "-hide_banner", "-i", input,
    ...keepVideoArgs(output),
    "-af", `${loudnormFilter(t, m)}:print_format=json`,
    "-ar", "48000",
    ...audioCodecFor(output),
    output,
  ];
}

export type DenoiseStrength = "light" | "medium" | "strong";

/** afftdn noise-reduction amount (dB) per strength. */
export const DENOISE_NR: Record<DenoiseStrength, number> = { light: 6, medium: 12, strong: 20 };

/** Measure the audio's RMS level in 100 ms windows (printed to stdout), to
 * estimate its noise floor. */
export function buildNoiseFloorArgs(input: string): string[] {
  return [
    "-hide_banner", "-nostats", "-i", input, "-vn",
    "-af", "aresample=48000,asetnsamples=4800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-",
  ];
}

/** The noise floor: the 10th-percentile window RMS (dBFS), i.e. the level of
 * the quietest moments, which are mostly noise. Null for silence. Pure. */
export function parseNoiseFloor(stdout: string): number | null {
  const levels = [...stdout.matchAll(/RMS_level=(-?[\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  if (levels.length === 0) return null;
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length * 0.1)] ?? null;
}

/** afftdn's `nf` for a measured floor. afftdn only removes what it believes is
 * at or under nf, so a fixed value misses most real noise: white noise at
 * -25 dBFS was untouched with nf=-25 but cut 12-20 dB with nf set 5 dB above
 * the measured floor. Clamped to afftdn's range [-80, -20]. Pure. */
export function noiseFloorSetting(floorDb: number | null): number {
  if (floorDb === null) return -50;
  return Math.max(-80, Math.min(-20, Math.round(floorDb + 5)));
}

/** The afftdn filter for a strength and measured floor; shared with pipeline. Pure. */
export function denoiseFilter(strength: DenoiseStrength, noiseFloorDb: number | null): string {
  const nr = DENOISE_NR[strength];
  if (nr === undefined) throw new ScreencastError(`Unknown denoise strength "${strength}".`);
  return `afftdn=nr=${nr}:nf=${noiseFloorSetting(noiseFloorDb)}`;
}

/** Reduce steady background noise (fans, hum, hiss) with afftdn, using the
 * floor measured by buildNoiseFloorArgs. Pure. */
export function buildDenoiseArgs(
  input: string,
  output: string,
  strength: DenoiseStrength = "medium",
  noiseFloorDb: number | null = null,
): string[] {
  return [
    "-y", "-i", input,
    ...keepVideoArgs(output),
    "-af", denoiseFilter(strength, noiseFloorDb),
    ...audioCodecFor(output),
    output,
  ];
}
