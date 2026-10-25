import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpegBuffer, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob, jobTimeoutMs } from "../utils/jobs.js";
import { analysisSize } from "../utils/diff.js";
import {
  keyframesToViews,
  buildZoomArgs,
  planAutoZoom,
  buildAnalysisArgs,
  DEFAULT_TRANSITION_SEC,
  DEFAULT_AUTO_MAX_ZOOM,
  MAX_ZOOM,
  type ZoomKeyframe,
} from "../utils/zoom.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const keyframe = z.object({
  t: z.number().nonnegative().describe("Seconds: the view is fully reached at this time."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  full: z.boolean().optional().describe("Zoom back out to the whole frame."),
});

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  keyframes: z
    .array(keyframe)
    .max(100)
    .optional()
    .describe(
      "Views to animate between: each fills the frame with a source rectangle (x, y, width, height) " +
        "by time t, or { t, full: true } to zoom out. Omit to plan them automatically from where the screen changes.",
    ),
  transitionSec: z
    .number()
    .positive()
    .max(5)
    .optional()
    .describe(`How long each zoom/pan eases (default ${DEFAULT_TRANSITION_SEC}).`),
  maxZoom: z
    .number()
    .min(1)
    .max(MAX_ZOOM)
    .optional()
    .describe(`Auto mode: the furthest it zooms in (default ${DEFAULT_AUTO_MAX_ZOOM}).`),
  holdSec: z.number().positive().max(30).optional().describe("Auto mode: stay zoomed this long after activity stops (default 2)."),
  dryRun: z.boolean().optional().describe("Only return the planned keyframes (edit them and pass them back); write nothing."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "zoom",
    "Smooth animated zoom-and-pan, Screen Studio style: zoom into where the action is and back " +
      "out. Give keyframes (rectangles by time), or let it plan them from where the screen " +
      "changes. dryRun returns the plan so it can be adjusted. Returns the output path.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const info = await probeMedia(args.input);
        const { width: W, height: H, durationSec } = info;
        if (!W || !H) throw new ScreencastError(`Could not read the size of ${args.input}.`);
        const fps = info.fps ?? 30;
        const transition = args.transitionSec ?? DEFAULT_TRANSITION_SEC;

        let keyframes = args.keyframes as ZoomKeyframe[] | undefined;
        const planned = !keyframes;
        if (!keyframes) {
          const size = analysisSize(W, H);
          const step = 0.25;
          const raw = await runFfmpegBuffer(buildAnalysisArgs(args.input, size, step), jobTimeoutMs(durationSec));
          const frameBytes = size.width * size.height;
          const frames: Uint8Array[] = [];
          for (let o = 0; o + frameBytes <= raw.length; o += frameBytes) frames.push(raw.subarray(o, o + frameBytes));
          keyframes = planAutoZoom(frames, size.width, size.height, W, H, {
            step,
            holdSec: args.holdSec,
            maxZoom: args.maxZoom,
            transition,
          });
          if (keyframes.length === 0) {
            return okResponse({ keyframes: [], note: "No localised changes found to zoom into; nothing written." });
          }
        }
        if (args.dryRun) return okResponse({ planned, keyframes, transitionSec: transition });

        const views = keyframesToViews(keyframes, W, H);
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `zoom-${stamp()}-${rand()}${ext}`, args.overwrite);
        await runEditJob(buildZoomArgs(args.input, output, views, { width: W, height: H, fps }, transition), {
          output,
          durationSec,
          extra,
        });
        return okResponse({ outputPath: output, planned, keyframes });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
