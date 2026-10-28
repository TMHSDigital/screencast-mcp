import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildCalloutArgs, type Callout } from "../utils/callout.js";
import { prepareCalloutAssets } from "../utils/calloutAssets.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const timing = {
  from: z.number().nonnegative().optional(),
  to: z.number().positive().optional(),
  color: z.string().optional(),
};

/** Explicit font for drawn text (#231); shared with pipeline and title_card. */
export const fontFileSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Font: a .ttf/.otf/.ttc path or a C:\\Windows\\Fonts file name. Default: bundled Inter, with a " +
      "covering system font for scripts it lacks (CJK, emoji, Arabic, ...).",
  );

/** One callout; shared with pipeline. */
export const calloutItemSchema = z.discriminatedUnion("type", [
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
    x1: z.number(),
    y1: z.number(),
    x2: z.number().describe("Head (x2,y2) is the point the arrow points at."),
    y2: z.number(),
    thickness: z.number().positive().optional().describe("Shaft px (default 8)."),
    ...timing,
  }),
]);

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  items: z
    .array(calloutItemSchema)
    .min(1)
    .max(50)
    .describe(
      "Boxes, text labels, and arrows, drawn in order (later on top), in video pixels. Each shows " +
        "from..to seconds (default: whole video); color is a name, #RRGGBB, or name@alpha.",
    ),
  fontFile: fontFileSchema,
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "callout",
    {
      title: "Add Callouts",
      description:
        "Annotate a video with timed boxes, text labels, and arrows. Fallback fonts used are listed in " +
        "fallbackFonts; characters no font covers are reported in warnings.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const items = args.items as Callout[];
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(args.output, subdir("edits"), `callout-${stamp()}-${rand()}${ext}`, args.overwrite);
        // Text files and rendered arrows live in a private temp dir.
        const work = mkdtempSync(join(tmpdir(), "screencast-callout-"));
        try {
          const assets = await prepareCalloutAssets(items, work, "", args.fontFile);
          const ffArgs = buildCalloutArgs(args.input, output, items, assets);
          await runEditJob(ffArgs, { output, durationSec: await probeDuration(args.input), extra });
          return okResponse({
            outputPath: output,
            callouts: items.length,
            ...(assets.fallbackFonts.length > 0 && { fallbackFonts: assets.fallbackFonts }),
            ...(assets.warnings.length > 0 && { warnings: assets.warnings }),
          });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
