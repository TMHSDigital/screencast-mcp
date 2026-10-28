import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildRedactArgs, type RedactStyle, editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

/** One rectangle to redact; shared with pipeline. */
export const redactRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  start: z.number().nonnegative().optional(),
  end: z.number().positive().optional(),
});

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  regions: z
    .array(redactRegionSchema)
    .min(1)
    .describe("Pixel rectangles (x, y, width, height), each optionally limited to start..end seconds."),
  style: z
    .enum(["box", "blur", "pixelate"])
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
        "Cover given rectangles in a video (e.g. secrets on screen). Not automatic detection: find " +
        "them with find_text redact: true. Off-frame regions are rejected.",
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
        const { width, height, durationSec } = await probeMedia(args.input);
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `redact-${stamp()}-${rand()}${ext}`,
          args.overwrite,
        );
        const ffArgs = buildRedactArgs(
          args.input,
          output,
          args.regions,
          {
            style: args.style as RedactStyle | undefined,
            pad: args.pad,
            color: args.color,
          },
          { width, height },
        );
        await runEditJob(ffArgs, { output, durationSec, extra });
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
