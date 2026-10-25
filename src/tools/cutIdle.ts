import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runCapture, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob, jobTimeoutMs } from "../utils/jobs.js";
import {
  buildIdleScanArgs,
  parseFreezes,
  parseSilences,
  intersect,
  cutsFor,
  buildCutIdleArgs,
  DEFAULT_MIN_IDLE_SEC,
  DEFAULT_KEEP_SEC,
} from "../utils/idle.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

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
    .describe(`Keep this much of each stretch at both edges so cuts are not abrupt (default ${DEFAULT_KEEP_SEC}).`),
  useAudio: z
    .boolean()
    .optional()
    .describe(
      "Count a stretch as idle only if the audio is also silent (default true when the video " +
        "has audio). Set false to cut frozen video even while sound plays.",
    ),
  dryRun: z.boolean().optional().describe("Only report the stretches that would be cut; write nothing."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "cut_idle",
    "Remove dead air: cut stretches where the screen is frozen (and, if there is audio, " +
      "silent), keeping a short pad at each edge. Agent recordings are full of these pauses. " +
      "dryRun reports what would be cut first. Returns the output path and the time saved.",
    inputSchema,
    async (args, extra) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const info = await probeMedia(args.input);
        const duration = info.durationSec;
        if (duration === null) throw new ScreencastError(`Could not read duration of ${args.input}.`);
        const minIdle = args.minIdleSec ?? DEFAULT_MIN_IDLE_SEC;
        const keep = args.keepSec ?? DEFAULT_KEEP_SEC;
        const hasAudio = info.audioCodec !== null;
        const useAudio = (args.useAudio ?? true) && hasAudio;

        const scan = await runCapture(ffmpeg, buildIdleScanArgs(args.input, minIdle, useAudio), jobTimeoutMs(duration));
        if (scan.code !== 0) throw new ScreencastError(`Idle scan failed (exit ${scan.code}): ${scan.stderr.trim().slice(-400)}`);
        const freezes = parseFreezes(scan.stderr, duration);
        const idle = useAudio ? intersect(freezes, parseSilences(scan.stderr, duration)) : freezes;
        const cuts = cutsFor(idle, minIdle, keep);
        const removedSec = Number(cuts.reduce((s, c) => s + (c.end - c.start), 0).toFixed(2));
        const summary = {
          cuts,
          removedSec,
          originalSec: Number(duration.toFixed(2)),
          newDurationSec: Number((duration - removedSec).toFixed(2)),
          idleRule: useAudio ? "frozen video and silent audio" : "frozen video",
        };
        if (args.dryRun || cuts.length === 0) {
          return okResponse({ ...summary, ...(cuts.length === 0 ? { note: "No idle stretches found; nothing to cut." } : { dryRun: true }) });
        }
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(args.output, subdir("edits"), `trimmed-idle-${stamp()}-${rand()}${ext}`, args.overwrite);
        await runEditJob(buildCutIdleArgs(args.input, output, cuts, hasAudio), {
          output,
          durationSec: duration - removedSec,
          extra,
        });
        return okResponse({ outputPath: output, ...summary });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
