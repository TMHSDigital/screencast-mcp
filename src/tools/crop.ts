import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { buildCropArgs } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  x: z.number().int().nonnegative().describe("Left edge of the crop in pixels."),
  y: z.number().int().nonnegative().describe("Top edge of the crop in pixels."),
  width: z.number().int().positive().describe("Crop width in pixels."),
  height: z.number().int().positive().describe("Crop height in pixels."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "crop",
    "Crop a video to a pixel rectangle (x, y, width, height) and re-encode. A " +
      "rectangle that runs off the source frame is rejected.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const { width, height } = await probeMedia(args.input);
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `crop-${stamp()}-${rand()}${ext}`,
        );
        const ffArgs = buildCropArgs(
          args.input,
          output,
          { x: args.x, y: args.y, width: args.width, height: args.height },
          { width, height },
        );
        await runFfmpeg(ffArgs, 10 * 60_000);
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
