import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { buildSpeedArgs } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  factor: z.number().positive().describe("Speed multiplier: >1 is faster, <1 is slower (e.g. 2 = double speed)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "speed",
    "Change playback speed by a factor (>1 faster, <1 slower) and re-encode. " +
      "Audio is retempo'd to match when the source has an audio track.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const { audioCodec } = await probeMedia(args.input);
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `speed-${stamp()}-${rand()}${ext}`,
        );
        const ffArgs = buildSpeedArgs(args.input, output, args.factor, audioCodec !== null);
        await runFfmpeg(ffArgs, 10 * 60_000);
        return okResponse({ outputPath: output, factor: args.factor, audio: audioCodec !== null });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
