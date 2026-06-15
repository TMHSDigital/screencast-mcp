import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runCapture } from "../utils/ffmpeg.js";
import { buildProbeArgs, parseMediaInfo } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the media file to probe."),
};

export function register(server: McpServer): void {
  server.tool(
    "get_media_info",
    "Probe a media file with ffprobe and return duration, resolution, frame " +
      "rate, codecs, container format, and size.",
    inputSchema,
    async (args) => {
      try {
        const { ffprobe } = requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const res = await runCapture(ffprobe, buildProbeArgs(args.input), 30_000);
        if (res.code !== 0) {
          throw new ScreencastError(
            `ffprobe failed (exit ${res.code}): ${res.stderr.trim().slice(-400)}`,
          );
        }
        return okResponse({ input: args.input, ...parseMediaInfo(JSON.parse(res.stdout)) });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
