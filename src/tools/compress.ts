import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildCompressArgs, type CompressLevel, editOutputExt } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  level: z
    .enum(["light", "medium", "heavy"])
    .optional()
    .describe("CRF 23 / 28 / 32 (default medium)."),
  maxWidth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Width cap in px (only downscales)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "compress",
    {
      title: "Compress Video",
      description:
        "Re-encode a video smaller (H.264 CRF ladder, optional width cap). For a platform target use export_preset.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        requireInput(args.input);
        const ext = editOutputExt(args.input);
        const output = editOutput(args.output, "compress", ext, { overwrite: args.overwrite });
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
