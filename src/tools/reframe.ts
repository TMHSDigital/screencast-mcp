import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildReframeArgs, type Aspect, type ReframeFit } from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  aspect: z
    .enum(["16:9", "9:16", "1:1", "4:5"])
    .describe("Target aspect ratio."),
  fit: z
    .enum(["pad", "crop"])
    .optional()
    .describe("pad (default): scale to fit and letterbox, no content lost. crop: scale to fill and center-crop."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "reframe",
    "Re-aspect a video to a target ratio (16:9, 9:16, 1:1, 4:5). 'pad' " +
      "letterboxes so nothing is lost; 'crop' fills the frame and trims the " +
      "overflow. Returns the output path.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `reframe-${stamp()}-${rand()}${ext}`);
        const ffArgs = buildReframeArgs(
          args.input,
          output,
          args.aspect as Aspect,
          (args.fit as ReframeFit | undefined) ?? "pad",
        );
        await runFfmpeg(ffArgs, 15 * 60_000);
        return okResponse({ outputPath: output, aspect: args.aspect, fit: args.fit ?? "pad" });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
