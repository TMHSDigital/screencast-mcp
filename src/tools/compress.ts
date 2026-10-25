import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildCompressArgs, type CompressLevel, editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  level: z
    .enum(["light", "medium", "heavy"])
    .optional()
    .describe("How hard to compress (CRF 23 / 28 / 32). Default medium."),
  maxWidth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional width cap in px; only ever downscales. Height follows aspect."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "compress",
    "Re-encode a video to a smaller file with a CRF quality ladder and an " +
      "optional width cap. Returns the output path.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `compress-${stamp()}-${rand()}${ext}`,
          args.overwrite,
        );
        const ffArgs = buildCompressArgs(args.input, output, {
          level: args.level as CompressLevel | undefined,
          maxWidth: args.maxWidth,
        });
        await runEditJob(ffArgs, { output, durationSec: await probeDuration(args.input), extra });
        return okResponse({ outputPath: output, level: args.level ?? "medium" });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
