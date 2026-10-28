import { z } from "zod";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, runFfmpeg, probeMedia, hasFilter } from "../utils/ffmpeg.js";
import { jobTimeoutMs } from "../utils/jobs.js";
import {
  resolveWhisperModel,
  buildTranscribeArgs,
  parseSrt,
  normalizeCues,
  mergePunctuation,
  formatSrt,
  WHISPER_MODEL_ENV,
} from "../utils/captions.js";
import { resolveOutput, subdir, stamp, rand, tempPath } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the video or audio to transcribe."),
  model: z
    .string()
    .optional()
    .describe(`Path to a whisper.cpp model file (ggml-*.bin). Defaults to ${WHISPER_MODEL_ENV}.`),
  language: z.string().optional().describe("Spoken language code, e.g. 'en', or 'auto' (default)."),
  words: z.boolean().optional().describe("One word per cue, for word timing (cut_by_transcript)."),
  output: z.string().optional().describe("Optional output .srt path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "transcribe",
    {
      title: "Transcribe Speech",
      description:
        "Transcribe a recording's speech to an SRT subtitle file, locally, with FFmpeg 8's " +
        "whisper filter (needs a whisper.cpp model file). Returns the SRT path and the text. " +
        "Pair with burn_subtitles to caption the video.",
      inputSchema,
      outputSchema: looseOutput({ srtPath: z.string(), cues: z.number().int(), text: z.string() }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        if (!hasFilter("whisper")) {
          throw new ScreencastError(
            "This ffmpeg has no whisper filter.",
            "transcribe needs FFmpeg 8 built with whisper.cpp (--enable-whisper); recent Windows builds " +
              "such as `winget install Gyan.FFmpeg` include it. Check with `ffmpeg -h filter=whisper`.",
          );
        }
        const model = resolveWhisperModel(args.model);
        const info = await probeMedia(args.input);
        if (!info.audioCodec) throw new ScreencastError(`Input has no audio to transcribe: ${args.input}`);
        const output = resolveOutput(args.output, subdir("edits"), `captions-${stamp()}-${rand()}.srt`, args.overwrite);

        // whisper writes (appends) to its destination; use a fresh temp file,
        // then tidy it into the output.
        const raw = tempPath(".srt");
        try {
          await runFfmpeg(buildTranscribeArgs(args.input, model, raw, args.language ?? "auto", args.words), jobTimeoutMs(info.durationSec), {
            signal: extra.signal,
          });
          const cues = existsSync(raw) ? normalizeCues(mergePunctuation(parseSrt(readFileSync(raw, "utf8")))) : [];
          writeFileSync(output, formatSrt(cues));
          const text = cues.map((c) => c.text.replace(/\n/g, " ")).join(" ");
          return okResponse({
            srtPath: output,
            cues: cues.length,
            text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
            ...(cues.length === 0 ? { note: "No speech was recognised." } : {}),
          });
        } finally {
          rmSync(raw, { force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
