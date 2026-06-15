/**
 * ffprobe parsing and the Phase 1 edit/watch argument builders.
 *
 * All functions here are pure (string in, args/strings out) so the edit and
 * watch surfaces are unit-tested without ffmpeg present.
 */
import { ScreencastError } from "./errors.js";

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
