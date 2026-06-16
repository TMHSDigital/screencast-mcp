import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildOverlayArgs } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the base video."),
  overlay: z.string().min(1).describe("Path to the overlay image or video (logo, watermark, picture-in-picture)."),
  x: z.number().int().nonnegative().describe("Overlay left position in pixels."),
  y: z.number().int().nonnegative().describe("Overlay top position in pixels."),
  width: z.number().int().positive().optional().describe("Optional overlay width in px (height auto when omitted)."),
  height: z.number().int().positive().optional().describe("Optional overlay height in px (width auto when omitted)."),
  start: z.number().nonnegative().optional().describe("Optional second to show the overlay from."),
  end: z.number().positive().optional().describe("Optional second to hide the overlay after."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "overlay",
    "Composite an image or video (logo, watermark, picture-in-picture) onto a " +
      "base video at a pixel position, optionally scaled and time-limited.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        if (!existsSync(args.overlay)) {
          throw new ScreencastError(`Overlay file not found: ${args.overlay}`);
        }
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `overlay-${stamp()}-${rand()}${ext}`,
        );
        const scale =
          args.width !== undefined || args.height !== undefined
            ? { width: args.width, height: args.height }
            : undefined;
        const ffArgs = buildOverlayArgs(args.input, args.overlay, output, {
          x: args.x,
          y: args.y,
          start: args.start,
          end: args.end,
          scale,
        });
        await runFfmpeg(ffArgs, 10 * 60_000);
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
