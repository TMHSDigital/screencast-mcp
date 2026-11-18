import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildScaleArgs, editOutputExt } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Source video path."),
  width: z.number().int().positive().optional().describe("Target width in px. Omit to derive from height (keeps aspect)."),
  height: z.number().int().positive().optional().describe("Target height in px. Omit to derive from width (keeps aspect)."),
  output: z.string().optional().describe("Output path; default SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Replace an existing output (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "scale",
    {
      title: "Scale Video",
      description:
        "Resize a video to a target width and/or height and re-encode. Provide one " +
        "side to keep the aspect ratio, or both to set an exact size.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        requireInput(args.input);
        const ext = editOutputExt(args.input);
        const output = editOutput(args.output, "scale", ext, { overwrite: args.overwrite });
        const ffArgs = buildScaleArgs(args.input, output, {
          width: args.width,
          height: args.height,
        });
        await runEditJob(ffArgs, { output, durationSec: await probeDuration(args.input), extra });
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
