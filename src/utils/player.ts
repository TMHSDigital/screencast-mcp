/**
 * The review player (#128): an MCP Apps view (a sandboxed HTML page the host
 * shows inline) where a person scrubs a recording, sets trim handles, and
 * draws redaction boxes; their choices come back as a pipeline call.
 *
 * The page gets the video as JPEG frames (data: images work under the strict
 * CSP hosts apply to apps, unlike a local file or HTTP server, and keep
 * "output stays local"). These helpers plan, label, and split those frames. Pure.
 */
import { ScreencastError } from "./errors.js";
import { escapeFilterPath } from "./fonts.js";

/** The MCP Apps resource the player is served as, and its MIME type. */
export const PLAYER_URI = "ui://screencast/player";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Tool _meta that tells an Apps host to render the player for a tool's
 * result. Both the current and the legacy key, as the spec asks hosts to read. */
export const PLAYER_TOOL_META = { ui: { resourceUri: PLAYER_URI }, "ui/resourceUri": PLAYER_URI } as const;

/** The capability key under which a client advertises MCP Apps support. */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

/** True when a client's initialize capabilities advertise MCP Apps (under
 * `extensions`, or `experimental` in older hosts) with the HTML app MIME type
 * or no MIME list at all. */
export function clientSupportsApps(caps: unknown): boolean {
  const c = caps as { extensions?: Record<string, unknown>; experimental?: Record<string, unknown> } | undefined;
  const ext = (c?.extensions?.[MCP_APPS_EXTENSION] ?? c?.experimental?.[MCP_APPS_EXTENSION]) as
    | { mimeTypes?: unknown }
    | undefined;
  if (!ext || typeof ext !== "object") return false;
  return !Array.isArray(ext.mimeTypes) || ext.mimeTypes.includes(MCP_APP_MIME);
}

export const DEFAULT_PLAYER_FRAMES = 120;
export const MAX_PLAYER_FRAMES = 300;
export const PLAYER_FPS = 4;
export const DEFAULT_PLAYER_WIDTH = 640;
/** Scene score that adds a frame between grid frames (#232). Far below the
 * sampler's 0.1: a dialog or a pasted token covers a small share of the screen,
 * and a static screen scores ~0, so this mostly catches real changes. */
export const PLAYER_SCENE_THRESHOLD = 0.01;

export interface PlayerFramePlan {
  /** Frames on the even grid, one per interval. */
  count: number;
  intervalSec: number;
  /** Least time between two scene-change frames, so continuous motion (a
   * scroll, a video playing) cannot flood the set. */
  sceneGapSec: number;
}

/** The even grid that covers `durationSec`: up to PLAYER_FPS frames per
 * second, at most `maxFrames`. Scene-change frames come on top (#232). */
export function playerFramePlan(durationSec: number, maxFrames = DEFAULT_PLAYER_FRAMES): PlayerFramePlan {
  if (!(durationSec > 0)) throw new ScreencastError("The video has no duration to review.");
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(durationSec * PLAYER_FPS)));
  const intervalSec = Number((durationSec / count).toFixed(6));
  return { count, intervalSec, sceneGapSec: Number(Math.max(0.25, intervalSec / 4).toFixed(6)) };
}

/** Decode `input` to JPEG frames on stdout, `width` wide: the first frame of
 * each grid interval, plus (in a second branch, so the grid never delays one)
 * frames whose scene score passes `threshold`, at least sceneGapSec apart.
 * Each frame's real pts and kind go to `logFile` via metadata=print (#232):
 * labels come from the frames themselves, not from arithmetic. */
export function buildPlayerFramesArgs(
  input: string,
  plan: PlayerFramePlan,
  width: number,
  logFile: string,
  threshold = PLAYER_SCENE_THRESHOLD,
): string[] {
  const i = plan.intervalSec;
  const grid = `isnan(prev_t)+gt(floor((t-start_t)/${i})\\,floor((prev_t-start_t)/${i}))`;
  const scene = `gt(scene\\,${threshold})*not(${grid})*(isnan(prev_selected_t)+gte(t-prev_selected_t\\,${plan.sceneGapSec}))`;
  return [
    "-v", "error", "-i", input, "-an",
    "-vf",
    `scale='min(${width},iw)':-2,split[g][s];` +
      `[g]select='${grid}',metadata=add:key=kind:value=grid[g1];` +
      `[s]select='${scene}',metadata=add:key=kind:value=scene[s1];` +
      `[g1][s1]interleave,metadata=print:file=${escapeFilterPath(logFile)}`,
    "-fps_mode", "passthrough",
    "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "-",
  ];
}

export interface PlayerFrame {
  timeSec: number;
  scene: boolean;
  /** The scene score of a scene-change frame (0 for grid frames). */
  score: number;
}

/** Parse the metadata=print log of buildPlayerFramesArgs, one entry per
 * frame written, in output order. Pure. */
export function parsePlayerFrameLog(text: string): PlayerFrame[] {
  const out: PlayerFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.match(/pts_time:\s*(-?[\d.]+)/);
    if (t) {
      out.push({ timeSec: Number(t[1]), scene: false, score: 0 });
      continue;
    }
    const last = out.at(-1);
    if (!last) continue;
    if (line === "kind=scene") last.scene = true;
    const s = line.match(/^lavfi\.scene_score=([\d.]+)/);
    if (s) last.score = Number(s[1]);
  }
  return out;
}

/** Which frames to keep: every grid frame, plus the `maxScene` strongest
 * scene-change frames. Returns indexes in time order. Pure. */
export function pickPlayerFrames(frames: PlayerFrame[], maxScene: number): number[] {
  const scene = frames
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f.scene)
    .sort((a, b) => b.f.score - a.f.score)
    .slice(0, Math.max(0, maxScene));
  const keep = new Set(scene.map((x) => x.i));
  return frames.map((_, i) => i).filter((i) => !frames[i].scene || keep.has(i));
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
