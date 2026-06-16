import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildScaleArgs } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  width: z.number().int().positive().optional().describe("Target width in px. Omit to derive from height (keeps aspect)."),
  height: z.number().int().positive().optional().describe("Target height in px. Omit to derive from width (keeps aspect)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "scale",
    "Resize a video to a target width and/or height and re-encode. Provide one " +
      "side to keep the aspect ratio, or both to set an exact size.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `scale-${stamp()}-${rand()}${ext}`,
        );
        const ffArgs = buildScaleArgs(args.input, output, {
          width: args.width,
          height: args.height,
        });
        await runFfmpeg(ffArgs, 10 * 60_000);
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
