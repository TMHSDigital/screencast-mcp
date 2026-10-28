import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildSpeedArgs, editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  factor: z.number().positive().describe("Speed multiplier: >1 is faster, <1 is slower (e.g. 2 = double speed)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "speed",
    "Change playback speed by a factor (>1 faster, <1 slower) and re-encode. " +
      "Audio is retempo'd to match when the source has an audio track.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const { audioCodec, durationSec } = await probeMedia(args.input);
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `speed-${stamp()}-${rand()}${ext}`,
          args.overwrite,
        );
        const ffArgs = buildSpeedArgs(args.input, output, args.factor, audioCodec !== null);
        // Progress follows the output; the timeout follows the input ffmpeg decodes (#237).
        await runEditJob(ffArgs, {
          output,
          durationSec: durationSec !== null ? durationSec / args.factor : null,
          inputDurationSec: durationSec,
          extra,
        });
        return okResponse({ outputPath: output, factor: args.factor, audio: audioCodec !== null });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
