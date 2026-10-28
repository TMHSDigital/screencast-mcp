import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildXfadeArgs, clipLength, DEFAULT_TRANSITION_DUR } from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  inputA: z.string().min(1).describe("Outgoing video."),
  inputB: z.string().min(1).describe("Incoming video."),
  transition: z
    .string()
    .optional()
    .describe("xfade name (default fade): fade, wipeleft, slideup, circleopen, dissolve, ..."),
  duration: z
    .number()
    .positive()
    .optional()
    .describe(`Transition length in seconds (default ${DEFAULT_TRANSITION_DUR}).`),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "xfade_transition",
    {
      title: "Crossfade Transition",
      description:
        "Join two videos with an xfade transition (audio crossfaded); they need not match in size, " +
        "fps, or audio. For more clips use assemble_highlights.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        for (const f of [args.inputA, args.inputB]) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const [a, b] = await Promise.all([probeMedia(args.inputA), probeMedia(args.inputB)]);
        const durA = clipLength(a);
        const durB = clipLength(b);
        if (durA === null || durB === null) {
          throw new ScreencastError(`Could not read duration of ${durA === null ? args.inputA : args.inputB}.`);
        }
        const clipHasAudio: [boolean, boolean] = [a.audioCodec !== null, b.audioCodec !== null];
        const hasAudio = clipHasAudio[0] || clipHasAudio[1];
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `xfade-${stamp()}-${rand()}.mp4`,
          args.overwrite,
        );
        const ffArgs = buildXfadeArgs(
          args.inputA,
          args.inputB,
          [durA, durB],
          output,
          { transition: args.transition, duration: args.duration },
          clipHasAudio,
        );
        await runEditJob(ffArgs, { output, durationSec: durA + durB, extra });
        return okResponse({ outputPath: output, audio: hasAudio });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
