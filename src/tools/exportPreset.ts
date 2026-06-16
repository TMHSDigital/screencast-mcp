import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import {
  buildExportPresetArgs,
  PLATFORM_PRESETS,
  type Platform,
  type ReframeFit,
} from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  platform: z
    .enum(["youtube", "instagram_reel", "tiktok", "x", "square"])
    .describe("Target platform. Sets aspect, resolution, fps, and bitrate."),
  fit: z
    .enum(["pad", "crop"])
    .optional()
    .describe("How to fit the source into the platform aspect: pad (default) or crop."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "export_preset",
    "Encode a platform-ready file for youtube, instagram_reel, tiktok, x, or " +
      "square. Reframes to the platform aspect, caps fps, and encodes H.264 at " +
      "the platform bitrate with faststart. Returns the output path.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const platform = args.platform as Platform;
        const output = resolveOutput(args.output, subdir("edits"), `${platform}-${stamp()}-${rand()}.mp4`);
        const ffArgs = buildExportPresetArgs(
          args.input,
          output,
          platform,
          (args.fit as ReframeFit | undefined) ?? "pad",
        );
        await runFfmpeg(ffArgs, 20 * 60_000);
        const spec = PLATFORM_PRESETS[platform];
        return okResponse({ outputPath: output, platform, aspect: spec.aspect, fps: spec.fps });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
