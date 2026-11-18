/**
 * The shared encode settings for every edit builder (#312, #360): the
 * libx264 quality presets, the house AAC bitrate, faststart, and encodeTail,
 * which strings them together. Hardware encoders are in gpu.ts. Pure.
 */
import { ScreencastError } from "./errors.js";

export type Quality = "draft" | "standard" | "high";

export const QUALITY_PRESETS: Record<Quality, { preset: string; crf: number }> =
  {
    draft: { preset: "ultrafast", crf: 28 },
    standard: { preset: "veryfast", crf: 23 },
    high: { preset: "medium", crf: 18 },
  };

/** Encoder args for a quality preset (libx264, web-safe pixel format). */
export function resolveQuality(quality: Quality): string[] {
  const q = QUALITY_PRESETS[quality];
  if (!q) throw new ScreencastError(`Unknown quality preset "${quality}".`);
  return ["-c:v", "libx264", "-preset", q.preset, "-crf", String(q.crf),
    "-pix_fmt", "yuv420p"];
}

/** House AAC bitrate for re-encoded audio (#312). */
export const AAC_BITRATE = "160k";

/** AAC audio at `bitrate`; null leaves the bitrate to ffmpeg's default. */
export function aacArgs(bitrate: string | null = AAC_BITRATE): string[] {
  return ["-c:a", "aac", ...(bitrate ? ["-b:a", bitrate] : [])];
}

/** Moves the MP4 index to the front so the file plays while it downloads. */
export const FASTSTART: readonly string[] = ["-movflags", "+faststart"];

/** The encode tail shared by the edit builders (#312): video from a quality
 * preset (or explicit codec args), then audio, then optionally faststart.
 * Audio "aac" re-encodes (bitrate as for aacArgs), "copy" stream-copies,
 * "none" drops it (-an), and "omit" adds nothing. Pure. */
export function encodeTail(opts: {
  quality?: Quality;
  video?: readonly string[];
  audio: "aac" | "copy" | "none" | "omit";
  bitrate?: string | null;
  faststart?: boolean;
}): string[] {
  const audio = {
    aac: () => aacArgs(opts.bitrate),
    copy: () => ["-c:a", "copy"],
    none: () => ["-an"],
    omit: () => [],
  }[opts.audio]();
  return [
    ...(opts.video ?? resolveQuality(opts.quality ?? "standard")),
    ...audio,
    ...(opts.faststart ? FASTSTART : []),
  ];
}
