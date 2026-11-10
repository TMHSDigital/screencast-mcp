import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import { buildCalloutArgs, type Callout, calloutItemSchema, fontFileSchema } from "../utils/callout.js";
import { prepareCalloutAssets } from "../utils/calloutAssets.js";
import { stillEdit } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video or image (png/jpg; from/to are ignored for an image)."),
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
        "Annotate a video or screenshot with timed boxes, text labels, and arrows. Fallback fonts used are listed in " +
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
        // A png/jpg input is annotated as one image (#319).
        const { still, ext } = stillEdit(args.input, args.output);
        const output = resolveOutput(args.output, subdir("edits"), `callout-${stamp()}-${rand()}${ext}`, args.overwrite);
        // Text files and rendered arrows live in a private temp dir.
        const work = mkdtempSync(join(tmpdir(), "screencast-callout-"));
        try {
          const assets = await prepareCalloutAssets(items, work, "", args.fontFile);
          const ffArgs = buildCalloutArgs(args.input, output, items, assets, undefined, still);
          await runEditJob(ffArgs, { output, durationSec: still ? null : await probeDuration(args.input), extra });
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
