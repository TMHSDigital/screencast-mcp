import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildCompressArgs, type CompressLevel } from "../utils/media.js";
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
};

export function register(server: McpServer): void {
  server.tool(
    "compress",
    "Re-encode a video to a smaller file with a CRF quality ladder and an " +
      "optional width cap. Returns the output path.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `compress-${stamp()}-${rand()}${ext}`,
        );
        const ffArgs = buildCompressArgs(args.input, output, {
          level: args.level as CompressLevel | undefined,
          maxWidth: args.maxWidth,
        });
        await runFfmpeg(ffArgs, 15 * 60_000);
        return okResponse({ outputPath: output, level: args.level ?? "medium" });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
