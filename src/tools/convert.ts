import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildConvertArgs, type ConvertFormat } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source media."),
  format: z
    .enum(["mp4", "gif", "webm"])
    .describe("Target format. Converts mp4 <-> gif/webm (H.264 / VP9 / palette gif)."),
  fps: z.number().positive().optional().describe("Output fps (gif only; default 12)."),
  width: z.number().positive().optional().describe("Output width in px, height auto (gif only; default 720)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "convert",
    "Convert a video between mp4, gif, and webm. mp4 uses H.264, webm uses VP9, " +
      "and gif uses a palette filter for quality. Returns the output path.",
    inputSchema,
    async (args) => {
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
        );
        const ffArgs = buildConvertArgs(args.input, output, format, {
          fps: args.fps,
          width: args.width,
        });
        await runFfmpeg(ffArgs, 10 * 60_000);
        return okResponse({ outputPath: output, format });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
