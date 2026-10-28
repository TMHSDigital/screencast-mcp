import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { eventPaths, parseEventsJsonl } from "../utils/events.js";
import {
  buildCursorArgs,
  cursorSpritePath,
  planCursor,
  transformCursor,
  DEFAULT_CURSOR_SIZE,
  DEFAULT_HIDE_AFTER_SEC,
  type CursorPlan,
  type CursorPlanOptions,
} from "../utils/cursor.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

/** Cursor options, undescribed: the pipeline step reuses them as-is, which
 * keeps tools/list small (#214). */
export const cursorOptionsSchema = {
  events: z.string().optional(),
  size: z.number().min(0.25).max(8).optional(),
  smoothing: z.number().min(0).max(1).optional(),
  hideAfterSec: z.number().min(0).max(600).optional(),
  clicks: z.boolean().optional(),
  spotlight: z.boolean().optional(),
};
const o = cursorOptionsSchema;

/** The cursor planned from a recording's event log, on the source's clock. */
export function loadCursor(input: string, events: string | undefined, opts: CursorPlanOptions, endSec: number | null): CursorPlan {
  const path = events ?? eventPaths(input).jsonl;
  if (!existsSync(path)) {
    throw new ScreencastError(
      `No event log for ${input} (looked for ${path}). Record with start_recording cursor: "events" ` +
        "(no OS cursor in the video, events logged), or pass events: <path to .events.jsonl>.",
    );
  }
  const plan = planCursor(parseEventsJsonl(readFileSync(path, "utf8")), opts, endSec);
  if (plan.path.length === 0) throw new ScreencastError(`The event log ${path} has no cursor positions to draw.`);
  return plan;
}

const inputSchema = {
  input: z.string().min(1).describe("Path to the recording."),
  events: o.events.describe("Event log (default: the input's .events.jsonl)."),
  size: o.size.describe(`Times a typical cursor's size (default ${DEFAULT_CURSOR_SIZE}).`),
  smoothing: o.smoothing.describe("0 = as logged, 1 = floaty (default 0.5)."),
  hideAfterSec: o.hideAfterSec.describe(`Hide when the mouse rests this long; 0 = never (default ${DEFAULT_HIDE_AFTER_SEC}).`),
  clicks: o.clicks.describe("Ripple on clicks (default true)."),
  spotlight: o.spotlight.describe("Dim all but the area around the cursor."),
  dryRun: z.boolean().optional().describe("Return the plan; write nothing."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "cursor",
    {
      title: "Re-rendered Cursor",
      description:
        'Draw a smoothed, scaled cursor that hides when idle from the event log of a start_recording cursor: "events" ' +
        "recording (no OS cursor in the video), with click ripples and an optional spotlight.",
      inputSchema,
      outputSchema: looseOutput({ segments: z.number().int() }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const info = await probeMedia(args.input);
        if (!info.width || !info.height) throw new ScreencastError(`Could not read the size of ${args.input}.`);
        const plan = transformCursor(loadCursor(args.input, args.events, args, info.durationSec));
        const summary = {
          segments: plan.path.length,
          clicks: plan.clicks.length,
          shownSec: Math.round(plan.visible.reduce((s, [a, b]) => s + (Math.min(b, info.durationSec ?? b) - a), 0) * 10) / 10,
        };
        if (args.dryRun) return okResponse({ dryRun: true, ...summary, visible: plan.visible });
        assertEditContainer(args.output);
        const output = resolveOutput(args.output, subdir("edits"), `cursor-${stamp()}-${rand()}${editOutputExt(args.input)}`, args.overwrite);
        const work = mkdtempSync(join(tmpdir(), "screencast-cursor-"));
        try {
          const cmdFile = join(work, "cursor.cmd");
          const { args: ffArgs, commands } = buildCursorArgs(
            args.input, output, plan, { size: args.size, clicks: args.clicks, spotlight: args.spotlight },
            { width: info.width, height: info.height }, cursorSpritePath(), cmdFile,
          );
          writeFileSync(cmdFile, commands);
          await runEditJob(ffArgs, { output, durationSec: info.durationSec, extra });
          return okResponse({ outputPath: output, ...summary });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
