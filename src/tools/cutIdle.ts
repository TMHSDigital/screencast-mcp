import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { findIdle } from "../utils/idleScan.js";
import { runEditJob, jobTimeoutMs } from "../utils/jobs.js";
import {
  cutsFor,
  buildCutIdleArgs,
  buildSpeedRangesArgs,
  rangesSavedSec,
  DEFAULT_IDLE_FACTOR,
  DEFAULT_MIN_IDLE_SEC,
  DEFAULT_KEEP_SEC,
  MAX_RANGE_FACTOR,
  describedIdleOptionFields,
} from "../utils/idle.js";
import { editOutputExt } from "../utils/media.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  minIdleSec: z
    .number()
    .positive()
    .optional()
    .describe(`Only cut still stretches at least this long (default ${DEFAULT_MIN_IDLE_SEC}).`),
  keepSec: z
    .number()
    .min(0)
    .optional()
    .describe(`Seconds kept at each edge of a cut (default ${DEFAULT_KEEP_SEC}).`),
  useAudio: z
    .boolean()
    .optional()
    .describe("Require silent audio too (default true when there is audio)."),
  ...describedIdleOptionFields,
  action: z.enum(["cut", "speed"]).optional().describe("cut (default), or speed: fast-forward them."),
  factor: z.number().gt(1).max(MAX_RANGE_FACTOR).optional().describe(`speed: times faster (default ${DEFAULT_IDLE_FACTOR}).`),
  dryRun: z.boolean().optional().describe("Only report what would be cut."),
  output: z.string().optional().describe("Output path; default SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Replace an existing output (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "cut_idle",
    {
      title: "Cut Idle Stretches",
      description:
        "Remove dead air: cut stretches where the screen is frozen (and silent), keeping a short pad. " +
        "Returns the time saved.",
      inputSchema,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        requireInput(args.input);
        const info = await probeMedia(args.input);
        const duration = info.durationSec;
        if (duration === null) throw new ScreencastError(`Could not read duration of ${args.input}.`);
        const minIdle = args.minIdleSec ?? DEFAULT_MIN_IDLE_SEC;
        const keep = args.keepSec ?? DEFAULT_KEEP_SEC;
        const hasAudio = info.audioCodec !== null;
        const useAudio = (args.useAudio ?? true) && hasAudio;

        const { idle, rule } = await findIdle(ffmpeg, args.input, {
          minIdleSec: minIdle,
          useAudio,
          duration,
          sensitivity: args.sensitivity,
          ignoreRegions: args.ignoreRegions,
          basis: args.basis,
          timeoutMs: jobTimeoutMs(duration),
          signal: extra.signal,
        });
        const cuts = cutsFor(idle, minIdle, keep);
        const speedUp = args.action === "speed";
        const factor = args.factor ?? DEFAULT_IDLE_FACTOR;
        const ranges = cuts.map((c) => ({ ...c, factor }));
        const removedSec = Number((speedUp ? rangesSavedSec(ranges) : cuts.reduce((s, c) => s + (c.end - c.start), 0)).toFixed(2));
        const summary = {
          cuts,
          ...(speedUp ? { action: "speed", factor } : {}),
          removedSec,
          originalSec: Number(duration.toFixed(2)),
          newDurationSec: Number((duration - removedSec).toFixed(2)),
          idleRule: rule,
        };
        if (args.dryRun || cuts.length === 0) {
          return okResponse({ ...summary, ...(cuts.length === 0 ? { note: "No idle stretches found; nothing to cut." } : { dryRun: true }) });
        }
        const ext = editOutputExt(args.input);
        const output = editOutput(args.output, "trimmed-idle", ext, { overwrite: args.overwrite });
        const ffArgs = speedUp
          ? buildSpeedRangesArgs(args.input, output, ranges, { withAudio: hasAudio, fps: info.fps })
          : buildCutIdleArgs(args.input, output, cuts, hasAudio);
        await runEditJob(ffArgs, {
          output,
          durationSec: duration - removedSec,
          inputDurationSec: duration,
          extra,
        });
        return okResponse({ outputPath: output, ...summary });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
