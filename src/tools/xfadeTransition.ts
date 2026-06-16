import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { buildXfadeArgs, DEFAULT_TRANSITION_DUR } from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  inputA: z.string().min(1).describe("Path to the first (outgoing) video."),
  inputB: z.string().min(1).describe("Path to the second (incoming) video."),
  transition: z
    .string()
    .optional()
    .describe("xfade transition name (default fade): fade, wipeleft, slideup, circleopen, dissolve, ..."),
  duration: z
    .number()
    .positive()
    .optional()
    .describe(`Transition length in seconds (default ${DEFAULT_TRANSITION_DUR}).`),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "xfade_transition",
    "Crossfade two videos into one with an xfade transition. Both clips are " +
      "auto-normalized to a common resolution, fps, and audio rate first, so " +
      "they need not match. Audio is crossfaded when both clips have a track.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        for (const f of [args.inputA, args.inputB]) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const [a, b] = await Promise.all([probeMedia(args.inputA), probeMedia(args.inputB)]);
        if (a.durationSec === null) {
          throw new ScreencastError(`Could not read duration of ${args.inputA}.`);
        }
        const hasAudio = a.audioCodec !== null && b.audioCodec !== null;
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `xfade-${stamp()}-${rand()}.mp4`,
        );
        const ffArgs = buildXfadeArgs(
          args.inputA,
          args.inputB,
          a.durationSec,
          output,
          { transition: args.transition, duration: args.duration },
          hasAudio,
        );
        await runFfmpeg(ffArgs, 15 * 60_000);
        return okResponse({ outputPath: output, audio: hasAudio });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
