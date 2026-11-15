import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { probeMedia, requireFfmpeg, runFfmpeg, runFfmpegBuffer, runFfmpegFrames } from "../utils/ffmpeg.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { buildScreenshotArgs } from "../utils/targets.js";
import {
  detectionSize,
  targetSize,
  buildRawFrameArgs,
  buildRawStreamArgs,
  targetDiffOptions,
  DEFAULT_PIXEL_THRESHOLD,
} from "../utils/diff.js";
import { waitLoop } from "../utils/waitLoop.js";
import { textWaitLoop } from "../utils/textWait.js";
import { captureStill } from "../utils/still.js";
import { findMatches, MAX_QUERY_LENGTH } from "../utils/ocr.js";
import { readFrames } from "../utils/ocrScan.js";
import { FrameQueue } from "../utils/frameQueue.js";
import { windowMatchReport } from "../utils/windows.js";
import { confirmCapture, describeTarget } from "../utils/consent.js";
import { subdir, stamp, rand } from "../utils/paths.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";

const inputSchema = {
  target: z
    .string()
    .describe("What to watch: full | monitor:<i> | window:<title> (or exe=/hwnd=) | region:<x>,<y>,<w>,<h>."),
  exactTitle: z.boolean().optional().describe("window: targets match the whole title only (default false)."),
  mode: z
    .enum(["change", "settle", "text"])
    .optional()
    .describe(
      "change (default): return once it differs from the start. settle: once it has been still for settleSec. " +
        "text: once text appears (OCR, re-read only after a change).",
    ),
  text: z.string().min(1).max(MAX_QUERY_LENGTH).optional().describe("Mode text: what to wait for; tolerates OCR misreads."),
  regex: z.boolean().optional().describe("Mode text: text is a regex."),
  gone: z.boolean().optional().describe("Mode text: wait until it disappears instead."),
  backend: z
    .enum(["gdigrab", "wgc"])
    .optional()
    .describe("wgc: watch a window even when covered (window: targets; 1-2 s per check)."),
  timeoutSec: z
    .number()
    .positive()
    .max(600)
    .optional()
    .describe("Give up after this many seconds (default 30; a timeout is a result, not an error)."),
  settleSec: z
    .number()
    .positive()
    .max(60)
    .optional()
    .describe("Mode settle: seconds of stillness (default 1)."),
  intervalMs: z
    .number()
    .int()
    .min(100)
    .max(5000)
    .optional()
    .describe("Pause between checks in ms (default 250; 1000 with wgc)."),
  pixelThreshold: z
    .number()
    .min(0)
    .max(255)
    .optional()
    .describe(
      `Mean 0-255 difference for a ~32x32 cell to count as changed (default ${DEFAULT_PIXEL_THRESHOLD}).`,
    ),
  returnImage: z
    .boolean()
    .optional()
    .describe("Return the final state inline (default true)."),
  keep: z
    .boolean()
    .optional()
    .describe("Keep the final screenshot on disk and return its path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "wait_for_change",
    {
      title: "Wait for Screen Change",
      description:
        "Wait until part of the screen changes, settles, or shows (or loses) some text, instead of guessing a sleep. Returns the " +
        "elapsed time, changed regions (screenshot pixels; add `origin` for desktop), and the final state.",
      inputSchema,
      outputSchema: looseOutput({
        outcome: z.string(),
        mode: z.string(),
        elapsedSec: z.number(),
        regions: z.array(z.unknown()),
        origin: looseOutput({ x: z.number(), y: z.number() }),
      }),
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        const mode = args.mode ?? "change";
        if ((mode === "text") !== (args.text !== undefined)) {
          throw new ScreencastError('Use text with mode "text", and mode "text" with text.');
        }
        const backend = args.backend ?? "gdigrab";
        const timeoutMs = (args.timeoutSec ?? 30) * 1000;
        const settleMs = (args.settleSec ?? 1) * 1000;
        const interval = args.intervalMs ?? (backend === "wgc" ? 1000 : 250);
        // The target (and a window's rectangle) is resolved once, up front.
        const resolved = await resolveCaptureTarget(args.target, { exactTitle: args.exactTitle, backend });
        const { target, monitors, window } = resolved;
        if (backend === "wgc" && !window?.hwnd) throw new ScreencastError('backend "wgc" watches one window: use a window: target.');
        const until =
          mode === "text"
            ? `"${args.text}" ${args.gone ? "disappears" : "appears"}`
            : mode === "settle" ? "stops changing" : "changes";
        await confirmCapture(
          server,
          `Watch ${describeTarget(args.target, window)} for up to ${timeoutMs / 1000} s, until it ${until}?`,
          extra.signal,
        );
        const work = mkdtempSync(join(tmpdir(), "screencast-wait-"));
        let shots = 0;
        const still = async () => {
          const shot = join(work, `still-${shots++}.png`);
          await captureStill(resolved, shot, backend);
          return shot;
        };
        // gdigrab grabs the target's rectangle. A WGC still is the window's
        // client area, whose size only a first still tells.
        let area = targetSize(target, monitors);
        if (backend === "wgc") {
          try {
            const info = await probeMedia(await still());
            if (!info.width || !info.height) throw new ScreencastError("Could not read the window capture's size.");
            area = { ...(window?.client ?? { x: area.x, y: area.y }), width: info.width, height: info.height };
          } catch (err) {
            rmSync(work, { recursive: true, force: true });
            throw err;
          }
        }
        const size = detectionSize(area.width, area.height);
        const opts = targetDiffOptions(area, size, args.pixelThreshold);

        // gdigrab: one capture for the whole wait, a frame every interval
        // (#292), so the stream sets the pace. wgc: a still per check (#317).
        const frames = new FrameQueue();
        const stop = new AbortController();
        const capture =
          backend === "gdigrab"
            ? runFfmpegFrames(
                buildRawStreamArgs(target, monitors, size, 1000 / interval),
                size.width * size.height,
                (f) => frames.push(f),
                timeoutMs + 60_000,
                { signal: AbortSignal.any([extra.signal, stop.signal]) },
              ).then(
                () => frames.end(),
                (err: unknown) => frames.fail(err),
              )
            : Promise.resolve();
        const grab =
          backend === "gdigrab"
            ? () => frames.next(15_000)
            : async () => {
                const shot = await still();
                try {
                  return await runFfmpegBuffer(buildRawFrameArgs(shot, size), 30_000, { signal: extra.signal });
                } finally {
                  rmSync(shot, { force: true });
                }
              };
        const sleep = backend === "gdigrab" ? async () => {} : undefined;
        let loop: { outcome: string; regions: Array<{ x: number; y: number; width: number; height: number }>; startedAt: number; everChanged?: boolean };
        let textResult: { matches: ReturnType<typeof findMatches>; reads: number } | null = null;
        let endedAt = 0;
        try {
          if (mode === "text") {
            const t = await textWaitLoop({
              grab,
              read: async () => {
                const shot = await still();
                const [frame] = await readFrames([shot], work, extra.signal);
                rmSync(shot, { force: true });
                return frame ? findMatches(frame.lines, args.text!, args.regex === true) : [];
              },
              width: size.width,
              height: size.height,
              diff: opts,
              timeoutMs,
              intervalMs: interval,
              gone: args.gone === true,
              signal: extra.signal,
              ...(sleep ? { sleep } : {}),
            });
            textResult = { matches: t.matches, reads: t.reads };
            loop = { outcome: t.outcome, regions: t.matches.map(({ x, y, width, height }) => ({ x, y, width, height })), startedAt: t.startedAt };
          } else {
            loop = await waitLoop({
              grab,
              mode,
              width: size.width,
              height: size.height,
              diff: opts,
              timeoutMs,
              settleMs,
              intervalMs: interval,
              signal: extra.signal,
              ...(sleep ? { sleep } : {}),
            });
          }
          endedAt = Date.now();
        } finally {
          stop.abort();
          await capture;
          rmSync(work, { recursive: true, force: true });
        }
        const { outcome, regions, everChanged, startedAt: started } = loop;

        const result: Record<string, unknown> = {
          outcome,
          mode,
          // Up to the loop's end, not the capture's teardown after it.
          elapsedSec: Number(((endedAt - started) / 1000).toFixed(2)),
          ...(mode === "settle" ? { changedWhileWaiting: everChanged } : {}),
          ...(textResult ? { text: args.text, ...(args.gone ? { gone: true } : {}), matches: textResult.matches, ocrReads: textResult.reads } : {}),
          regions,
          origin: { x: area.x, y: area.y },
          ...(backend === "wgc" ? { backend } : {}),
          ...(window ? windowMatchReport(window) : {}),
        };
        const images = [];
        if (args.returnImage !== false && outcome !== "cancelled") {
          // Not kept by default, so screenshots do not pile up on disk (#209).
          const shot = args.keep
            ? join(subdir("screenshots"), `wait-${stamp()}-${rand()}.png`)
            : join(tmpdir(), `screencast-wait-${stamp()}-${rand()}.png`);
          try {
            if (backend === "wgc") await captureStill(resolved, shot, "wgc");
            else await runFfmpeg(buildScreenshotArgs(target, shot, monitors), 60_000, { signal: extra.signal });
            if (args.keep) result.screenshotPath = shot;
            images.push(...(await encodeInlineImages([shot], DEFAULT_MAX_IMAGE_WIDTH, 1)).images);
          } finally {
            if (!args.keep) rmSync(shot, { force: true });
          }
        }
        return okResponse(result, images);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
