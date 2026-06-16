import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { buildRedactArgs, type RedactStyle } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  regions: z
    .array(
      z.object({
        x: z.number().int().nonnegative().describe("Left edge in pixels."),
        y: z.number().int().nonnegative().describe("Top edge in pixels."),
        width: z.number().int().positive().describe("Region width in pixels."),
        height: z.number().int().positive().describe("Region height in pixels."),
        start: z.number().nonnegative().optional().describe("Optional second to start redacting from."),
        end: z.number().positive().optional().describe("Optional second to stop redacting after."),
      }),
    )
    .min(1)
    .describe("One or more rectangles to redact. Each may be limited to a time window."),
  style: z
    .enum(["box", "blur", "pixelate"])
    .optional()
    .describe("box (default) draws an irreversible solid fill; blur and pixelate are softer but partially recoverable."),
  pad: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Optional pixels to expand each region by, to cover anti-aliased edges (default 0)."),
  color: z.string().optional().describe("Fill color for box style (default black)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "redact_region",
    "Redact declared rectangles in a video so secrets on screen are covered. " +
      "This covers regions you specify; it is NOT automatic secret detection. " +
      "The default style is a solid box, which is irreversible (a blur or mosaic " +
      "can be partially recovered). A region that falls outside the frame is " +
      "rejected rather than silently doing nothing.",
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
          `redact-${stamp()}-${rand()}${ext}`,
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
        await runFfmpeg(ffArgs, 15 * 60_000);
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
