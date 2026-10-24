import { z } from "zod";
import { extname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildArrowImageArgs, buildCalloutArgs, type Callout } from "../utils/callout.js";
import { bundledFontPath } from "../utils/fonts.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const timing = {
  from: z.number().nonnegative().optional().describe("Show from this second (default: start)."),
  to: z.number().positive().optional().describe("Hide after this second (default: end)."),
  color: z.string().optional().describe("Color name, #RRGGBB, or name@alpha."),
};

const item = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("box"),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    thickness: z.number().positive().optional().describe("Outline px (default 4)."),
    fill: z.boolean().optional().describe("Fill instead of outline."),
    ...timing,
  }),
  z.object({
    type: z.literal("text"),
    x: z.number(),
    y: z.number(),
    text: z.string().min(1),
    size: z.number().positive().optional().describe("Font size px (default 32)."),
    background: z.boolean().optional().describe("Dark panel behind the text (default true)."),
    ...timing,
  }),
  z.object({
    type: z.literal("arrow"),
    x1: z.number().describe("Tail x."),
    y1: z.number().describe("Tail y."),
    x2: z.number().describe("Head x: the point the arrow points at."),
    y2: z.number().describe("Head y."),
    thickness: z.number().positive().optional().describe("Shaft px (default 8)."),
    ...timing,
  }),
]);

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  items: z
    .array(item)
    .min(1)
    .max(50)
    .describe(
      "Annotations, drawn in order (later on top). Each is a box, a text label, or an arrow, " +
        "shown between from and to (seconds). Coordinates are video pixels.",
    ),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "callout",
    "Annotate a video with timed boxes, text labels, and arrows (e.g. 'click here', a box " +
      "around the bug), each shown between two timestamps. Returns the output path.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const items = args.items as Callout[];
        const ext = extname(args.input) || ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `callout-${stamp()}-${rand()}${ext}`, args.overwrite);
        // Text files and rendered arrows live in a private temp dir.
        const work = mkdtempSync(join(tmpdir(), "screencast-callout-"));
        try {
          const textFiles = items.map((c, i) => {
            if (c.type !== "text") return null;
            const f = join(work, `text_${i}.txt`);
            writeFileSync(f, c.text);
            return f;
          });
          const arrowFiles: Array<string | null> = [];
          for (let i = 0; i < items.length; i++) {
            const c = items[i];
            if (c.type !== "arrow") {
              arrowFiles.push(null);
              continue;
            }
            const f = join(work, `arrow_${i}.png`);
            await runFfmpeg(buildArrowImageArgs(c, f), 30_000);
            arrowFiles.push(f);
          }
          const ffArgs = buildCalloutArgs(args.input, output, items, {
            fontFile: bundledFontPath("bold"),
            textFiles,
            arrowFiles,
          });
          await runEditJob(ffArgs, { output, durationSec: await probeDuration(args.input), extra });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
        return okResponse({ outputPath: output, callouts: items.length });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
