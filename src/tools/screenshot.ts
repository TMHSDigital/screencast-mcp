import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { getMonitors } from "../utils/monitors.js";
import { buildScreenshotArgs, parseTarget } from "../utils/targets.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  target: z
    .string()
    .describe(
      "Capture target: 'full' | 'monitor:<index>' | 'window:<exact title>' | " +
        "'region:<x>,<y>,<w>,<h>'.",
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
        const target = parseTarget(args.target);
        const monitors = target.kind === "monitor" ? getMonitors() : [];
        const output = resolveOutput(
          args.output,
          subdir("screenshots"),
          `shot-${stamp()}-${rand()}.png`,
        );
        await runFfmpeg(buildScreenshotArgs(target, output, monitors), 60_000);
        return okResponse({ outputPath: output, target: args.target });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
