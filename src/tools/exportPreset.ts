import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import {
  buildExportPresetArgs,
  PLATFORM_PRESETS,
  PLATFORMS,
  type Platform,
  type ReframeFit,
} from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  platform: z
    .enum(PLATFORMS)
    .describe(
      "Sets aspect, size, fps, bitrate. steam_trailer: 1080p 5.5 Mbps CBR, -14 LUFS. vertical_reel: " +
        "1080x1920 over a blurred copy of itself, -14 LUFS (ignores fit).",
    ),
  fit: z
    .enum(["pad", "crop"])
    .optional()
    .describe("Fit to the platform aspect: pad (default) or crop."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "export_preset",
    {
      title: "Export for Platform",
      description:
        "Encode a platform-ready H.264 file (aspect, fps, bitrate, faststart) for a named platform.",
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
        const platform = args.platform as Platform;
        const output = resolveOutput(args.output, subdir("edits"), `${platform}-${stamp()}-${rand()}.mp4`, args.overwrite);
        const ffArgs = buildExportPresetArgs(
          args.input,
          output,
          platform,
          (args.fit as ReframeFit | undefined) ?? "pad",
        );
        await runEditJob(ffArgs, { output, durationSec: await probeDuration(args.input), extra });
        const spec = PLATFORM_PRESETS[platform];
        return okResponse({ outputPath: output, platform, aspect: spec.aspect, fps: spec.fps });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
