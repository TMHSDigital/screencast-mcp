import { z } from "zod";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia, hasFilter } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildBurnSubtitlesArgs, type CaptionStyle } from "../utils/captions.js";
import { bundledFontPath } from "../utils/fonts.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  subtitles: z.string().min(1).describe("Path to an .srt (e.g. from transcribe) or .ass subtitle file."),
  style: z
    .enum(["clean", "social"])
    .optional()
    .describe(
      "'clean' (default for .srt): a modest outlined line. 'social': large bold text on a dark box, for muted " +
        "autoplay. An .ass/.ssa file keeps its own styling unless a style is given.",
    ),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "burn_subtitles",
    {
      title: "Burn In Subtitles",
      description:
        "Burn subtitles (an SRT from transcribe, or any SRT/ASS) permanently into a video, in " +
        "the bundled font, in a clean or social-media style. Returns the output path.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        for (const f of [args.input, args.subtitles]) {
          if (!existsSync(f)) throw new ScreencastError(`File not found: ${f}`);
        }
        if (!hasFilter("subtitles")) {
          throw new ScreencastError("This ffmpeg has no subtitles filter (it needs libass).", "Install a full ffmpeg build, e.g. `winget install Gyan.FFmpeg`.");
        }
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(args.output, subdir("edits"), `subtitled-${stamp()}-${rand()}${ext}`, args.overwrite);
        const fontsDir = dirname(bundledFontPath("regular"));
        const style = (args.style as CaptionStyle | undefined) ?? (/\.(ass|ssa)$/i.test(args.subtitles) ? null : "clean");
        await runEditJob(buildBurnSubtitlesArgs(args.input, args.subtitles, output, fontsDir, style), {
          output,
          durationSec: (await probeMedia(args.input)).durationSec,
          extra,
        });
        return okResponse({ outputPath: output, style: style ?? "file" });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
