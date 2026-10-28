import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { DEFAULT_ANIM_FPS, DEFAULT_ANIM_WIDTH, DEFAULT_MAX_BYTES, type AnimFormat } from "../utils/anim.js";
import { exportAnimation } from "../utils/animExport.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  format: z
    .enum(["gif", "webp"])
    .optional()
    .describe("gif (plays everywhere, default) or webp (animated WebP, usually much smaller)."),
  maxBytes: z
    .number()
    .int()
    .min(10_000)
    .optional()
    .describe(
      `File-size budget in bytes (default ${DEFAULT_MAX_BYTES}, under GitHub's 10 MB limit ` +
        "for images). Quality steps down until the file fits.",
    ),
  fps: z.number().positive().max(30).optional().describe(`Starting frame rate (default ${DEFAULT_ANIM_FPS}).`),
  width: z
    .number()
    .int()
    .min(64)
    .max(1920)
    .optional()
    .describe(`Starting width in px (default ${DEFAULT_ANIM_WIDTH}); height follows the aspect ratio.`),
  start: z.number().nonnegative().optional().describe("Start at this many seconds into the video."),
  duration: z.number().positive().optional().describe("Export only this many seconds (default: to the end)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "export_gif",
    {
      title: "Export GIF or WebP",
      description:
        "Export a video as an optimized animated GIF or WebP that fits a file-size budget " +
        "(default: GitHub's 10 MB image limit), for PRs, issues, and READMEs. Steps fps, " +
        "width, and palette/quality down until it fits and reports the settings used.",
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
        const format: AnimFormat = args.format ?? "gif";
        const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
        const output = resolveOutput(args.output, subdir("edits"), `anim-${stamp()}-${rand()}.${format}`, args.overwrite);
        return okResponse(
          await exportAnimation(
            args.input,
            output,
            { format, maxBytes, fps: args.fps, width: args.width, start: args.start, duration: args.duration },
            extra,
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
