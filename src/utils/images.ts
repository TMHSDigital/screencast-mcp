/**
 * Inline image results (#79).
 *
 * Tools that produce frames can return them as MCP `image` content blocks so a
 * client shows them to the model directly, with no filesystem tool needed.
 * Payloads stay bounded: every frame is downscaled to a max width and
 * re-encoded as JPEG, and only the first N frames are embedded.
 */
import { readFileSync, rmSync } from "node:fs";
import { ScreencastError, type ImageContent } from "./errors.js";
import { runFfmpeg } from "./ffmpeg.js";
import { tempPath } from "./paths.js";

/** Default downscale width for inline previews. */
export const DEFAULT_MAX_IMAGE_WIDTH = 1280;
/** Default number of frames embedded in one tool result. */
export const DEFAULT_MAX_INLINE_IMAGES = 8;
/** Hard ceiling on embedded frames, whatever the caller asks for. */
export const MAX_INLINE_IMAGES = 20;

/** Build args that turn one image or video frame into a downscaled JPEG
 * preview. The width cap only ever downscales (min of the source width and
 * maxWidth); -2 keeps the aspect ratio. */
export function buildPreviewArgs(input: string, output: string, maxWidth: number): string[] {
  if (!Number.isInteger(maxWidth) || maxWidth < 16) {
    throw new ScreencastError("maxImageWidth must be an integer of at least 16.");
  }
  return [
    "-y", "-v", "error", "-i", input,
    "-frames:v", "1",
    "-vf", `scale='min(${maxWidth},iw)':-2`,
    "-q:v", "4",
    output,
  ];
}

/** Clamp a caller-supplied inline-image count to [0, MAX_INLINE_IMAGES]. */
export function clampInlineCount(requested: number | undefined): number {
  const n = requested ?? DEFAULT_MAX_INLINE_IMAGES;
  return Math.max(0, Math.min(MAX_INLINE_IMAGES, Math.floor(n)));
}

export interface InlineImages {
  images: ImageContent[];
  /** Frames that were not embedded because of the count cap. */
  omitted: number;
}

/** Encode up to `maxCount` image files as downscaled JPEG image blocks. */
export async function encodeInlineImages(
  paths: string[],
  maxWidth: number = DEFAULT_MAX_IMAGE_WIDTH,
  maxCount: number = DEFAULT_MAX_INLINE_IMAGES,
): Promise<InlineImages> {
  const chosen = paths.slice(0, maxCount);
  const images: ImageContent[] = [];
  for (const path of chosen) {
    const tmp = tempPath(".jpg");
    try {
      await runFfmpeg(buildPreviewArgs(path, tmp, maxWidth), 30_000);
      images.push({ type: "image", data: readFileSync(tmp).toString("base64"), mimeType: "image/jpeg" });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return { images, omitted: paths.length - chosen.length };
}
