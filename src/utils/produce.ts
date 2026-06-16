/**
 * Phase 3 produce / trailer-layer argument builders.
 *
 * These stitch, title, score, and reframe finished pieces. They re-encode (the
 * filters rewrite frames) and, where they combine clips, normalize every input
 * to a common resolution / fps / SAR / audio rate first so heterogeneous
 * sources compose cleanly. All builders are pure (string in, args out) and are
 * unit-tested without ffmpeg present.
 */
import { ScreencastError } from "./errors.js";
import { resolveQuality, type Quality } from "./targets.js";

export const DEFAULT_PRODUCE_WIDTH = 1920;
export const DEFAULT_PRODUCE_HEIGHT = 1080;
export const DEFAULT_PRODUCE_FPS = 30;
export const DEFAULT_AUDIO_RATE = 48000;
export const DEFAULT_TRANSITION_DUR = 1;
const DEFAULT_QUALITY: Quality = "standard";

export interface NormalizeOpts {
  width?: number;
  height?: number;
  fps?: number;
  audioRate?: number;
  quality?: Quality;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Video normalization chain: fit inside WxH, letterbox, square pixels, fixed
 * fps, web-safe pixel format. Makes any clip compatible with concat / xfade. */
export function videoNormalizeChain(w: number, h: number, fps: number): string {
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`
  );
}

/** Audio normalization chain: common sample rate, stereo, float planar. */
export function audioNormalizeChain(rate: number): string {
  return `aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=stereo`;
}

function encodeArgs(quality: Quality): string[] {
  return resolveQuality(quality);
}

/**
 * Offsets for an xfade chain. Joining clip m (m >= 1) onto the running result,
 * the transition starts at sum(d_0..d_{m-1}) - m*D. Returns one offset per join
 * (length = durations.length - 1).
 */
export function xfadeOffsets(durations: number[], transitionDur: number): number[] {
  const offsets: number[] = [];
  let running = 0;
  for (let m = 1; m < durations.length; m++) {
    running += durations[m - 1];
    offsets.push(Math.max(0, round3(running - m * transitionDur)));
  }
  return offsets;
}

export interface XfadeOptions extends NormalizeOpts {
  transition?: string;
  duration?: number;
}

/** Crossfade two clips. durA is the (probed) duration of the first clip, used
 * for the xfade offset. hasAudio means both inputs carry audio. */
export function buildXfadeArgs(
  inputA: string,
  inputB: string,
  durA: number,
  output: string,
  opts: XfadeOptions = {},
  hasAudio = false,
): string[] {
  const w = opts.width ?? DEFAULT_PRODUCE_WIDTH;
  const h = opts.height ?? DEFAULT_PRODUCE_HEIGHT;
  const fps = opts.fps ?? DEFAULT_PRODUCE_FPS;
  const rate = opts.audioRate ?? DEFAULT_AUDIO_RATE;
  const transition = opts.transition ?? "fade";
  const d = opts.duration ?? DEFAULT_TRANSITION_DUR;
  if (!Number.isFinite(d) || d <= 0) {
    throw new ScreencastError("transition duration must be a positive number.");
  }
  if (!Number.isFinite(durA) || durA <= d) {
    throw new ScreencastError(
      `first clip (${durA}s) must be longer than the transition (${d}s).`,
    );
  }
  const offset = round3(durA - d);
  const vf = videoNormalizeChain(w, h, fps);
  const af = audioNormalizeChain(rate);
  const parts = [
    `[0:v]${vf}[v0]`,
    `[1:v]${vf}[v1]`,
    `[v0][v1]xfade=transition=${transition}:duration=${d}:offset=${offset}[vout]`,
  ];
  const maps = ["-map", "[vout]"];
  if (hasAudio) {
    parts.push(`[0:a]${af}[a0]`, `[1:a]${af}[a1]`, `[a0][a1]acrossfade=d=${d}[aout]`);
    maps.push("-map", "[aout]");
  }
  return [
    "-y", "-i", inputA, "-i", inputB,
    "-filter_complex", parts.join(";"),
    ...maps,
    ...encodeArgs(opts.quality ?? DEFAULT_QUALITY),
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-movflags", "+faststart",
    output,
  ];
}

export interface AssembleOptions extends NormalizeOpts {
  transition?: string;
  duration?: number;
}

/**
 * Stitch N clips into one. transition "cut" uses the concat filter; any other
 * value is an xfade transition name and chains xfade (video) + acrossfade
 * (audio) using the supplied per-clip durations. hasAudio means every input
 * carries audio.
 */
export function buildAssembleArgs(
  inputs: string[],
  durations: number[],
  output: string,
  opts: AssembleOptions = {},
  hasAudio = false,
): string[] {
  if (inputs.length < 2) {
    throw new ScreencastError("assemble_highlights requires at least two clips.");
  }
  const w = opts.width ?? DEFAULT_PRODUCE_WIDTH;
  const h = opts.height ?? DEFAULT_PRODUCE_HEIGHT;
  const fps = opts.fps ?? DEFAULT_PRODUCE_FPS;
  const rate = opts.audioRate ?? DEFAULT_AUDIO_RATE;
  const transition = opts.transition ?? "cut";
  const d = opts.duration ?? DEFAULT_TRANSITION_DUR;
  const n = inputs.length;
  const vf = videoNormalizeChain(w, h, fps);
  const af = audioNormalizeChain(rate);

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:v]${vf}[v${i}]`);
    if (hasAudio) parts.push(`[${i}:a]${af}[a${i}]`);
  }

  const maps: string[] = [];
  if (transition === "cut") {
    if (hasAudio) {
      const labels = inputs.map((_, i) => `[v${i}][a${i}]`).join("");
      parts.push(`${labels}concat=n=${n}:v=1:a=1[vout][aout]`);
      maps.push("-map", "[vout]", "-map", "[aout]");
    } else {
      const labels = inputs.map((_, i) => `[v${i}]`).join("");
      parts.push(`${labels}concat=n=${n}:v=1:a=0[vout]`);
      maps.push("-map", "[vout]");
    }
  } else {
    if (durations.length !== n) {
      throw new ScreencastError(
        `a ${transition} transition needs a duration for each of the ${n} clips.`,
      );
    }
    if (!Number.isFinite(d) || d <= 0) {
      throw new ScreencastError("transition duration must be a positive number.");
    }
    const offsets = xfadeOffsets(durations, d);
    let vPrev = "v0";
    for (let m = 1; m < n; m++) {
      const out = m === n - 1 ? "vout" : `vx${m}`;
      parts.push(
        `[${vPrev}][v${m}]xfade=transition=${transition}:duration=${d}:offset=${offsets[m - 1]}[${out}]`,
      );
      vPrev = out;
    }
    maps.push("-map", "[vout]");
    if (hasAudio) {
      let aPrev = "a0";
      for (let m = 1; m < n; m++) {
        const out = m === n - 1 ? "aout" : `ax${m}`;
        parts.push(`[${aPrev}][a${m}]acrossfade=d=${d}[${out}]`);
        aPrev = out;
      }
      maps.push("-map", "[aout]");
    }
  }

  return [
    "-y",
    ...inputs.flatMap((f) => ["-i", f]),
    "-filter_complex", parts.join(";"),
    ...maps,
    ...encodeArgs(opts.quality ?? DEFAULT_QUALITY),
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-movflags", "+faststart",
    output,
  ];
}
