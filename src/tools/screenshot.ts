import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildScreenshotArgs } from "../utils/targets.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";

const inputSchema = {
  target: z
    .string()
    .describe(
      "Capture target: 'full' | 'monitor:<index>' | 'window:<title>' | " +
        "'region:<x>,<y>,<w>,<h>'. window: captures the on-screen rectangle the " +
        "window occupies as currently displayed - it must be visible, on top, " +
        "and not minimized (case-insensitive exact title, else substring; " +
        "topmost match wins).",
    ),
  output: z
    .string()
    .optional()
    .describe(
      "Optional output .png path. Defaults to a file under SCREENCAST_HOME/screenshots.",
    ),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
  returnImage: z
    .boolean()
    .optional()
    .describe(
      "Also return the screenshot inline as an image the model can view directly " +
        "(default true). The PNG on disk is always full resolution.",
    ),
  maxImageWidth: z
    .number()
    .int()
    .min(16)
    .optional()
    .describe(`Downscale the inline image to at most this width (default ${DEFAULT_MAX_IMAGE_WIDTH}).`),
};

export function register(server: McpServer): void {
  server.tool(
    "screenshot",
    "Capture a single still frame (PNG) of a target (full screen, a monitor, a " +
      "window by title, or a region). Returns the image path, plus the image " +
      "inline so the model can view it directly (disable with returnImage: false).",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        const { target, monitors, window } = resolveCaptureTarget(args.target);
        const output = resolveOutput(
          args.output,
          subdir("screenshots"),
          `shot-${stamp()}-${rand()}.png`,
          args.overwrite,
        );
        await runFfmpeg(buildScreenshotArgs(target, output, monitors), 60_000);
        const images =
          args.returnImage === false
            ? []
            : (await encodeInlineImages([output], args.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH, 1)).images;
        return okResponse(
          {
            outputPath: output,
            target: args.target,
            ...(window ? { matchedWindow: window.matchedTitle, region: window } : {}),
            inlineImages: images.length,
          },
          images,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
