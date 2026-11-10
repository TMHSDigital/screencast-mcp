import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildRedactArgs, stillEdit, redactRegionSchema, REDACT_STYLES } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video or image (png/jpg; time ranges are ignored for an image)."),
  regions: z
    .array(redactRegionSchema)
    .min(1)
    .describe("Pixel rectangles (x, y, width, height), each optionally limited to start..end seconds."),
  style: z
    .enum(REDACT_STYLES)
    .optional()
    .describe("box (default): irreversible fill; blur/pixelate are partially recoverable."),
  pad: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Grow each region by this many px (default 0)."),
  color: z.string().optional().describe("Box fill color (default black)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "redact_region",
    {
      title: "Redact Regions",
      description:
        "Cover given rectangles in a video or screenshot (e.g. secrets on screen). Not automatic detection: find " +
        "them with find_text redact: true. Off-frame regions are rejected.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        requireInput(args.input);
        const { width, height, durationSec } = await probeMedia(args.input);
        // A png/jpg input is redacted as one image (#319).
        const { still, ext } = stillEdit(args.input, args.output);
        const output = editOutput(args.output, "redact", ext, { overwrite: args.overwrite, anyContainer: true });
        const ffArgs = buildRedactArgs(
          args.input,
          output,
          args.regions,
          {
            style: args.style,
            pad: args.pad,
            color: args.color,
          },
          { width, height },
          still,
        );
        await runEditJob(ffArgs, { output, durationSec: still ? null : durationSec, extra });
        return okResponse({
          outputPath: output,
          regions: args.regions.length,
          style: args.style ?? "box",
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
