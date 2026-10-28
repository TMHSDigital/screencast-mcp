import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildConvertArgs, type ConvertFormat } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source media."),
  format: z
    .enum(["mp4", "gif", "webm"])
    .describe("mp4 (H.264), webm (VP9), or gif (palette)."),
  fps: z.number().positive().optional().describe("gif only: fps (default 12)."),
  width: z.number().positive().optional().describe("gif only: width in px (default 720)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "convert",
    {
      title: "Convert Format",
      description:
        "Convert media to mp4, webm, or gif. For a size-bounded GIF/WebP prefer export_gif; for a " +
        "smaller mp4, compress or export_preset.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const format = args.format as ConvertFormat;
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `convert-${stamp()}-${rand()}.${format}`,
          args.overwrite,
        );
        const ffArgs = buildConvertArgs(args.input, output, format, {
          fps: args.fps,
          width: args.width,
        });
        await runEditJob(ffArgs, { output, durationSec: await probeDuration(args.input), extra });
        return okResponse({ outputPath: output, format });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
