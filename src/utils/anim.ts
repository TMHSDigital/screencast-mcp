/**
 * Animated GIF / WebP export with a file-size budget (#124).
 *
 * The usual home for a developer's screen recording is an animated image in a
 * PR, issue, or README. A plain GIF conversion bands and balloons, so export
 * uses a two-stage palette (diff stats, sierra dithering, rectangle diff mode)
 * or animated WebP, and steps down a quality ladder until the file fits
 * `maxBytes` (GitHub's limit for images is 10 MB). Builders here are pure.
 */
import { ScreencastError } from "./errors.js";

export type AnimFormat = "gif" | "webp";

export const DEFAULT_ANIM_FPS = 12;
export const DEFAULT_ANIM_WIDTH = 960;
/** Fits under GitHub's 10 MB limit for images in issues, PRs, and READMEs. */
export const DEFAULT_MAX_BYTES = 10_000_000;
/** Most encode attempts before settling for the smallest one made. */
export const MAX_ATTEMPTS = 5;

export interface AnimSettings {
  fps: number;
  width: number;
  /** GIF palette size (gif only). */
  colors?: number;
  /** libwebp quality 0-100 (webp only). */
  quality?: number;
}

/** Quality ladder from the caller's fps/width. Each step roughly halves the
 * file size (measured on a high-motion 960 px clip: 6.0 -> 3.4 -> 1.7 ->
 * 0.7 MB for GIF). */
export function animLadder(format: AnimFormat, fps: number, width: number): AnimSettings[] {
  const steps: Array<[number, number, number]> =
    format === "gif"
      ? [[1, 1, 256], [0.83, 0.8, 256], [0.67, 0.67, 128], [0.5, 0.5, 64], [0.4, 0.4, 32], [0.33, 0.33, 16]]
      : [[1, 1, 75], [0.83, 0.8, 65], [0.67, 0.67, 55], [0.5, 0.5, 45], [0.4, 0.4, 35], [0.33, 0.33, 25]];
  return steps.map(([f, w, q]) => ({
    fps: Math.max(1, Math.round(fps * f * 10) / 10),
    width: Math.max(64, Math.round((width * w) / 2) * 2),
    ...(format === "gif" ? { colors: q } : { quality: q }),
  }));
}

/** Which ladder step to try next after an attempt of `size` bytes at step
 * `index` missed the budget: one step per ~1.8x over, at least one, but never
 * past the last (smallest) step. Returns null when that step was just tried. */
export function nextLadderIndex(
  index: number,
  size: number,
  maxBytes: number,
  ladderLength: number,
): number | null {
  const last = ladderLength - 1;
  if (index >= last) return null;
  const jump = Math.max(1, Math.ceil(Math.log(size / maxBytes) / Math.log(1.8)));
  return Math.min(last, index + jump);
}

export interface AnimClip {
  /** Start offset in seconds. */
  start?: number;
  /** Length in seconds (default: to the end). */
  duration?: number;
}

/** Encode one attempt. GIF uses a palette built from frame differences
 * (stats_mode=diff), which suits screen recordings where little changes. */
export function buildAnimArgs(
  input: string,
  output: string,
  format: AnimFormat,
  s: AnimSettings,
  clip: AnimClip = {},
): string[] {
  if (!(s.fps > 0) || !Number.isInteger(s.width) || s.width < 16) {
    throw new ScreencastError("fps must be positive and width an integer of at least 16.");
  }
  if (clip.start !== undefined && !(clip.start >= 0)) throw new ScreencastError("start must be >= 0.");
  if (clip.duration !== undefined && !(clip.duration > 0)) throw new ScreencastError("duration must be > 0.");
  const window = [
    ...(clip.start ? ["-ss", String(clip.start)] : []),
    ...(clip.duration ? ["-t", String(clip.duration)] : []),
  ];
  // Never upscale: a bigger GIF of a small clip only costs bytes (#189).
  const base = `fps=${s.fps},scale='min(${s.width},iw)':-1:flags=lanczos`;
  if (format === "gif") {
    const colors = s.colors ?? 256;
    return [
      "-y", ...window, "-i", input, "-an",
      "-vf",
      `${base},split[a][b];[a]palettegen=stats_mode=diff:max_colors=${colors}[p];` +
        "[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
      "-loop", "0",
      output,
    ];
  }
  return [
    "-y", ...window, "-i", input, "-an",
    "-vf", base,
    "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", String(s.quality ?? 75),
    "-compression_level", "4", "-loop", "0",
    output,
  ];
}
