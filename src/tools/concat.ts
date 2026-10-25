import { z } from "zod";
import { extname, resolve } from "node:path";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildConcatArgs, buildConcatListContent } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand, tempPath } from "../utils/paths.js";

const inputSchema = {
  inputs: z
    .array(z.string().min(1))
    .min(2)
    .describe("Two or more video paths to join, in order. Inputs must share codec/format."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "concat",
    "Concatenate two or more videos into a single file using the ffmpeg concat " +
      "demuxer (stream copy). Inputs should share the same codec and format. " +
      "Stream copy carries every packet of each input, including frames an input " +
      "only hides behind an edit list (a trim with exact: false).",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        // The concat demuxer resolves relative list entries against the list
        // file's directory (the OS temp dir), not our cwd, so inputs must be
        // absolute by the time they are written to the list.
        const inputs = args.inputs.map((f) => resolve(f));
        for (const f of inputs) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const ext = extname(inputs[0]) || ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `concat-${stamp()}-${rand()}${ext}`, args.overwrite);
        const listFile = tempPath(".txt");
        writeFileSync(listFile, buildConcatListContent(inputs));
        try {
          const durations = await Promise.all(inputs.map((f) => probeDuration(f)));
          const durationSec = durations.every((d) => d !== null) ? durations.reduce((a, d) => a + d!, 0) : null;
          await runEditJob(buildConcatArgs(listFile, output), { output, durationSec, extra });
        } finally {
          rmSync(listFile, { force: true });
        }
        return okResponse({ outputPath: output, inputCount: inputs.length });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
