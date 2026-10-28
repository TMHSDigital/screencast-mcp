import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, runCapture, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob, jobTimeoutMs } from "../utils/jobs.js";
import {
  loudnessTarget,
  buildLoudnessMeasureArgs,
  buildLoudnessApplyArgs,
  parseLoudnorm,
  type LoudnessPreset,
} from "../utils/audio.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video or audio file."),
  target: z
    .union([z.enum(["youtube", "podcast", "broadcast"]), z.number()])
    .optional()
    .describe(
      "youtube (-14 LUFS, default), podcast (-16), broadcast (-23), or a LUFS number.",
    ),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "normalize_audio",
    {
      title: "Normalize Loudness",
      description:
        "Normalize loudness to a delivery target (two-pass EBU R128 loudnorm); video is copied. " +
        "Reports loudness before and after.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const info = await probeMedia(args.input);
        if (!info.audioCodec) throw new ScreencastError(`Input has no audio stream: ${args.input}`);
        const t = loudnessTarget(args.target as LoudnessPreset | number | undefined);
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input, { audio: true });
        const output = resolveOutput(args.output, subdir("edits"), `loudnorm-${stamp()}-${rand()}${ext}`, args.overwrite);

        const timeout = jobTimeoutMs(info.durationSec);
        const before = await runCapture(ffmpeg, buildLoudnessMeasureArgs(args.input, t), timeout, { signal: extra.signal });
        const measured = parseLoudnorm(before.stderr);
        await runEditJob(buildLoudnessApplyArgs(args.input, output, t, measured), {
          output,
          durationSec: info.durationSec,
          extra,
        });
        const after = parseLoudnorm(
          (await runCapture(ffmpeg, buildLoudnessMeasureArgs(output, t), timeout, { signal: extra.signal })).stderr,
        );
        return okResponse({
          outputPath: output,
          target: { lufs: t.i, truePeakDb: t.tp, lra: t.lra },
          before: { lufs: measured.input_i, truePeakDb: measured.input_tp },
          after: { lufs: after.input_i, truePeakDb: after.input_tp },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
