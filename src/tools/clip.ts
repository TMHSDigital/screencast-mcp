import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildClipArgs } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative().describe("Segment start in seconds."),
        end: z.number().positive().describe("Segment end in seconds."),
      }),
    )
    .min(1)
    .describe("One or more {start, end} segments. Each becomes its own output file."),
  output: z
    .string()
    .optional()
    .describe("Optional output path. Only honored for a single segment; multi-segment output lands under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "clip",
    "Extract one or more frame-accurate sub-segments to separate files. Unlike " +
      "trim (fast stream copy that snaps to a keyframe), clip re-encodes so cuts " +
      "land exactly on the given times.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const ext = extname(args.input) || ".mp4";
        const single = args.segments.length === 1;
        const outputs: string[] = [];
        for (let i = 0; i < args.segments.length; i++) {
          const seg = args.segments[i];
          const output = resolveOutput(
            single ? args.output : undefined,
            subdir("edits"),
            `clip-${stamp()}-${rand()}-${String(i).padStart(2, "0")}${ext}`,
          );
          await runFfmpeg(buildClipArgs(args.input, output, seg), 10 * 60_000);
          outputs.push(output);
        }
        return okResponse({ outputs, count: outputs.length });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
