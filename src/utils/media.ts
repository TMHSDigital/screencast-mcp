/**
 * ffprobe parsing and the Phase 1 edit/watch argument builders.
 *
 * All functions here are pure (string in, args/strings out) so the edit and
 * watch surfaces are unit-tested without ffmpeg present.
 */
import { extname } from "node:path";
import { ScreencastError } from "./errors.js";
import { resolveQuality, type Quality } from "./targets.js";
import { validateColor, validateEvenDimension } from "./validate.js";
import { stillOutput } from "./paths.js";

/** Edit re-encodes default to the same preset as a standard capture. */
const DEFAULT_EDIT_QUALITY: Quality = "standard";

export interface MediaInfo {
  /** Container duration: the longest stream. */
  durationSec: number | null;
  /** The video stream's own duration (falls back to the container's), the
   * length to cut and crossfade on when audio and video differ (#205). */
  videoDurationSec: number | null;
  /** Display size: after the stream's rotation, which ffmpeg applies before
   * any filter, so it is the frame edits and redaction work on (#204). */
  width: number | null;
  height: number | null;
  /** Rotation in degrees the player applies, when the file carries one. */
  rotation?: number;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  format: string | null;
  sizeBytes: number | null;
  pixFmt: string | null;
  /** Video packets in the file, including any an edit list hides (#203). */
  videoFrames: number | null;
  sampleRate: number | null;
  channels: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  pix_fmt?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number | string }>;
  tags?: { rotate?: string };
}

function numberOrNull(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string; size?: string };
}

/** Parse an `avg_frame_rate` / `r_frame_rate` rational ("30000/1001") to fps. */
export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  if (n === 0) return null;
  return Math.round((n / d) * 1000) / 1000;
}

/** The display rotation of a video stream in degrees (display-matrix side
 * data, or the older `rotate` tag), or null. */
function streamRotation(video: FfprobeStream | undefined): number | null {
  const side = video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
  const raw = side ?? video?.tags?.rotate;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.round(n) % 360 : null;
}

/** Reduce a parsed ffprobe JSON document to a flat MediaInfo. */
export function parseMediaInfo(probe: FfprobeJson): MediaInfo {
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = probe.format?.duration;
  const size = probe.format?.size;
  const durationSec = duration !== undefined ? Number(duration) : null;
  const rotation = streamRotation(video);
  // ffmpeg auto-rotates on decode, so a 90-degree file filters as height x width.
  const turned = rotation !== null && Math.abs(rotation) % 180 === 90;
  return {
    durationSec,
    videoDurationSec: video ? (numberOrNull(video.duration) ?? durationSec) : null,
    width: (turned ? video?.height : video?.width) ?? null,
    height: (turned ? video?.width : video?.height) ?? null,
    ...(rotation ? { rotation } : {}),
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    format: probe.format?.format_name ?? null,
    sizeBytes: size !== undefined ? Number(size) : null,
    pixFmt: video?.pix_fmt ?? null,
    videoFrames: numberOrNull(video?.nb_frames),
    sampleRate: numberOrNull(audio?.sample_rate),
    channels: audio?.channels ?? null,
  };
}

export function buildProbeArgs(input: string): string[] {
  return [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    input,
  ];
}

function validatePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScreencastError(`${label} must be a positive number.`);
  }
  return value;
}

/** Default and ceiling for how many frames one sample_frames call may write. */
export const DEFAULT_MAX_FRAMES = 100;
export const MAX_FRAMES_CEILING = 1000;

export interface FpsPlan {
  /** The rate actually used; lower than requested when clamped. */
  fps: number;
  /** Frames the requested rate would have written, or null when the duration is unknown. */
  requestedFrames: number | null;
  clamped: boolean;
}

/** Fit a requested sampling rate under a frame cap (#80). When duration * fps
 * would exceed maxFrames, lower the rate so the frames still span the whole
 * video instead of stopping partway. An unknown duration leaves the rate as
 * asked; the -frames:v backstop in buildSampleByFpsArgs still applies. */
export function planFpsSampling(
  durationSec: number | null,
  fps: number,
  maxFrames: number,
): FpsPlan {
  validatePositive(fps, "fps");
  if (durationSec === null || !(durationSec > 0)) {
    return { fps, requestedFrames: null, clamped: false };
  }
  const requested = Math.ceil(durationSec * fps);
  if (requested <= maxFrames) return { fps, requestedFrames: requested, clamped: false };
  // Round down to 4 decimals so the clamped rate never overshoots the cap.
  const clampedFps = Math.max(1e-4, Math.floor((maxFrames / durationSec) * 10_000) / 10_000);
  return { fps: clampedFps, requestedFrames: requested, clamped: true };
}

/** Sample frames at a fixed rate: ffmpeg -i in -vf fps=N -frames:v MAX
 * outdir/frame_%05d.png. -frames:v is a hard backstop on the frame count. */
export function buildSampleByFpsArgs(
  input: string,
  fps: number,
  outputPattern: string,
  maxFrames: number = DEFAULT_MAX_FRAMES,
  dedupe = false,
  range?: { start: number; duration?: number },
): string[] {
  validatePositive(fps, "fps");
  // dedupe (#114): mpdecimate drops frames nearly identical to the previous
  // kept one, and -fps_mode vfr stops the muxer re-inserting them.
  const vf = dedupe ? `fps=${fps},mpdecimate` : `fps=${fps}`;
  // range (#198): an input seek, so frame i is at range.start + i / fps, the
  // same clock as a clip cut with a leading pipeline trim.
  const seek = range
    ? ["-ss", String(range.start), ...(range.duration !== undefined ? ["-t", String(range.duration)] : [])]
    : [];
  return [
    "-y", ...seek, "-i", input, "-vf", vf,
    ...(dedupe ? ["-fps_mode", "vfr"] : []),
    "-frames:v", String(maxFrames), outputPattern,
  ];
}

/** Default scene-change threshold for UI content (#114). Screen recordings
 * change in small regions, so this is lower than the 0.3-0.4 usual for film. */
export const DEFAULT_SCENE_THRESHOLD = 0.1;

/** Scan a video for scene changes: a cheap pass on a 320 px-wide copy that
 * prints each frame whose scene score exceeds `threshold` (pts_time + score)
 * to stdout. Frames are then grabbed at full size at those timestamps. */
export function buildSceneScanArgs(input: string, threshold: number = DEFAULT_SCENE_THRESHOLD): string[] {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new ScreencastError("sceneThreshold must be between 0 and 1 (exclusive).");
  }
  return [
    "-v", "error", "-i", input, "-an",
    "-vf", `scale=320:-2,select='gt(scene\\,${threshold})',metadata=print:file=-`,
    "-f", "null", "-",
  ];
}

export interface SceneChange {
  timeSec: number;
  score: number;
}

/** Parse `metadata=print` output into (time, score) pairs. Pure. */
export function parseSceneScan(stdout: string): SceneChange[] {
  const out: SceneChange[] = [];
  let time: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.match(/pts_time:\s*(-?[\d.]+)/);
    if (t) {
      time = Number(t[1]);
      continue;
    }
    const s = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (s && time !== null) {
      out.push({ timeSec: time, score: Number(s[1]) });
      time = null;
    }
  }
  return out;
}

/** Choose which frames to keep: always the opening frame (t=0), then the
 * strongest scene changes up to maxFrames total, returned in time order.
 * Pure. */
export function pickSceneFrames(changes: SceneChange[], maxFrames: number): number[] {
  const strongest = [...changes]
    .filter((c) => c.timeSec > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxFrames - 1))
    .map((c) => c.timeSec);
  return [0, ...strongest].sort((a, b) => a - b);
}

/** Build one ffmpeg invocation per timestamp (accurate single-frame seek). */
export function buildSampleAtTimestampArgs(
  input: string,
  timestampSec: number,
  output: string,
): string[] {
  if (!Number.isFinite(timestampSec) || timestampSec < 0) {
    throw new ScreencastError("timestamp must be a non-negative number.");
  }
  return ["-y", "-ss", String(timestampSec), "-i", input, "-frames:v", "1", ...stillOutput(output)];
}

/** The default output extension for an edit that encodes libx264/AAC: the
 * input's own container when it can hold those codecs, else .mp4 (a WebM
 * cannot, #187). */
export function editOutputExt(input: string, opts: { audio?: boolean } = {}): string {
  const ext = extname(input).toLowerCase();
  if (ext === ".mp4" || ext === ".mkv" || ext === ".mov") return ext;
  // Audio tools also keep an audio-only container they can encode to.
  if (opts.audio && AUDIO_ONLY_EXTS.has(ext)) return ext;
  return ".mp4";
}

const AUDIO_ONLY_EXTS = new Set([".wav", ".mp3", ".m4a"]);

/** True when the output path is an audio-only container (.wav/.mp3/.m4a). */
export function isAudioOnlyPath(path: string): boolean {
  return AUDIO_ONLY_EXTS.has(extname(path).toLowerCase());
}

/** Refuse an explicit output path whose container cannot hold the H.264/AAC
 * an edit writes, instead of ffmpeg's cryptic "Nothing was written" (#187). */
export function assertEditContainer(output: string | undefined): void {
  if (output === undefined) return;
  const ext = extname(output).toLowerCase();
  if (ext === ".webm" || ext === ".gif") {
    throw new ScreencastError(
      `This tool writes H.264/AAC, which a ${ext} file cannot hold. Use an .mp4, .mkv or .mov ` +
        `output, then convert (format: "webm") or export_gif the result.`,
    );
  }
}

/** Trim by start + (end | duration). Re-encodes by default so the file holds
 * nothing from before `start`; `exact: false` stream-copies, which is fast but
 * keeps the GOP before `start` in the file, hidden behind an edit list (#203). */
export function buildTrimArgs(
  input: string,
  output: string,
  opts: { start: number; end?: number; duration?: number; exact?: boolean },
): string[] {
  const start = opts.start;
  if (!Number.isFinite(start) || start < 0) {
    throw new ScreencastError("start must be a non-negative number.");
  }
  if (opts.end === undefined && opts.duration === undefined) {
    throw new ScreencastError("trim requires either end or duration.");
  }
  if (opts.end !== undefined && opts.duration !== undefined) {
    throw new ScreencastError("trim takes end OR duration, not both.");
  }
  const args = ["-y", "-ss", String(start), "-i", input];
  if (opts.end !== undefined) {
    if (opts.end <= start) {
      throw new ScreencastError("end must be greater than start.");
    }
    // Input-side -ss resets output timestamps to 0, so an output -to would be
    // read as a duration (#75). Emit the real length instead.
    args.push("-t", String(Math.round((opts.end - start) * 1000) / 1000));
  } else {
    args.push("-t", String(validatePositive(opts.duration!, "duration")));
  }
  if (opts.exact === false) args.push("-c", "copy", output);
  else args.push(...resolveQuality(DEFAULT_EDIT_QUALITY), "-c:a", "aac", output);
  return args;
}

/** Build the concat-demuxer list file content for a set of inputs. */
export function buildConcatListContent(inputs: string[]): string {
  if (inputs.length < 2) {
    throw new ScreencastError("concat requires at least two input files.");
  }
  return (
    inputs
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n") + "\n"
  );
}

export function buildConcatArgs(listFile: string, output: string): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output];
}

/** True when a file holds noticeably more video packets than its duration
 * plays: frames hidden behind an edit list, as a stream-copy trim leaves
 * them (#203). A stream-copy concat would carry them into the join. */
export function hasHiddenFrames(info: MediaInfo): boolean {
  const { videoFrames: n, videoDurationSec: d, fps } = info;
  if (n === null || d === null || fps === null) return false;
  return n > d * fps * 1.05 + 2;
}

/** Why a set of inputs cannot be joined by stream copy, or null when they
 * can: the concat demuxer needs identical codecs, size, pixel format, frame
 * rate and audio layout, and silently writes a broken file otherwise (#206). */
export function concatCopyBlocker(paths: string[], infos: MediaInfo[]): string | null {
  const fields: [keyof MediaInfo, string][] = [
    ["videoCodec", "video codec"],
    ["width", "width"],
    ["height", "height"],
    ["pixFmt", "pixel format"],
    ["fps", "frame rate"],
    ["audioCodec", "audio codec"],
    ["sampleRate", "audio sample rate"],
    ["channels", "audio channels"],
  ];
  const first = infos[0];
  for (const [i, info] of infos.entries()) {
    if (hasHiddenFrames(info)) return `${paths[i]} holds hidden frames behind an edit list`;
    if (i === 0 || !first) continue;
    for (const [key, label] of fields) {
      if (info[key] !== first[key]) {
        return `${label} differs: ${paths[0]} has ${first[key] ?? "none"}, ${paths[i]} has ${info[key] ?? "none"}`;
      }
    }
  }
  return null;
}

export type ConvertFormat = "mp4" | "gif" | "webm";

/** Build conversion args for mp4 <-> gif/webm. gif uses a single-pass
 * palette-quality filter; webm uses VP9; mp4 uses H.264. */
export function buildConvertArgs(
  input: string,
  output: string,
  format: ConvertFormat,
  opts: { fps?: number; width?: number } = {},
): string[] {
  switch (format) {
    case "gif": {
      const fps = opts.fps ?? 12;
      const width = opts.width ?? 720;
      const filter =
        `fps=${fps},scale='min(${width},iw)':-1:flags=lanczos,split[s0][s1];` +
        `[s0]palettegen[p];[s1][p]paletteuse`;
      return ["-y", "-i", input, "-vf", filter, output];
    }
    case "webm":
      return [
        "-y", "-i", input,
        // libvpx's default deadline is its slowest; "good" at cpu-used 4 is
        // several times faster for little size cost (#189).
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30",
        "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
        output,
      ];
    case "mp4":
      return [
        "-y", "-i", input,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output,
      ];
    default:
      throw new ScreencastError(`Unsupported convert format "${format}".`);
  }
}

// --- Phase 2 edit surface -------------------------------------------------
//
// Every tool below RE-ENCODES (a filter rewrites pixels, so stream copy is not
// an option). They reuse resolveQuality() so the draft/standard/high presets
// are identical to capture. Audio is copied unless a filter forces a re-encode.

function requireNonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ScreencastError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requirePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ScreencastError(`${label} must be a positive integer.`);
  }
  return value;
}

/** Build a libavfilter `enable=` timeline expression, or "" for always-on. */
export function enableExpr(start?: number, end?: number): string {
  if (start !== undefined && end !== undefined) {
    if (end <= start) throw new ScreencastError("end must be greater than start.");
    return `between(t,${start},${end})`;
  }
  if (start !== undefined) return `gte(t,${start})`;
  if (end !== undefined) return `lte(t,${end})`;
  return "";
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Crop to a pixel rectangle. If frame dims are supplied, a rectangle that
 * runs off the frame is rejected rather than silently clamped by ffmpeg. */
/** The crop filter for a rectangle, validated against the frame when known.
 * Shared by crop and pipeline. */
export function cropFilter(rect: CropRect, dims?: { width: number | null; height: number | null }): string {
  const x = requireNonNegativeInt(rect.x, "crop x");
  const y = requireNonNegativeInt(rect.y, "crop y");
  const w = validateEvenDimension(requirePositiveInt(rect.width, "crop width"), "crop width");
  const h = validateEvenDimension(requirePositiveInt(rect.height, "crop height"), "crop height");
  if (dims && dims.width != null && dims.height != null) {
    if (x + w > dims.width || y + h > dims.height) {
      throw new ScreencastError(
        `crop region ${w}x${h}+${x}+${y} falls outside the ` +
          `${dims.width}x${dims.height} frame.`,
      );
    }
  }
  return `crop=${w}:${h}:${x}:${y}`;
}

export function buildCropArgs(
  input: string,
  output: string,
  rect: CropRect,
  dims?: { width: number | null; height: number | null },
  quality: Quality = DEFAULT_EDIT_QUALITY,
): string[] {
  return [
    "-y", "-i", input,
    "-vf", cropFilter(rect, dims),
    ...resolveQuality(quality),
    "-c:a", "copy",
    output,
  ];
}

/** Scale to a width and/or height. A missing side uses -2 (keep aspect, even
 * dimension as required by yuv420p). */
export function scaleFilter(opts: { width?: number; height?: number }): string {
  if (opts.width === undefined && opts.height === undefined) {
    throw new ScreencastError("scale requires width or height (or both).");
  }
  if (opts.width !== undefined) {
    validateEvenDimension(requirePositiveInt(opts.width, "scale width"), "scale width");
  }
  if (opts.height !== undefined) {
    validateEvenDimension(requirePositiveInt(opts.height, "scale height"), "scale height");
  }
  return `scale=${opts.width ?? -2}:${opts.height ?? -2}`;
}

/** The frame size scaleFilter produces from a W x H source (-2 keeps aspect
 * and rounds to an even size, as ffmpeg does). */
export function scaledSize(W: number, H: number, opts: { width?: number; height?: number }): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  if (opts.width !== undefined && opts.height !== undefined) return { width: opts.width, height: opts.height };
  if (opts.width !== undefined) return { width: opts.width, height: even((H * opts.width) / W) };
  return { width: even((W * opts.height!) / H), height: opts.height! };
}

export function buildScaleArgs(
  input: string,
  output: string,
  opts: { width?: number; height?: number },
  quality: Quality = DEFAULT_EDIT_QUALITY,
): string[] {
  return [
    "-y", "-i", input,
    "-vf", scaleFilter(opts),
    ...resolveQuality(quality),
    "-c:a", "copy",
    output,
  ];
}

/** Decompose a tempo factor into an atempo chain (each atempo is limited to
 * the 0.5 - 2.0 range, so larger changes are multiplied across stages). */
export function atempoChain(factor: number): string {
  let remaining = factor;
  const parts: string[] = [];
  while (remaining > 2.0) {
    parts.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  // Six decimals: rounding to three drifted ~0.9 s over 10 minutes at 1/3 (#186).
  parts.push(`atempo=${Number(remaining.toFixed(6))}`);
  return parts.join(",");
}

/** Change playback speed. factor > 1 is faster, < 1 is slower. Video uses
 * setpts; audio is retempo'd when present and dropped otherwise. */
export function buildSpeedArgs(
  input: string,
  output: string,
  factor: number,
  hasAudio: boolean,
  quality: Quality = DEFAULT_EDIT_QUALITY,
): string[] {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new ScreencastError("speed factor must be a positive number.");
  }
  const args = ["-y", "-i", input, "-filter:v", `setpts=PTS/${factor}`];
  if (hasAudio) args.push("-filter:a", atempoChain(factor));
  args.push(...resolveQuality(quality));
  if (hasAudio) {
    args.push("-c:a", "aac");
  } else {
    args.push("-an");
  }
  args.push(output);
  return args;
}

export interface OverlayOptions {
  x: number;
  y: number;
  start?: number;
  end?: number;
  scale?: { width?: number; height?: number };
  /** The main input's length: the output never runs longer (#188). */
  durationSec?: number | null;
  /** circle: crop the overlay to its centre square and mask a circle (a
   * webcam bubble, #200). */
  shape?: "rect" | "circle";
}

/** Crop to the centre square and make everything outside the inscribed
 * circle transparent. Pure. */
export const CIRCLE_MASK =
  "crop='min(iw,ih)':'min(iw,ih)',format=yuva420p," +
  "geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lte(hypot(X-W/2,Y-H/2),W/2),255,0)'";

/** Composite an overlay image or video onto the input at (x, y), optionally
 * scaled and optionally limited to a time window. The overlay's clock is
 * shifted to `start`, so a video plays from its first frame inside the window
 * and holds its last frame if it ends early (#230). The output keeps the main
 * input's audio and length (#188). */
export function buildOverlayArgs(
  input: string,
  overlay: string,
  output: string,
  opts: OverlayOptions,
  quality: Quality = DEFAULT_EDIT_QUALITY,
): string[] {
  const x = requireNonNegativeInt(opts.x, "overlay x");
  const y = requireNonNegativeInt(opts.y, "overlay y");
  const expr = enableExpr(opts.start, opts.end);
  const enable = expr ? `:enable='${expr}'` : "";
  const shift = `setpts=PTS-STARTPTS+${opts.start ?? 0}/TB`;
  let ovl = `[1:v]${shift}`;
  if (opts.scale && (opts.scale.width !== undefined || opts.scale.height !== undefined)) {
    if (opts.scale.width !== undefined) requirePositiveInt(opts.scale.width, "overlay scale width");
    if (opts.scale.height !== undefined) requirePositiveInt(opts.scale.height, "overlay scale height");
    const sw = opts.scale.width ?? -1;
    const sh = opts.scale.height ?? -1;
    ovl += `,scale=${sw}:${sh}`;
  }
  if (opts.shape === "circle") ovl += `,${CIRCLE_MASK}`;
  const filter = `${ovl}[ovl];[0:v][ovl]overlay=${x}:${y}${enable}[v]`;
  const dur = opts.durationSec;
  return [
    "-y", "-i", input, "-i", overlay,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "0:a?",
    ...resolveQuality(quality),
    "-c:a", "copy",
    // A longer overlay video would otherwise run the output past the main clip.
    ...(dur != null && dur > 0 ? ["-t", String(dur)] : []),
    output,
  ];
}

export type CompressLevel = "light" | "medium" | "heavy";

const COMPRESS_CRF: Record<CompressLevel, number> = {
  light: 23,
  medium: 28,
  heavy: 32,
};

/** Re-encode to a smaller file with a CRF ladder and an optional width cap.
 * The width cap only ever downscales (min of the source width and maxWidth). */
export function buildCompressArgs(
  input: string,
  output: string,
  opts: { level?: CompressLevel; maxWidth?: number } = {},
): string[] {
  const level = opts.level ?? "medium";
  const crf = COMPRESS_CRF[level];
  if (crf === undefined) throw new ScreencastError(`Unknown compress level "${level}".`);
  const args = ["-y", "-i", input];
  if (opts.maxWidth !== undefined) {
    requirePositiveInt(opts.maxWidth, "maxWidth");
    // Always even and never an upscale: libx264 rejects an odd width (#239).
    args.push("-vf", `scale='trunc(min(${opts.maxWidth},iw)/2)*2':-2`);
  }
  args.push(
    "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  );
  return args;
}

export type AudioFormat = "mp3" | "aac" | "wav" | "copy";

const AUDIO_CODEC: Record<AudioFormat, string[]> = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  aac: ["-c:a", "aac", "-b:a", "192k"],
  wav: ["-c:a", "pcm_s16le"],
  copy: ["-c:a", "copy"],
};

/** Strip video and write the audio track on its own (mp3 / aac / wav / copy). */
/** Container extension that can hold a stream-copied audio codec. m4a (the old
 * blanket choice) rejects opus/vorbis/etc at header-write time, leaving a
 * broken file; Matroska audio (.mka) is the catch-all that accepts nearly any
 * codec. Pure so the mapping is unit-tested. */
export function copyAudioExtension(codec: string | null): string {
  switch (codec) {
    case "aac":
    case "alac":
      return "m4a";
    case "mp3":
      return "mp3";
    case "opus":
    case "vorbis":
      return "ogg";
    case "flac":
      return "flac";
    default:
      if (codec && codec.startsWith("pcm_")) return "wav";
      return "mka";
  }
}

export function buildExtractAudioArgs(
  input: string,
  output: string,
  format: AudioFormat,
): string[] {
  const codec = AUDIO_CODEC[format];
  if (!codec) throw new ScreencastError(`Unknown audio format "${format}".`);
  return ["-y", "-i", input, "-vn", ...codec, output];
}

export interface Segment {
  start: number;
  end: number;
}

/** Extract one frame-accurate sub-segment. Unlike trim (stream copy, snaps to a
 * keyframe), clip re-encodes so the cut lands exactly on start/end. Output -ss
 * plus -t (a duration) avoids the -to seek ambiguity. */
export function buildClipArgs(
  input: string,
  output: string,
  seg: Segment,
  quality: Quality = DEFAULT_EDIT_QUALITY,
): string[] {
  if (!Number.isFinite(seg.start) || seg.start < 0) {
    throw new ScreencastError("clip start must be a non-negative number.");
  }
  if (!Number.isFinite(seg.end) || seg.end <= seg.start) {
    throw new ScreencastError("clip end must be greater than start.");
  }
  return [
    "-y", "-i", input,
    "-ss", String(seg.start),
    "-t", String(seg.end - seg.start),
    ...resolveQuality(quality),
    "-c:a", "aac",
    output,
  ];
}

// --- Phase 2 safety redaction ---------------------------------------------
//
// redact_region covers DECLARED rectangles. It is not automatic secret
// detection. The default style is a solid box: a filled rectangle is
// irreversible, where a blur or a mosaic can be partially recovered, so for an
// actual secret the solid box is the safe choice. Regions are bounds-checked
// against the real frame so an off-frame typo fails loudly instead of leaving
// the secret visible.

export type RedactStyle = "box" | "blur" | "pixelate";

export interface RedactRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  start?: number;
  end?: number;
}

interface NormalizedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  enable: string;
}

/** Validate each region against the frame, then apply an optional pad (dilation)
 * clamped to the frame edges. The unpadded region is what gets bounds-checked,
 * so a clearly off-frame request is rejected before any padding math. */
function normalizeRegions(
  regions: RedactRegion[],
  pad: number,
  dims?: { width: number | null; height: number | null },
): NormalizedRegion[] {
  return regions.map((r, i) => {
    const x0 = requireNonNegativeInt(r.x, `region[${i}] x`);
    const y0 = requireNonNegativeInt(r.y, `region[${i}] y`);
    const w0 = requirePositiveInt(r.width, `region[${i}] width`);
    const h0 = requirePositiveInt(r.height, `region[${i}] height`);
    if (dims && dims.width != null && dims.height != null) {
      if (x0 + w0 > dims.width || y0 + h0 > dims.height) {
        throw new ScreencastError(
          `region[${i}] ${w0}x${h0}+${x0}+${y0} falls outside the ` +
            `${dims.width}x${dims.height} frame.`,
        );
      }
    }
    const x = Math.max(0, x0 - pad);
    const y = Math.max(0, y0 - pad);
    let right = x0 + w0 + pad;
    let bottom = y0 + h0 + pad;
    if (dims && dims.width != null) right = Math.min(right, dims.width);
    if (dims && dims.height != null) bottom = Math.min(bottom, dims.height);
    return { x, y, w: right - x, h: bottom - y, enable: enableExpr(r.start, r.end) };
  });
}

/** Smallest blur radius in px, where the region allows it (#204). */
export const MIN_BLUR_RADIUS = 8;
/** Times the box blur is applied: three passes approach a Gaussian, so the
 * blur is several times stronger than its radius suggests. */
export const BLUR_PASSES = 3;
/** Smallest pixelate block in px: about two characters of UI text (#204). */
export const MIN_PIXEL_BLOCK = 16;

/** boxblur settings for a region: a radius of at least MIN_BLUR_RADIUS (a
 * thin text line used to get 4, which stayed readable), applied BLUR_PASSES
 * times. A radius must stay within half the plane's smaller side, and the
 * yuv420p chroma plane is half the size, so it gets its own radius (#188). */
export function blurRadius(r: { w: number; h: number }): string {
  const m = Math.min(r.w, r.h);
  const lr = Math.min(Math.floor(m / 2), Math.max(MIN_BLUR_RADIUS, Math.min(20, Math.floor(m / 4))));
  const cr = Math.min(lr, Math.floor(Math.ceil(m / 2) / 2));
  return `lr=${lr}:lp=${BLUR_PASSES}:cr=${cr}:cp=${BLUR_PASSES}`;
}

/** The pixelate filter for a region: square blocks of at least
 * MIN_PIXEL_BLOCK px (and at most 16 across the longer side), instead of 16
 * across whatever the width was, which left a 64 px secret in 4 px blocks. */
export function pixelateFilter(r: { w: number; h: number }): string {
  const block = Math.max(MIN_PIXEL_BLOCK, Math.ceil(Math.max(r.w, r.h) / 16));
  const cols = Math.max(1, Math.round(r.w / block));
  const rows = Math.max(1, Math.round(r.h / block));
  return `scale=${cols}:${rows}:flags=area,scale=${r.w}:${r.h}:flags=neighbor`;
}

export interface RedactOptions {
  style?: RedactStyle;
  pad?: number;
  color?: string;
}

/** Filter steps that redact regions of the stream labelled `input` (e.g.
 * "[0:v]"); labels are prefixed with `tag` so several can share one graph.
 * Returns the steps and the output label. Shared by redact_region and pipeline. */
export function redactSteps(
  regions: RedactRegion[],
  opts: RedactOptions,
  dims: { width: number | null; height: number | null } | undefined,
  input: string,
  tag: string,
): { steps: string[]; out: string } {
  if (regions.length === 0) {
    throw new ScreencastError("redact_region requires at least one region.");
  }
  const style = opts.style ?? "box";
  const pad = opts.pad ?? 0;
  if (!Number.isInteger(pad) || pad < 0) {
    throw new ScreencastError("pad must be a non-negative integer.");
  }
  const color = validateColor(opts.color ?? "black", "color");
  const rs = normalizeRegions(regions, pad, dims);

  if (style === "box") {
    const boxes = rs
      .map((r) => {
        const en = r.enable ? `:enable='${r.enable}'` : "";
        return `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=${color}:t=fill${en}`;
      })
      .join(",");
    return { steps: [`${input}${boxes}[${tag}out]`], out: `[${tag}out]` };
  }

  // blur / pixelate: split the source, soften each cropped region, then overlay
  // the softened patches back over the base in order.
  const n = rs.length;
  const steps: string[] = [];
  const splitOuts = [`${tag}base`, ...rs.map((_, i) => `${tag}s${i}`)];
  steps.push(`${input}split=${n + 1}[${splitOuts.join("][")}]`);
  rs.forEach((r, i) => {
    const crop = `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
    const soften =
      style === "blur"
        ? `boxblur=${blurRadius(r)}`
        : pixelateFilter(r);
    steps.push(`[${tag}s${i}]${crop},${soften}[${tag}b${i}]`);
  });
  let prev = `${tag}base`;
  rs.forEach((r, i) => {
    const en = r.enable ? `:enable='${r.enable}'` : "";
    const out = i === n - 1 ? `${tag}out` : `${tag}c${i}`;
    steps.push(`[${prev}][${tag}b${i}]overlay=${r.x}:${r.y}${en}[${out}]`);
    prev = `${tag}c${i}`;
  });
  return { steps, out: `[${tag}out]` };
}

/** Redact declared rectangles. `box` (default) draws an irreversible solid fill;
 * `blur` and `pixelate` composite a softened crop back over each region. */
export function buildRedactArgs(
  input: string,
  output: string,
  regions: RedactRegion[],
  opts: RedactOptions = {},
  dims?: { width: number | null; height: number | null },
): string[] {
  const { steps, out } = redactSteps(regions, opts, dims, "[0:v]", "");
  // A crisp re-encode keeps the redaction edges sharp.
  const [chain] = steps;
  if ((opts.style ?? "box") === "box" && chain !== undefined) {
    // One linear chain: a plain -vf, without the graph labels.
    const vf = chain.slice("[0:v]".length, -out.length);
    return ["-y", "-i", input, "-vf", vf, ...resolveQuality("high"), "-c:a", "copy", output];
  }
  return [
    "-y", "-i", input,
    "-filter_complex", steps.join(";"),
    "-map", out, "-map", "0:a?",
    ...resolveQuality("high"),
    "-c:a", "copy",
    output,
  ];
}
