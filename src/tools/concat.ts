import { z } from "zod";
import { extname } from "node:path";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildConcatArgs, buildConcatListContent } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand, tempPath } from "../utils/paths.js";

const inputSchema = {
  inputs: z
    .array(z.string().min(1))
    .min(2)
    .describe("Two or more video paths to join, in order. Inputs must share codec/format."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "concat",
    "Concatenate two or more videos into a single file using the ffmpeg concat " +
      "demuxer (stream copy). Inputs should share the same codec and format.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        for (const f of args.inputs) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const ext = extname(args.inputs[0]) || ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `concat-${stamp()}-${rand()}${ext}`);
        const listFile = tempPath(".txt");
        writeFileSync(listFile, buildConcatListContent(args.inputs));
        try {
          await runFfmpeg(buildConcatArgs(listFile, output), 10 * 60_000);
        } finally {
          rmSync(listFile, { force: true });
        }
        return okResponse({ outputPath: output, inputCount: args.inputs.length });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
