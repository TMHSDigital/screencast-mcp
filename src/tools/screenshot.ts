import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildScreenshotArgs } from "../utils/targets.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

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
};

export function register(server: McpServer): void {
  server.tool(
    "screenshot",
    "Capture a single still frame (PNG) of a target (full screen, a monitor, a " +
      "window by title, or a region). Returns the image path.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        const { target, monitors, window } = resolveCaptureTarget(args.target);
        const output = resolveOutput(
          args.output,
          subdir("screenshots"),
          `shot-${stamp()}-${rand()}.png`,
        );
        await runFfmpeg(buildScreenshotArgs(target, output, monitors), 60_000);
        return okResponse({
          outputPath: output,
          target: args.target,
          ...(window ? { matchedWindow: window.matchedTitle, region: window } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
