import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { probeMedia } from "../utils/ffmpeg.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the media file to probe."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "get_media_info",
    {
      title: "Get Media Info",
      description:
        "Probe a media file with ffprobe and return duration, resolution, frame " +
        "rate, codecs, container format, and size.",
      inputSchema,
      outputSchema: looseOutput({
        input: z.string(),
        durationSec: z.number().nullable(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        fps: z.number().nullable(),
        videoCodec: z.string().nullable(),
        audioCodec: z.string().nullable(),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        return okResponse({ input: args.input, ...(await probeMedia(args.input)) });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
