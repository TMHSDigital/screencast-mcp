import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildTrimArgs } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  start: z.number().nonnegative().describe("Start time in seconds."),
  end: z.number().positive().optional().describe("End time in seconds. Use end OR duration."),
  duration: z.number().positive().optional().describe("Clip length in seconds. Use end OR duration."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "trim",
    "Trim a video to a sub-clip by start + (end or duration). Uses stream copy " +
      "for speed; cut points snap to the nearest keyframe.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `trim-${stamp()}-${rand()}${ext}`,
          args.overwrite,
        );
        const ffArgs = buildTrimArgs(args.input, output, {
          start: args.start,
          end: args.end,
          duration: args.duration,
        });
        // Length of the trimmed clip, which sizes the job's timeout and progress.
        const start = args.start ?? 0;
        const end = args.end ?? (await probeDuration(args.input));
        const durationSec = args.duration ?? (end !== null ? end - start : null);
        await runEditJob(ffArgs, { output, durationSec, extra });
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
