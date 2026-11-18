import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildCropArgs, editOutputExt } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Source video path."),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  output: z.string().optional().describe("Output path; default SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Replace an existing output (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "crop",
    {
      title: "Crop Video",
      description:
        "Crop a video to a pixel rectangle; one running off the frame is rejected.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        requireInput(args.input);
        const { width, height, durationSec } = await probeMedia(args.input);
        const ext = editOutputExt(args.input);
        const output = editOutput(args.output, "crop", ext, { overwrite: args.overwrite });
        const ffArgs = buildCropArgs(
          args.input,
          output,
          { x: args.x, y: args.y, width: args.width, height: args.height },
          { width, height },
        );
        await runEditJob(ffArgs, { output, durationSec, extra });
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
