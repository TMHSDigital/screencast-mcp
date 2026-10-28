import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildClipArgs, editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().positive(),
      }),
    )
    .min(1)
    .describe("{start, end} segments in seconds; each becomes its own file."),
  output: z
    .string()
    .optional()
    .describe("Optional output path. Only honored for a single segment; multi-segment output lands under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "clip",
    {
      title: "Extract Clips",
      description:
        "Extract several frame-exact segments, each to its own file. For one segment, trim does the same.",
      inputSchema,
      outputSchema: looseOutput({ outputs: z.array(z.string()), count: z.number().int() }),
      annotations: WRITES_FILE,
    },
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
        for (const [i, seg] of args.segments.entries()) {
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
