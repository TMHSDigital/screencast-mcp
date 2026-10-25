/**
 * The review player (#128): an MCP Apps view (a sandboxed HTML page the host
 * shows inline) where a person scrubs a recording, sets trim handles, and
 * draws redaction boxes; their choices come back as a pipeline call.
 *
 * The page gets the video as JPEG frames (data: images work under the strict
 * CSP hosts apply to apps, unlike a local file or HTTP server, and keep
 * "output stays local"). These helpers plan and split those frames. Pure.
 */
import { ScreencastError } from "./errors.js";

/** The MCP Apps resource the player is served as, and its MIME type. */
export const PLAYER_URI = "ui://screencast/player";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Tool _meta that tells an Apps host to render the player for a tool's
 * result. Both the current and the legacy key, as the spec asks hosts to read. */
export const PLAYER_TOOL_META = { ui: { resourceUri: PLAYER_URI }, "ui/resourceUri": PLAYER_URI } as const;

export const DEFAULT_PLAYER_FRAMES = 120;
export const MAX_PLAYER_FRAMES = 300;
export const PLAYER_FPS = 4;
export const DEFAULT_PLAYER_WIDTH = 640;

/** How many preview frames, and at what rate, to cover `durationSec`: up to
 * PLAYER_FPS per second, at most `maxFrames`, spread evenly. */
export function playerFramePlan(durationSec: number, maxFrames = DEFAULT_PLAYER_FRAMES): { count: number; fps: number } {
  if (!(durationSec > 0)) throw new ScreencastError("The video has no duration to review.");
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(durationSec * PLAYER_FPS)));
  return { count, fps: count / durationSec };
}

/** Each frame's time: the middle of its slice of the video. */
export function playerFrameTimes(durationSec: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * durationSec * 1000) / count) / 1000);
}

/** Decode `input` to JPEG frames on stdout at `fps`, `width` wide. */
export function buildPlayerFramesArgs(input: string, fps: number, width: number, count: number): string[] {
  return [
    "-v", "error", "-i", input, "-an",
    "-vf", `fps=${Number(fps.toFixed(6))},scale='min(${width},iw)':-2`,
    "-frames:v", String(count),
    "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "-",
  ];
}

/** Split concatenated JPEGs (ffmpeg's mjpeg image2pipe) at their start/end
 * markers. In entropy-coded data 0xFF is always followed by 0x00 or a restart
 * marker, so 0xFFD9 only ever ends an image. */
export function splitJpegs(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    const m = buf[i + 1];
    if (m === 0xd8 && start < 0) start = i;
    else if (m === 0xd9 && start >= 0) {
      out.push(buf.subarray(start, i + 2));
      start = -1;
      i++;
    }
  }
  return out;
}
