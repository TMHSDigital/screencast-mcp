import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpegBuffer, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob, jobTimeoutMs } from "../utils/jobs.js";
import { analysisSize } from "../utils/diff.js";
import {
  keyframesToViews,
  buildZoomArgs,
  planAutoZoom,
  planClickZoom,
  buildAnalysisArgs,
  DEFAULT_TRANSITION_SEC,
  DEFAULT_AUTO_MAX_ZOOM,
  DEFAULT_RING_COLOR,
  MAX_ZOOM,
  type ClickPoint,
  type ZoomKeyframe,
} from "../utils/zoom.js";
import { eventPaths, parseEventsJsonl } from "../utils/events.js";
import { validateColor } from "../utils/validate.js";

/** Most clicks one render will ring; more would make a very long filter graph. */
export const MAX_RINGS = 200;

/** In-frame clicks (mouse down) from an event log, or null if there is none. */
function readClicks(path: string): ClickPoint[] | null {
  if (!existsSync(path)) return null;
  return parseEventsJsonl(readFileSync(path, "utf8"))
    .filter((e) => e.type === "down" && e.inFrame)
    .map((e) => ({ t: e.t, x: e.x, y: e.y }));
}
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

/** One zoom keyframe; shared with pipeline. */
export const zoomKeyframeSchema = z.object({
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
    .array(zoomKeyframeSchema)
    .max(100)
    .optional()
    .describe(
      "Views to animate between: each fills the frame with a source rectangle (x, y, width, height) " +
        "by time t, or { t, full: true } to zoom out. Omit to plan them automatically (see follow).",
    ),
  follow: z
    .enum(["auto", "clicks", "changes"])
    .optional()
    .describe(
      "Without keyframes: clicks zooms toward each click in the recording's input event log " +
        "(start_recording events: true), panning between clicks close together; changes zooms toward " +
        "where the screen changed. auto (default) uses clicks when the log has any, else changes.",
    ),
  events: z
    .string()
    .optional()
    .describe(
      "Event log to read clicks from (default: the input's sibling .events.jsonl). Its times and " +
        "pixels must match the input, so use the original recording, not a trimmed or scaled copy.",
    ),
  highlightClicks: z
    .boolean()
    .optional()
    .describe("Draw an expanding ring at each click from the event log (default false). Rings move with the zoom."),
  highlightColor: z.string().optional().describe("Ring color: name, #RRGGBB, or name@alpha (default #FF4545)."),
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
      "out. Give keyframes (rectangles by time), or let it plan them from the clicks in the " +
      "recording's input event log or from where the screen changes. highlightClicks rings each " +
      "click. dryRun returns the plan so it can be adjusted. Returns the output path.",
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

        const eventsPath = args.events ?? eventPaths(args.input).jsonl;
        const clicks = readClicks(eventsPath);
        if (args.events && !clicks) throw new ScreencastError(`No event log at ${args.events}.`);
        if ((args.follow === "clicks" || args.highlightClicks) && !clicks) {
          throw new ScreencastError(
            `No event log for ${args.input} (looked for ${eventsPath}). Record with start_recording ` +
              "events: true, or pass events: <path to .events.jsonl>.",
          );
        }
        const ringColor = validateColor(args.highlightColor ?? DEFAULT_RING_COLOR, "highlightColor");

        let keyframes = args.keyframes as ZoomKeyframe[] | undefined;
        const planned = !keyframes;
        const follow =
          args.follow === "clicks" || (args.follow !== "changes" && clicks && clicks.length > 0) ? "clicks" : "changes";
        if (!keyframes && follow === "clicks") {
          keyframes = planClickZoom(clicks ?? [], W, H, { holdSec: args.holdSec, maxZoom: args.maxZoom, transition });
          if (keyframes.length === 0) {
            return okResponse({ keyframes: [], follow, note: "The event log has no clicks inside the frame; nothing written." });
          }
        }
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
        if (args.dryRun) {
          return okResponse({ planned, ...(planned ? { follow } : {}), keyframes, transitionSec: transition });
        }
        if (args.highlightClicks && clicks && clicks.length > MAX_RINGS) {
          throw new ScreencastError(`${clicks.length} clicks is more than ${MAX_RINGS} rings; trim the video or the event log first.`);
        }

        const views = keyframesToViews(keyframes, W, H);
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(args.output, subdir("edits"), `zoom-${stamp()}-${rand()}${ext}`, args.overwrite);
        const rings = args.highlightClicks ? { clicks: clicks ?? [], color: ringColor } : undefined;
        await runEditJob(buildZoomArgs(args.input, output, views, { width: W, height: H, fps }, transition, "standard", rings), {
          output,
          durationSec,
          extra,
        });
        return okResponse({
          outputPath: output,
          planned,
          ...(planned ? { follow } : {}),
          keyframes,
          ...(rings ? { ringedClicks: rings.clicks.length } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
