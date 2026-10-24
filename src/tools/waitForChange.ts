import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, runFfmpegBuffer } from "../utils/ffmpeg.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { buildScreenshotArgs } from "../utils/targets.js";
import {
  analysisSize,
  targetSize,
  diffFrames,
  buildRawGrabArgs,
  DEFAULT_PIXEL_THRESHOLD,
  type Rect,
} from "../utils/diff.js";
import { windowMatchReport } from "../utils/windows.js";
import { subdir, stamp, rand } from "../utils/paths.js";
import { join } from "node:path";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";

const inputSchema = {
  target: z
    .string()
    .describe("What to watch: 'full' | 'monitor:<index>' | 'window:<title>' | 'region:<x>,<y>,<w>,<h>'."),
  exactTitle: z.boolean().optional().describe("For window: targets, match the title exactly (default false)."),
  mode: z
    .enum(["change", "settle"])
    .optional()
    .describe(
      "'change' (default) returns as soon as the target differs from when the call started " +
        "(a dialog opened, a page responded). 'settle' returns once the target has stopped " +
        "changing for settleSec (a build finished, a page finished loading).",
    ),
  timeoutSec: z
    .number()
    .positive()
    .max(600)
    .optional()
    .describe("Give up after this many seconds (default 30). A timeout is a normal result, not an error."),
  settleSec: z
    .number()
    .positive()
    .max(60)
    .optional()
    .describe("Mode 'settle': how long the screen must stay still (default 1)."),
  intervalMs: z
    .number()
    .int()
    .min(100)
    .max(5000)
    .optional()
    .describe("Pause between checks in ms (default 250); each check itself takes ~0.2 s."),
  pixelThreshold: z
    .number()
    .min(0)
    .max(255)
    .optional()
    .describe(`How different an 8 px cell must be to count as changed (default ${DEFAULT_PIXEL_THRESHOLD}).`),
  returnImage: z
    .boolean()
    .optional()
    .describe("Also return a screenshot of the final state inline (default true)."),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function register(server: McpServer): void {
  server.tool(
    "wait_for_change",
    "Watch part of the screen and return when it changes (mode 'change') or when it has " +
      "stopped changing (mode 'settle'), instead of guessing a sleep. Reports how long it " +
      "took, where the screen changed, and the final state as an inline screenshot.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        const mode = args.mode ?? "change";
        const timeoutMs = (args.timeoutSec ?? 30) * 1000;
        const settleMs = (args.settleSec ?? 1) * 1000;
        const interval = args.intervalMs ?? 250;
        // The target (and a window's rectangle) is resolved once, up front.
        const { target, monitors, window } = await resolveCaptureTarget(args.target, { exactTitle: args.exactTitle });
        const area = targetSize(target, monitors);
        const size = analysisSize(area.width, area.height);
        const grab = () => runFfmpegBuffer(buildRawGrabArgs(target, monitors, size), 15_000);
        const opts = { scale: area.width / size.width, origin: { x: area.x, y: area.y }, pixelThreshold: args.pixelThreshold };

        const started = Date.now();
        const baseline = await grab();
        let previous = baseline;
        let lastChangeAt = started;
        let everChanged = false;
        let regions: Rect[] = [];
        let outcome: "changed" | "settled" | "timeout" | "cancelled" = "timeout";

        while (Date.now() - started < timeoutMs) {
          if (extra.signal.aborted) {
            outcome = "cancelled";
            break;
          }
          await sleep(interval);
          const current = await grab();
          if (mode === "change") {
            const d = diffFrames(baseline, current, size.width, size.height, opts);
            if (d.regions.length > 0) {
              regions = d.regions;
              outcome = "changed";
              break;
            }
          } else {
            const d = diffFrames(previous, current, size.width, size.height, opts);
            if (d.regions.length > 0) {
              everChanged = true;
              lastChangeAt = Date.now();
              regions = d.regions;
            } else if (Date.now() - lastChangeAt >= settleMs) {
              outcome = "settled";
              break;
            }
            previous = current;
          }
        }

        const result: Record<string, unknown> = {
          outcome,
          mode,
          elapsedSec: Number(((Date.now() - started) / 1000).toFixed(2)),
          ...(mode === "settle" ? { changedWhileWaiting: everChanged } : {}),
          regions,
          ...(window ? windowMatchReport(window) : {}),
        };
        const images = [];
        if (args.returnImage !== false && outcome !== "cancelled") {
          const shot = join(subdir("screenshots"), `wait-${stamp()}-${rand()}.png`);
          await runFfmpeg(buildScreenshotArgs(target, shot, monitors), 60_000);
          result.screenshotPath = shot;
          images.push(...(await encodeInlineImages([shot], DEFAULT_MAX_IMAGE_WIDTH, 1)).images);
        }
        return okResponse(result, images);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
