import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, runCapture } from "../utils/ffmpeg.js";
import {
  buildExtractAudioArgs,
  buildProbeArgs,
  parseMediaInfo,
  copyAudioExtension,
  type AudioFormat,
} from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

// Re-encode formats have a fixed container. `copy` keeps the source codec, so
// its container must match that codec (probed per call, see below) - a blanket
// .m4a writes a broken file for opus/vorbis/etc (#36).
const EXTENSION: Record<Exclude<AudioFormat, "copy">, string> = {
  mp3: "mp3",
  aac: "m4a",
  wav: "wav",
};

const inputSchema = {
  input: z.string().min(1).describe("Path to the source media."),
  format: z
    .enum(["mp3", "aac", "wav", "copy"])
    .describe("Audio output codec. copy keeps the source codec without re-encoding."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "extract_audio",
    "Extract the audio track of a media file to its own file (mp3, aac, wav, " +
      "or copy). Returns the output path.",
    inputSchema,
    async (args) => {
      try {
        const { ffprobe } = requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const format = args.format as AudioFormat;
        let audioCodec: string | null = null;
        let ext: string;
        if (format === "copy") {
          // The copied codec dictates the container; probe it first.
          const res = await runCapture(ffprobe, buildProbeArgs(args.input), 30_000);
          if (res.code !== 0) {
            throw new ScreencastError(
              `ffprobe failed (exit ${res.code}): ${res.stderr.trim().slice(-400)}`,
            );
          }
          audioCodec = parseMediaInfo(JSON.parse(res.stdout)).audioCodec;
          if (!audioCodec) {
            throw new ScreencastError(
              `Input has no audio stream to extract: ${args.input}`,
            );
          }
          ext = copyAudioExtension(audioCodec);
        } else {
          ext = EXTENSION[format];
        }
        const output = resolveOutput(
          args.output,
          subdir("edits"),
          `audio-${stamp()}-${rand()}.${ext}`,
          args.overwrite,
        );
        await runFfmpeg(buildExtractAudioArgs(args.input, output, format), 10 * 60_000);
        return okResponse({
          outputPath: output,
          format,
          ...(audioCodec ? { sourceAudioCodec: audioCodec } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
