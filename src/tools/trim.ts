import { z } from "zod";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildTrimArgs, editOutputExt, trimSpan } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Source video path."),
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
  output: z.string().optional().describe("Output path; default SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Replace an existing output (default false)."),
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
        requireInput(args.input);
        // A stream copy keeps the input's container; a re-encode needs one that
        // holds libx264/AAC.
        const ext = args.exact === false ? extname(args.input) || ".mp4" : editOutputExt(args.input);
        const output = editOutput(args.output, "trim", ext, { overwrite: args.overwrite, anyContainer: args.exact === false });
        // The video's length: a start past it is refused and the end is
        // clamped to it, as a pipeline trim step does (#360).
        const length = await probeDuration(args.input);
        const span = trimSpan(args, length);
        const ffArgs = buildTrimArgs(args.input, output, { ...span, exact: args.exact });
        // Length of the trimmed clip, which sizes the job's timeout and progress.
        await runEditJob(ffArgs, { output, durationSec: span.end - span.start, extra });
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
