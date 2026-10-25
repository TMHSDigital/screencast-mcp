import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildClipArgs, editOutputExt, assertEditContainer } from "../utils/media.js";
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
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "clip",
    "Extract one or more frame-accurate sub-segments to separate files. Unlike " +
      "trim (fast stream copy that snaps to a keyframe), clip re-encodes so cuts " +
      "land exactly on the given times.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const single = args.segments.length === 1;
        const outputs: string[] = [];
        for (let i = 0; i < args.segments.length; i++) {
          const seg = args.segments[i];
          const output = resolveOutput(
            single ? args.output : undefined,
            subdir("edits"),
            `clip-${stamp()}-${rand()}-${String(i).padStart(2, "0")}${ext}`,
            args.overwrite,
          );
          await runEditJob(buildClipArgs(args.input, output, seg), { output, durationSec: seg.end - seg.start, extra });
          outputs.push(output);
        }
        return okResponse({ outputs, count: outputs.length });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
