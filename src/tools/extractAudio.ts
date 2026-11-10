import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, runCapture } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import {
  buildExtractAudioArgs,
  buildProbeArgs,
  parseMediaInfo,
  copyAudioExtension,
  type AudioFormat,
} from "../utils/media.js";

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
  server.registerTool(
    "extract_audio",
    {
      title: "Extract Audio",
      description:
        "Extract the audio track of a media file to its own file (mp3, aac, wav, " +
        "or copy). Returns the output path.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        const { ffprobe } = requireFfmpeg();
        requireInput(args.input);
        const format = args.format as AudioFormat;
        let audioCodec: string | null = null;
        let ext: string;
        if (format === "copy") {
          // The copied codec dictates the container; probe it first.
          const res = await runCapture(ffprobe, buildProbeArgs(args.input), 30_000, { signal: extra.signal });
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
        const output = editOutput(args.output, "audio", `.${ext}`, { overwrite: args.overwrite, anyContainer: true });
        await runEditJob(buildExtractAudioArgs(args.input, output, format), { output, durationSec: await probeDuration(args.input), extra });
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
