import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { buildAssembleArgs, DEFAULT_TRANSITION_DUR } from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  clips: z
    .array(z.string().min(1))
    .min(2)
    .describe("Two or more clip paths, in order. Clips are auto-normalized, so they need not match."),
  transition: z
    .string()
    .optional()
    .describe("'cut' (default, hard cuts) or an xfade transition name (fade, wipeleft, slideup, ...)."),
  duration: z
    .number()
    .positive()
    .optional()
    .describe(`Transition length in seconds when not a cut (default ${DEFAULT_TRANSITION_DUR}).`),
  width: z.number().int().positive().optional().describe("Common output width (default 1920)."),
  height: z.number().int().positive().optional().describe("Common output height (default 1080)."),
  fps: z.number().int().positive().optional().describe("Common output fps (default 30)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "assemble_highlights",
    "Stitch two or more clips into a single video, with hard cuts or an xfade " +
      "transition between each. Clips are auto-normalized to a common " +
      "resolution, fps, and audio rate, so they need not match.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        for (const f of args.clips) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const infos = await Promise.all(args.clips.map((c) => probeMedia(c)));
        const durations = infos.map((i) => i.durationSec ?? 0);
        const clipHasAudio = infos.map((i) => i.audioCodec !== null);
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `highlights-${stamp()}-${rand()}.mp4`,
        );
        const ffArgs = buildAssembleArgs(
          args.clips,
          durations,
          output,
          {
            transition: args.transition,
            duration: args.duration,
            width: args.width,
            height: args.height,
            fps: args.fps,
          },
          clipHasAudio,
        );
        await runFfmpeg(ffArgs, 20 * 60_000);
        return okResponse({
          outputPath: output,
          clips: args.clips.length,
          transition: args.transition ?? "cut",
          audio: clipHasAudio.some(Boolean),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
