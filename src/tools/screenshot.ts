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
import { confirmCapture, describeTarget } from "../utils/consent.js";

const inputSchema = {
  target: z
    .string()
    .describe(
      "full | monitor:<i> (0 = primary) | window:<title> (or window:exe=<app.exe> / window:hwnd=<n>) | " +
        "region:<x>,<y>,<w>,<h>. Titles match exactly, else as a substring; topmost wins.",
    ),
  exactTitle: z
    .boolean()
    .optional()
    .describe(
      "window: targets match the whole title only, never a substring (default false).",
    ),
  backend: z
    .enum(["gdigrab", "wgc"])
    .optional()
    .describe(
      "gdigrab (default, ~0.2 s): what is visible. wgc (window:, FFmpeg 8+, ~1-2 s): the window even if covered.",
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
      "Return the image inline (default true; the PNG on disk stays full size).",
    ),
  maxImageWidth: z
    .number()
    .int()
    .min(16)
    .optional()
    .describe(`Max inline image width (default ${DEFAULT_MAX_IMAGE_WIDTH}).`),
};

export function register(server: McpServer): void {
  server.registerTool(
    "screenshot",
    {
      title: "Take Screenshot",
      description:
        "Capture one PNG of the screen, a monitor, a window, or a region, returned inline and by path.",
      inputSchema,
      outputSchema: looseOutput({
        outputPath: z.string(),
        target: z.string(),
        backend: z.string(),
        inlineImages: z.number().int(),
      }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
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
        await confirmCapture(server, `Take a screenshot of ${describeTarget(args.target, window)}, saved to ${output}?`, extra.signal);
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
