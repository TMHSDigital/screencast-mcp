import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildSpeedArgs, editOutputExt } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  factor: z.number().positive().describe("Speed multiplier: >1 is faster, <1 is slower (e.g. 2 = double speed)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "speed",
    {
      title: "Change Speed",
      description:
        "Change playback speed by a factor (>1 faster, <1 slower) and re-encode. " +
        "Audio is retempo'd to match when the source has an audio track.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        requireInput(args.input);
        const { audioCodec, durationSec } = await probeMedia(args.input);
        const ext = editOutputExt(args.input);
        const output = editOutput(args.output, "speed", ext, { overwrite: args.overwrite });
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
