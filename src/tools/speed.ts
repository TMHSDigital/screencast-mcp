import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildSpeedArgs, editOutputExt } from "../utils/media.js";
import { buildSpeedRangesArgs, checkSpeedRanges, rangesSavedSec, speedRangeSchema } from "../utils/idle.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  factor: z.number().positive().optional().describe("Whole clip: >1 faster, <1 slower."),
  segments: z
    .array(speedRangeSchema)
    .min(1)
    .optional()
    .describe("Or fast-forward just these ranges (audio shortened, not pitched)."),
  output: z.string().optional().describe("Output path; default SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Replace an existing output (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "speed",
    {
      title: "Change Speed",
      description:
        "Change playback speed, or fast-forward ranges, and re-encode. Audio is retempo'd to match.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        requireInput(args.input);
        if ((args.factor === undefined) === (args.segments === undefined)) {
          throw new ScreencastError("Pass factor (the whole clip) or segments (ranges), not both.");
        }
        const { audioCodec, durationSec, fps } = await probeMedia(args.input);
        const ext = editOutputExt(args.input);
        const output = editOutput(args.output, "speed", ext, { overwrite: args.overwrite });
        const hasAudio = audioCodec !== null;
        if (args.segments) {
          const ranges = checkSpeedRanges(args.segments, durationSec);
          const saved = rangesSavedSec(ranges);
          await runEditJob(buildSpeedRangesArgs(args.input, output, ranges, { withAudio: hasAudio, fps }), {
            output,
            durationSec: durationSec !== null ? durationSec - saved : null,
            inputDurationSec: durationSec,
            extra,
          });
          return okResponse({ outputPath: output, segments: ranges, savedSec: Number(saved.toFixed(2)), audio: hasAudio });
        }
        const factor = args.factor!;
        const ffArgs = buildSpeedArgs(args.input, output, factor, hasAudio);
        // Progress follows the output; the timeout follows the input ffmpeg decodes (#237).
        await runEditJob(ffArgs, {
          output,
          durationSec: durationSec !== null ? durationSec / factor : null,
          inputDurationSec: durationSec,
          extra,
        });
        return okResponse({ outputPath: output, factor, audio: hasAudio });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
