import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildExtractAudioArgs, type AudioFormat } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

// `copy` keeps the source codec; the .m4a container holds whatever was copied.
const EXTENSION: Record<AudioFormat, string> = {
  mp3: "mp3",
  aac: "m4a",
  wav: "wav",
  copy: "m4a",
};

const inputSchema = {
  input: z.string().min(1).describe("Path to the source media."),
  format: z
    .enum(["mp3", "aac", "wav", "copy"])
    .describe("Audio output codec. copy keeps the source codec without re-encoding."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "extract_audio",
    "Extract the audio track of a media file to its own file (mp3, aac, wav, " +
      "or copy). Returns the output path.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const format = args.format as AudioFormat;
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `audio-${stamp()}-${rand()}.${EXTENSION[format]}`,
        );
        await runFfmpeg(buildExtractAudioArgs(args.input, output, format), 10 * 60_000);
        return okResponse({ outputPath: output, format });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
