import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildOverlayArgs, editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the base video."),
  overlay: z.string().min(1).describe("Overlay image or video path."),
  x: z.number().int().nonnegative().describe("Left, px."),
  y: z.number().int().nonnegative().describe("Top, px."),
  width: z.number().int().positive().optional().describe("Scale to this width (other side keeps aspect)."),
  height: z.number().int().positive().optional().describe("Scale to this height."),
  start: z.number().nonnegative().optional().describe("Show from this second."),
  end: z.number().positive().optional().describe("Hide after this second."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "overlay",
    {
      title: "Overlay Image or Video",
      description:
        "Composite an image or video (logo, watermark, picture-in-picture) onto a video at a pixel " +
        "position, optionally scaled and time-limited; keeps the base's audio and length.",
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
        if (!existsSync(args.overlay)) {
          throw new ScreencastError(`Overlay file not found: ${args.overlay}`);
        }
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `overlay-${stamp()}-${rand()}${ext}`,
          args.overwrite,
        );
        const scale =
          args.width !== undefined || args.height !== undefined
            ? { width: args.width, height: args.height }
            : undefined;
        const durationSec = await probeDuration(args.input);
        const ffArgs = buildOverlayArgs(args.input, args.overlay, output, {
          x: args.x,
          y: args.y,
          start: args.start,
          end: args.end,
          scale,
          durationSec,
        });
        await runEditJob(ffArgs, { output, durationSec, extra });
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
