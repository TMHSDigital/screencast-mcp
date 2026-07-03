import { z } from "zod";
import { extname, join, resolve } from "node:path";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildConcatArgs, buildConcatListContent } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

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
        // The concat demuxer resolves relative list entries against the list
        // file's directory (not our cwd), so inputs must be absolute.
        const inputs = args.inputs.map((f) => resolve(f));
        for (const f of inputs) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const ext = extname(inputs[0]) || ".mp4";
        const editsDir = subdir("edits");
        const output = resolveOutput(args.output, editsDir, `concat-${stamp()}-${rand()}${ext}`);
        const listFile = join(editsDir, `.concat-${stamp()}-${rand()}.txt`);
        writeFileSync(listFile, buildConcatListContent(inputs));
        try {
          await runFfmpeg(buildConcatArgs(listFile, output), 10 * 60_000);
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
