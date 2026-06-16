import { z } from "zod";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildTitleCardArgs } from "../utils/produce.js";
import { bundledFontPath } from "../utils/fonts.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

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
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "title_card",
    "Generate a standalone title card: centered text on a solid background, with " +
      "a silent audio track so it composes with audio-bearing clips (use " +
      "assemble_highlights to stitch it in). Text is rendered with a bundled " +
      "font, so no system font is required.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        const editsDir = subdir("edits");
        const output = resolveOutput(args.output, editsDir, `title-${stamp()}-${rand()}.mp4`);
        const fontFile = bundledFontPath(args.bold === false ? "regular" : "bold");
        // Write the text to a temp file so arbitrary content (quotes, colons,
        // percent signs) needs no inline filtergraph escaping.
        const textFile = join(editsDir, `.title-${stamp()}-${rand()}.txt`);
        writeFileSync(textFile, args.text);
        try {
          const ffArgs = buildTitleCardArgs(textFile, fontFile, output, {
            duration: args.duration,
            width: args.width,
            height: args.height,
            fps: args.fps,
            bg: args.bg,
            fontColor: args.fontColor,
            fontSize: args.fontSize,
          });
          await runFfmpeg(ffArgs, 5 * 60_000);
        } finally {
          rmSync(textFile, { force: true });
        }
        return okResponse({ outputPath: output });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
