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
import { escapeFilterPath } from "./fonts.js";
import { validateTransition, validateColor } from "./validate.js";

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
  const transition = validateTransition(opts.transition ?? "fade");
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
  clipHasAudio: boolean[] = [],
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

  // If any clip has audio, the output carries audio: clips that lack a track get
  // a matching length of generated silence, so a single video-only clip no
  // longer drops audio from the whole result. If no clip has audio, stay
  // video-only.
  const anyAudio = clipHasAudio.some(Boolean);

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:v]${vf}[v${i}]`);
    if (!anyAudio) continue;
    if (clipHasAudio[i]) {
      parts.push(`[${i}:a]${af}[a${i}]`);
    } else {
      const dur = durations[i];
      if (!Number.isFinite(dur) || dur <= 0) {
        throw new ScreencastError(
          `clip ${i} has no audio track and its duration is unknown, so a ` +
            `matching silent track cannot be generated.`,
        );
      }
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=${rate}:d=${dur}[a${i}]`);
    }
  }

  const maps: string[] = [];
  if (transition === "cut") {
    if (anyAudio) {
      const labels = inputs.map((_, i) => `[v${i}][a${i}]`).join("");
      parts.push(`${labels}concat=n=${n}:v=1:a=1[vout][aout]`);
      maps.push("-map", "[vout]", "-map", "[aout]");
    } else {
      const labels = inputs.map((_, i) => `[v${i}]`).join("");
      parts.push(`${labels}concat=n=${n}:v=1:a=0[vout]`);
      maps.push("-map", "[vout]");
    }
  } else {
    validateTransition(transition);
    if (durations.length !== n) {
      throw new ScreencastError(
        `a ${transition} transition needs a duration for each of the ${n} clips.`,
      );
    }
    if (!Number.isFinite(d) || d <= 0) {
      throw new ScreencastError("transition duration must be a positive number.");
    }
    // Every clip must be longer than the transition, or xfade offsets collapse
    // (a too-short or unknown-duration clip yields overlapping/garbled cuts).
    const badClip = durations.findIndex((dur) => !Number.isFinite(dur) || dur <= d);
    if (badClip !== -1) {
      throw new ScreencastError(
        `clip ${badClip} (${durations[badClip]}s) must be longer than the ` +
          `${d}s ${transition} transition. Use a shorter transition or trim fewer frames.`,
      );
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
    if (anyAudio) {
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
    ...(anyAudio ? ["-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-movflags", "+faststart",
    output,
  ];
}

export interface TitleCardOptions {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  bg?: string;
  fontColor?: string;
  fontSize?: number;
  quality?: Quality;
}

/** Generate a standalone title clip: a solid background with centered text from
 * a font file and a temp text file (so arbitrary text needs no inline
 * escaping), plus a silent stereo track so it composes with audio-bearing
 * clips. Caller resolves fontFile (a bundled weight) and writes textFile. */
export function buildTitleCardArgs(
  textFile: string,
  fontFile: string,
  output: string,
  opts: TitleCardOptions = {},
): string[] {
  const w = opts.width ?? DEFAULT_PRODUCE_WIDTH;
  const h = opts.height ?? DEFAULT_PRODUCE_HEIGHT;
  const dur = opts.duration ?? 3;
  const fps = opts.fps ?? DEFAULT_PRODUCE_FPS;
  const bg = validateColor(opts.bg ?? "black", "bg");
  const fontColor = validateColor(opts.fontColor ?? "white", "fontColor");
  const fontSize = opts.fontSize ?? 96;
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new ScreencastError("title duration must be a positive number.");
  }
  if (!Number.isInteger(fontSize) || fontSize <= 0) {
    throw new ScreencastError("fontSize must be a positive integer.");
  }
  const draw =
    `drawtext=fontfile=${escapeFilterPath(fontFile)}:` +
    `textfile=${escapeFilterPath(textFile)}:` +
    `fontcolor=${fontColor}:fontsize=${fontSize}:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:` +
    `shadowcolor=black@0.5:shadowx=2:shadowy=2`;
  return [
    "-y",
    "-f", "lavfi", "-i", `color=c=${bg}:s=${w}x${h}:d=${dur}:r=${fps}`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-vf", draw,
    "-shortest",
    ...encodeArgs(opts.quality ?? DEFAULT_QUALITY),
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    output,
  ];
}

export interface MusicBedOptions {
  musicVolume?: number;
  fadeIn?: number;
  fadeOut?: number;
  duck?: boolean;
}

/** Lay a music track under a video: loop/trim the music to the video duration,
 * fade it in/out, and set its level. When the video already has audio the two
 * are mixed (optionally ducking the music under the original via a sidechain).
 * The video stream is copied; only audio is re-encoded. */
export function buildMusicBedArgs(
  video: string,
  music: string,
  output: string,
  videoDuration: number,
  hasVideoAudio: boolean,
  opts: MusicBedOptions = {},
): string[] {
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
    throw new ScreencastError("video duration must be known and positive.");
  }
  const vol = opts.musicVolume ?? (hasVideoAudio ? 0.25 : 0.8);
  const fin = opts.fadeIn ?? 1;
  const fout = opts.fadeOut ?? 2;
  for (const [v, label] of [[vol, "musicVolume"], [fin, "fadeIn"], [fout, "fadeOut"]] as const) {
    if (!Number.isFinite(v) || v < 0) {
      throw new ScreencastError(`${label} must be a non-negative number.`);
    }
  }
  const duck = opts.duck ?? false;
  const fadeOutStart = Math.max(0, round3(videoDuration - fout));
  const musicChain =
    `[1:a]afade=t=in:st=0:d=${fin},afade=t=out:st=${fadeOutStart}:d=${fout},volume=${vol}`;

  const parts: string[] = [];
  if (hasVideoAudio) {
    parts.push(`${musicChain}[music]`);
    if (duck) {
      parts.push("[music][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked]");
      parts.push("[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0[aout]");
    } else {
      parts.push("[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]");
    }
  } else {
    parts.push(`${musicChain}[aout]`);
  }

  return [
    "-y",
    "-i", video,
    "-stream_loop", "-1", "-i", music,
    "-filter_complex", parts.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-t", String(videoDuration),
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    output,
  ];
}

// --- Aspect variants and platform export ----------------------------------

export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
export type ReframeFit = "pad" | "crop";

/** Canonical target dimensions per aspect (even dims, social-ready). */
export const ASPECT_DIMS: Record<Aspect, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
};

/** Filter chain to fit content into a WxH canvas. pad scales to fit and adds
 * bars (no content lost); crop scales to fill and center-crops the overflow. */
export function reframeFilter(w: number, h: number, fit: ReframeFit): string {
  if (fit === "crop") {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  }
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  );
}

/** Re-aspect a video to a target aspect with pad (default) or crop. */
export function buildReframeArgs(
  input: string,
  output: string,
  aspect: Aspect,
  fit: ReframeFit = "pad",
  quality: Quality = DEFAULT_QUALITY,
): string[] {
  const dim = ASPECT_DIMS[aspect];
  if (!dim) throw new ScreencastError(`Unknown aspect "${aspect}".`);
  return [
    "-y", "-i", input,
    "-vf", `${reframeFilter(dim.w, dim.h, fit)},format=yuv420p`,
    ...encodeArgs(quality),
    "-c:a", "copy",
    "-movflags", "+faststart",
    output,
  ];
}

export type Platform = "youtube" | "instagram_reel" | "tiktok" | "x" | "square";

interface PresetSpec {
  aspect: Aspect;
  fps: number;
  videoBitrate: string;
  bufsize: string;
  audioBitrate: string;
}

export const PLATFORM_PRESETS: Record<Platform, PresetSpec> = {
  youtube: { aspect: "16:9", fps: 30, videoBitrate: "8M", bufsize: "16M", audioBitrate: "192k" },
  instagram_reel: { aspect: "9:16", fps: 30, videoBitrate: "6M", bufsize: "12M", audioBitrate: "160k" },
  tiktok: { aspect: "9:16", fps: 30, videoBitrate: "6M", bufsize: "12M", audioBitrate: "160k" },
  x: { aspect: "16:9", fps: 30, videoBitrate: "5M", bufsize: "10M", audioBitrate: "128k" },
  square: { aspect: "1:1", fps: 30, videoBitrate: "6M", bufsize: "12M", audioBitrate: "160k" },
};

/** Encode a platform-ready file: reframe to the platform aspect, cap fps, and
 * encode H.264 at the platform's bitrate with faststart. */
export function buildExportPresetArgs(
  input: string,
  output: string,
  platform: Platform,
  fit: ReframeFit = "pad",
): string[] {
  const p = PLATFORM_PRESETS[platform];
  if (!p) throw new ScreencastError(`Unknown platform "${platform}".`);
  const dim = ASPECT_DIMS[p.aspect];
  const vf = `${reframeFilter(dim.w, dim.h, fit)},fps=${p.fps},format=yuv420p`;
  return [
    "-y", "-i", input,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "medium",
    "-b:v", p.videoBitrate, "-maxrate", p.videoBitrate, "-bufsize", p.bufsize,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", p.audioBitrate,
    "-r", String(p.fps),
    "-movflags", "+faststart",
    output,
  ];
}
