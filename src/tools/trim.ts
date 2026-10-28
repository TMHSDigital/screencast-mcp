import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildTrimArgs, editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  start: z.number().nonnegative().describe("Start time in seconds."),
  end: z.number().positive().optional().describe("End time in seconds. Use end OR duration."),
  duration: z.number().positive().optional().describe("Clip length in seconds. Use end OR duration."),
  exact: z
    .boolean()
    .optional()
    .describe(
      "Re-encode for a frame-exact cut with the removed content really gone (default true). false = fast " +
        "stream copy that snaps to a keyframe and keeps hidden earlier frames; never use it to remove secrets.",
    ),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "trim",
    {
      title: "Trim Video",
      description:
        "Cut a video down to one sub-clip by start + (end or duration). For several segments use clip; " +
        "to combine with other edits use pipeline.",
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
        // A stream copy keeps the input's container; a re-encode needs one that
        // holds libx264/AAC.
        if (args.exact !== false) assertEditContainer(args.output);
        const ext = args.exact === false ? extname(args.input) || ".mp4" : editOutputExt(args.input);
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
          exact: args.exact,
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
