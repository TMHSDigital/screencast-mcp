import { z } from "zod";
import { writeFileSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildTitleCardArgs, DEFAULT_TITLE_DURATION } from "../utils/produce.js";
import { resolveTextFont } from "../utils/fonts.js";
import { fontFileSchema } from "./callout.js";
import { resolveOutput, subdir, stamp, rand, tempPath } from "../utils/paths.js";

const inputSchema = {
  text: z.string().min(1).describe("Title text. Multiple lines are allowed (use \\n)."),
  duration: z.number().positive().optional().describe("Card length in seconds (default 3)."),
  width: z.number().int().positive().optional().describe("Card width (default 1920)."),
  height: z.number().int().positive().optional().describe("Card height (default 1080)."),
  fps: z.number().int().positive().optional().describe("Card fps (default 30)."),
  bg: z.string().optional().describe("Background color (default black)."),
  fontColor: z.string().optional().describe("Text color (default white)."),
  fontSize: z.number().int().positive().optional().describe("Text size in px (default 96)."),
  bold: z.boolean().optional().describe("Use the bold weight (default true)."),
  fontFile: fontFileSchema,
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "title_card",
    {
      title: "Title Card",
      description:
        "Generate a title card clip (centered text on a solid background, silent audio track) to stitch " +
        "in with assemble_highlights. Uncoverable characters are reported in warnings.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        const output = resolveOutput(args.output, subdir("edits"), `title-${stamp()}-${rand()}.mp4`, args.overwrite);
        const font = resolveTextFont(args.text, { weight: args.bold === false ? "regular" : "bold", fontFile: args.fontFile });
        // Write the text to a temp file so arbitrary content (quotes, colons,
        // percent signs) needs no inline filtergraph escaping.
        const textFile = tempPath(".txt");
        writeFileSync(textFile, args.text);
        try {
          const ffArgs = buildTitleCardArgs(textFile, font.fontFile, output, {
            duration: args.duration,
            width: args.width,
            height: args.height,
            fps: args.fps,
            bg: args.bg,
            fontColor: args.fontColor,
            fontSize: args.fontSize,
          });
          await runEditJob(ffArgs, { output, durationSec: args.duration ?? DEFAULT_TITLE_DURATION, extra });
        } finally {
          rmSync(textFile, { force: true });
        }
        return okResponse({
          outputPath: output,
          ...((font.fallback || args.fontFile) && { fontFile: font.fontFile }),
          ...(font.warning && { warnings: [font.warning] }),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
