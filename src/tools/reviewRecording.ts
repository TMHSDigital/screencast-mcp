import { z } from "zod";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia, runFfmpegBuffer } from "../utils/ffmpeg.js";
import { jobTimeoutMs } from "../utils/jobs.js";
import { tempPath } from "../utils/paths.js";
import {
  buildPlayerFramesArgs,
  clientSupportsApps,
  parsePlayerFrameLog,
  pickPlayerFrames,
  playerFramePlan,
  splitJpegs,
  type PlayerFrame,
  DEFAULT_PLAYER_FRAMES,
  DEFAULT_PLAYER_WIDTH,
  MAX_PLAYER_FRAMES,
  MCP_APP_MIME,
  PLAYER_TOOL_META,
  PLAYER_URI,
} from "../utils/player.js";
import { getStore } from "../context.js";

const uiAsset = (name: string) => readFileSync(fileURLToPath(new URL(`../../assets/ui/${name}`, import.meta.url)), "utf8");

/** The player page, shipped in assets/ui (dist/tools -> ../../assets), with
 * player.js inlined in place of its script tag: the host loads the resource
 * as one document and its CSP allows no other fetch (#243). */
export function playerHtml(): string {
  const js = uiAsset("player.js");
  if (/<\/script/i.test(js)) throw new ScreencastError("player.js must not contain a closing script tag.");
  return uiAsset("player.html").replace('<script src="player.js"></script>', () => `<script>\n${js}</script>`);
}

function resolveInput(args: { input?: string; sessionId?: string }): string {
  if (args.sessionId) {
    const record = getStore().get(args.sessionId);
    if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
    if (record.status === "recording") throw new ScreencastError("The recording is still running; stop it first.");
    return record.outputPath;
  }
  if (args.input) return args.input;
  throw new ScreencastError("Pass input or sessionId.");
}

export function register(server: McpServer): void {
  // The player page itself, for hosts that support MCP Apps.
  server.registerResource(
    "review-player",
    PLAYER_URI,
    {
      title: "Recording review player",
      description: "Interactive player: scrub, trim, and draw redaction boxes on a recording.",
      mimeType: MCP_APP_MIME,
    },
    async () => ({
      contents: [{ uri: PLAYER_URI, mimeType: MCP_APP_MIME, text: playerHtml(), _meta: { ui: { prefersBorder: true } } }],
    }),
  );

  server.registerTool(
    "review_recording",
    {
      title: "Review Recording",
      description:
        "Open a recording for a person to review: in MCP Apps clients an inline player to scrub, trim, " +
        "and redact, then export; elsewhere just the video's details.",
      inputSchema: {
        input: z.string().optional().describe("Path to the video."),
        sessionId: z.string().optional().describe("Or the session id of a stopped recording."),
      },
      outputSchema: looseOutput({
        input: z.string(),
        durationSec: z.number().nullable(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        fps: z.number().nullable(),
        hasAudio: z.boolean(),
      }),
      annotations: READ_ONLY,
      _meta: PLAYER_TOOL_META,
    },
    async (args) => {
      try {
        requireFfmpeg();
        const input = resolveInput(args);
        if (!existsSync(input)) throw new ScreencastError(`Input file not found: ${input}`);
        const info = await probeMedia(input);
        return okResponse({
          input,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
          fps: info.fps,
          hasAudio: info.audioCodec !== null,
          note:
            "Clients with MCP Apps show an inline review player for this result. Without it, " +
            "look with contact_sheet or sample_frames, then trim and redact with pipeline.",
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // Called by the player (app visibility only), not by the model. Hosts
  // without MCP Apps ignore that visibility, so the tool is listed only for
  // clients that advertise Apps support (#242).
  const playerFrames = server.registerTool(
    "player_frames",
    {
      title: "Player Frames",
      description:
        "Preview frames for the review player: JPEGs on an even grid over the video plus frames at " +
        "scene changes, with their real times. Used by the inline player; agents should use " +
        "sample_frames or contact_sheet instead.",
      inputSchema: {
        input: z.string().min(1).describe("Path to the video."),
        maxFrames: z.number().int().min(1).max(MAX_PLAYER_FRAMES).optional().describe(`Frames on the even grid (default ${DEFAULT_PLAYER_FRAMES}); scene-change frames come on top, up to as many again.`),
        width: z.number().int().min(64).max(1280).optional().describe(`Frame width (default ${DEFAULT_PLAYER_WIDTH}).`),
      },
      annotations: READ_ONLY,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const info = await probeMedia(args.input);
        const durationSec = info.durationSec ?? 0;
        const plan = playerFramePlan(durationSec, args.maxFrames ?? DEFAULT_PLAYER_FRAMES);
        // Each frame's real time and kind come back through a log file (#232).
        const log = tempPath(".txt");
        let jpegs: Buffer[];
        let frames: PlayerFrame[];
        try {
          const raw = await runFfmpegBuffer(
            buildPlayerFramesArgs(args.input, plan, args.width ?? DEFAULT_PLAYER_WIDTH, log),
            jobTimeoutMs(durationSec),
            { signal: extra.signal },
          );
          jpegs = splitJpegs(raw);
          frames = parsePlayerFrameLog(existsSync(log) ? readFileSync(log, "utf8") : "").slice(0, jpegs.length);
        } finally {
          rmSync(log, { force: true });
        }
        if (frames.length === 0) throw new ScreencastError("ffmpeg returned no preview frames.");
        // Scene-change frames on top of the grid: at most as many again.
        const keep = pickPlayerFrames(frames, plan.count);
        const t0 = frames[0].timeSec;
        const frameTimes = keep.map((i) => Math.round((frames[i].timeSec - t0) * 1000) / 1000);
        const sceneFrames = keep.flatMap((i, k) => (frames[i].scene ? [k] : []));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                input: args.input,
                durationSec,
                width: info.width,
                height: info.height,
                hasAudio: info.audioCodec !== null,
                frameTimes,
                intervalSec: plan.intervalSec,
                sceneFrames,
              }),
            },
            ...keep.map((i) => ({ type: "image" as const, data: jpegs[i].toString("base64"), mimeType: "image/jpeg" })),
          ],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
  playerFrames.disable();
  const previous = server.server.oninitialized;
  server.server.oninitialized = () => {
    previous?.();
    if (clientSupportsApps(server.server.getClientCapabilities())) playerFrames.enable();
  };
}
