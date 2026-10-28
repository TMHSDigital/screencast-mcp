import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { captureStill } from "../utils/still.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";
import { windowMatchReport } from "../utils/windows.js";

const inputSchema = {
  target: z
    .string()
    .describe(
      "Capture target: 'full' | 'monitor:<index>' | 'window:<title>' (or window:exe=<app.exe> / window:hwnd=<handle>) | " +
        "'region:<x>,<y>,<w>,<h>'. window: captures the on-screen rectangle the " +
        "window occupies as currently displayed - it must be visible, on top, " +
        "and not minimized (case-insensitive exact title, else substring; " +
        "topmost match wins).",
    ),
  exactTitle: z
    .boolean()
    .optional()
    .describe(
      "For window: targets, match only a window whose title equals the given " +
        "title (case-insensitive); never fall back to a substring match. Default false.",
    ),
  backend: z
    .enum(["gdigrab", "wgc"])
    .optional()
    .describe(
      "gdigrab (default, ~0.2 s) captures what is visible on screen. 'wgc' (window: targets " +
        "only, FFmpeg 8+) captures the window's own surface through Windows Graphics Capture, " +
        "even when other windows cover it; slower (~1-2 s).",
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
  server.registerTool(
    "screenshot",
    {
      title: "Take Screenshot",
      description:
        "Capture a single still frame (PNG) of a target (full screen, a monitor, a " +
        "window by title, or a region). Returns the image path, plus the image " +
        "inline so the model can view it directly (disable with returnImage: false).",
      inputSchema,
      outputSchema: looseOutput({
        outputPath: z.string(),
        target: z.string(),
        backend: z.string(),
        inlineImages: z.number().int(),
      }),
      annotations: WRITES_FILE,
    },
    async (args) => {
      try {
        requireFfmpeg();
        const resolved = await resolveCaptureTarget(args.target, { exactTitle: args.exactTitle, backend: args.backend });
        const { window } = resolved;
        const output = resolveOutput(
          args.output,
          subdir("screenshots"),
          `shot-${stamp()}-${rand()}.png`,
          args.overwrite,
        );
        const backend = args.backend ?? "gdigrab";
        await captureStill(resolved, output, backend);
        const images =
          args.returnImage === false
            ? []
            : (await encodeInlineImages([output], args.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH, 1)).images;
        return okResponse(
          {
            outputPath: output,
            target: args.target,
            backend,
            ...(window ? windowMatchReport(window) : {}),
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
