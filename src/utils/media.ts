/**
 * ffprobe parsing and the Phase 1 edit/watch argument builders.
 *
 * All functions here are pure (string in, args/strings out) so the edit and
 * watch surfaces are unit-tested without ffmpeg present.
 */
import { ScreencastError } from "./errors.js";
import { resolveQuality, type Quality } from "./targets.js";

/** Edit re-encodes default to the same preset as a standard capture. */
const DEFAULT_EDIT_QUALITY: Quality = "standard";

export interface MediaInfo {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  format: string | null;
  sizeBytes: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
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

/** Reduce a parsed ffprobe JSON document to a flat MediaInfo. */
export function parseMediaInfo(probe: FfprobeJson): MediaInfo {
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = probe.format?.duration;
  const size = probe.format?.size;
  return {
    durationSec: duration !== undefined ? Number(duration) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    format: probe.format?.format_name ?? null,
    sizeBytes: size !== undefined ? Number(size) : null,
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

/** Sample frames at a fixed rate: ffmpeg -i in -vf fps=N outdir/frame_%05d.png */
export function buildSampleByFpsArgs(
  input: string,
  fps: number,
  outputPattern: string,
): string[] {
  validatePositive(fps, "fps");
  return ["-y", "-i", input, "-vf", `fps=${fps}`, outputPattern];
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
  return ["-y", "-ss", String(timestampSec), "-i", input, "-frames:v", "1", output];
}

/** Trim by start + (end | duration). Stream-copy for speed. */
export function buildTrimArgs(
  input: string,
  output: string,
  opts: { start: number; end?: number; duration?: number },
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
    args.push("-to", String(opts.end));
  } else {
    args.push("-t", String(validatePositive(opts.duration!, "duration")));
  }
  args.push("-c", "copy", output);
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
        `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];` +
        `[s0]palettegen[p];[s1][p]paletteuse`;
      return ["-y", "-i", input, "-vf", filter, output];
    }
    case "webm":
      return [
        "-y", "-i", input,
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30",
        "-row-mt", "1",
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
export function buildCropArgs(
  input: string,
  output: string,
  rect: CropRect,
  dims?: { width: number | null; height: number | null },
  quality: Quality = DEFAULT_EDIT_QUALITY,
): string[] {
  const x = requireNonNegativeInt(rect.x, "crop x");
  const y = requireNonNegativeInt(rect.y, "crop y");
  const w = requirePositiveInt(rect.width, "crop width");
  const h = requirePositiveInt(rect.height, "crop height");
  if (dims && dims.width != null && dims.height != null) {
    if (x + w > dims.width || y + h > dims.height) {
      throw new ScreencastError(
        `crop region ${w}x${h}+${x}+${y} falls outside the ` +
          `${dims.width}x${dims.height} frame.`,
      );
    }
  }
  return [
    "-y", "-i", input,
    "-vf", `crop=${w}:${h}:${x}:${y}`,
    ...resolveQuality(quality),
    "-c:a", "copy",
    output,
  ];
}

/** Scale to a width and/or height. A missing side uses -2 (keep aspect, even
 * dimension as required by yuv420p). */
export function buildScaleArgs(
  input: string,
  output: string,
  opts: { width?: number; height?: number },
  quality: Quality = DEFAULT_EDIT_QUALITY,
): string[] {
  if (opts.width === undefined && opts.height === undefined) {
    throw new ScreencastError("scale requires width or height (or both).");
  }
  if (opts.width !== undefined) requirePositiveInt(opts.width, "scale width");
  if (opts.height !== undefined) requirePositiveInt(opts.height, "scale height");
  const w = opts.width ?? -2;
  const h = opts.height ?? -2;
  return [
    "-y", "-i", input,
    "-vf", `scale=${w}:${h}`,
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
  parts.push(`atempo=${Math.round(remaining * 1000) / 1000}`);
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
}

/** Composite an overlay image or video onto the input at (x, y), optionally
 * scaled and optionally limited to a time window. */
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
  let filter: string;
  if (opts.scale && (opts.scale.width !== undefined || opts.scale.height !== undefined)) {
    if (opts.scale.width !== undefined) requirePositiveInt(opts.scale.width, "overlay scale width");
    if (opts.scale.height !== undefined) requirePositiveInt(opts.scale.height, "overlay scale height");
    const sw = opts.scale.width ?? -1;
    const sh = opts.scale.height ?? -1;
    filter = `[1:v]scale=${sw}:${sh}[ovl];[0:v][ovl]overlay=${x}:${y}${enable}`;
  } else {
    filter = `[0:v][1:v]overlay=${x}:${y}${enable}`;
  }
  return [
    "-y", "-i", input, "-i", overlay,
    "-filter_complex", filter,
    ...resolveQuality(quality),
    "-c:a", "copy",
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
    args.push("-vf", `scale='min(${opts.maxWidth},iw)':-2`);
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

/** boxblur radius scaled to the region so small boxes do not exceed the limit
 * (the radius must stay under half the smaller side). */
function blurRadius(r: NormalizedRegion): number {
  return Math.max(2, Math.min(20, Math.floor(Math.min(r.w, r.h) / 4)));
}

export interface RedactOptions {
  style?: RedactStyle;
  pad?: number;
  color?: string;
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
  if (regions.length === 0) {
    throw new ScreencastError("redact_region requires at least one region.");
  }
  const style = opts.style ?? "box";
  const pad = opts.pad ?? 0;
  if (!Number.isInteger(pad) || pad < 0) {
    throw new ScreencastError("pad must be a non-negative integer.");
  }
  const color = opts.color ?? "black";
  const rs = normalizeRegions(regions, pad, dims);

  // A crisp re-encode keeps the redaction edges sharp.
  const encode = resolveQuality("high");

  if (style === "box") {
    const boxes = rs
      .map((r) => {
        const en = r.enable ? `:enable='${r.enable}'` : "";
        return `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=${color}:t=fill${en}`;
      })
      .join(",");
    return ["-y", "-i", input, "-vf", boxes, ...encode, "-c:a", "copy", output];
  }

  // blur / pixelate: split the source, soften each cropped region, then overlay
  // the softened patches back over the base in order.
  const n = rs.length;
  const parts: string[] = [];
  const splitOuts = ["base", ...rs.map((_, i) => `s${i}`)];
  parts.push(`[0:v]split=${n + 1}[${splitOuts.join("][")}]`);
  rs.forEach((r, i) => {
    const crop = `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
    const soften =
      style === "blur"
        ? `boxblur=${blurRadius(r)}`
        : `scale='max(1,iw/16)':'max(1,ih/16)':flags=neighbor,scale=${r.w}:${r.h}:flags=neighbor`;
    parts.push(`[s${i}]${crop},${soften}[b${i}]`);
  });
  let prev = "base";
  rs.forEach((r, i) => {
    const en = r.enable ? `:enable='${r.enable}'` : "";
    const out = i === n - 1 ? "out" : `c${i}`;
    parts.push(`[${prev}][b${i}]overlay=${r.x}:${r.y}${en}[${out}]`);
    prev = `c${i}`;
  });
  return [
    "-y", "-i", input,
    "-filter_complex", parts.join(";"),
    "-map", "[out]", "-map", "0:a?",
    ...encode,
    "-c:a", "copy",
    output,
  ];
}
