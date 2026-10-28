import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, probeMedia, runFfmpegBuffer } from "../utils/ffmpeg.js";
import { jobTimeoutMs } from "../utils/jobs.js";
import {
  buildPlayerFramesArgs,
  clientSupportsApps,
  playerFramePlan,
  playerFrameTimes,
  splitJpegs,
  DEFAULT_PLAYER_FRAMES,
  DEFAULT_PLAYER_WIDTH,
  MAX_PLAYER_FRAMES,
  MCP_APP_MIME,
  PLAYER_TOOL_META,
  PLAYER_URI,
} from "../utils/player.js";
import { getStore } from "../context.js";

/** The player page, shipped in assets/ui (dist/tools -> ../../assets). */
export function playerHtml(): string {
  return readFileSync(fileURLToPath(new URL("../../assets/ui/player.html", import.meta.url)), "utf8");
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
      description:
        "Open a recording for a person to review. In clients that support MCP Apps it shows an " +
        "inline player: scrub the timeline, drag trim handles, and draw redaction boxes, then export " +
        "a trimmed, redacted copy (their choices run as a pipeline call). Elsewhere it returns the " +
        "video's details; use contact_sheet or sample_frames to look at it.",
      inputSchema: {
        input: z.string().optional().describe("Path to the video."),
        sessionId: z.string().optional().describe("Or the session id of a stopped recording."),
      },
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
      description:
        "Preview frames for the review player: JPEGs spread evenly over the video, with their times. " +
        "Used by the inline player; agents should use sample_frames or contact_sheet instead.",
      inputSchema: {
        input: z.string().min(1).describe("Path to the video."),
        maxFrames: z.number().int().min(1).max(MAX_PLAYER_FRAMES).optional().describe(`Most frames (default ${DEFAULT_PLAYER_FRAMES}).`),
        width: z.number().int().min(64).max(1280).optional().describe(`Frame width (default ${DEFAULT_PLAYER_WIDTH}).`),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const info = await probeMedia(args.input);
        const durationSec = info.durationSec ?? 0;
        const { count, fps } = playerFramePlan(durationSec, args.maxFrames ?? DEFAULT_PLAYER_FRAMES);
        const raw = await runFfmpegBuffer(
          buildPlayerFramesArgs(args.input, fps, args.width ?? DEFAULT_PLAYER_WIDTH, count),
          jobTimeoutMs(durationSec),
          { signal: extra.signal },
        );
        const jpegs = splitJpegs(raw);
        const times = playerFrameTimes(durationSec, jpegs.length);
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
                frameTimes: times,
              }),
            },
            ...jpegs.map((j) => ({ type: "image" as const, data: j.toString("base64"), mimeType: "image/jpeg" })),
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
