import { z } from "zod";
import { basename, dirname, extname, join } from "node:path";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob, probeDuration } from "../utils/jobs.js";
import {
  animLadder,
  nextLadderIndex,
  buildAnimArgs,
  DEFAULT_ANIM_FPS,
  DEFAULT_ANIM_WIDTH,
  DEFAULT_MAX_BYTES,
  MAX_ATTEMPTS,
  type AnimFormat,
  type AnimSettings,
} from "../utils/anim.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  format: z
    .enum(["gif", "webp"])
    .optional()
    .describe("gif (plays everywhere, default) or webp (animated WebP, usually much smaller)."),
  maxBytes: z
    .number()
    .int()
    .min(10_000)
    .optional()
    .describe(
      `File-size budget in bytes (default ${DEFAULT_MAX_BYTES}, under GitHub's 10 MB limit ` +
        "for images). Quality steps down until the file fits.",
    ),
  fps: z.number().positive().max(30).optional().describe(`Starting frame rate (default ${DEFAULT_ANIM_FPS}).`),
  width: z
    .number()
    .int()
    .min(64)
    .max(1920)
    .optional()
    .describe(`Starting width in px (default ${DEFAULT_ANIM_WIDTH}); height follows the aspect ratio.`),
  start: z.number().nonnegative().optional().describe("Start at this many seconds into the video."),
  duration: z.number().positive().optional().describe("Export only this many seconds (default: to the end)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "export_gif",
    "Export a video as an optimized animated GIF or WebP that fits a file-size budget " +
      "(default: GitHub's 10 MB image limit), for PRs, issues, and READMEs. Steps fps, " +
      "width, and palette/quality down until it fits and reports the settings used.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const format: AnimFormat = args.format ?? "gif";
        const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
        const output = resolveOutput(args.output, subdir("edits"), `anim-${stamp()}-${rand()}.${format}`, args.overwrite);
        const full = await probeDuration(args.input);
        const clipSec = args.duration ?? (full !== null ? full - (args.start ?? 0) : null);
        const ladder = animLadder(format, args.fps ?? DEFAULT_ANIM_FPS, args.width ?? DEFAULT_ANIM_WIDTH);

        // Each attempt is its own sibling file so a later, smaller attempt never
        // has to overwrite an earlier one; the winner is renamed onto output.
        const ext = extname(output);
        const attemptPath = (i: number) => join(dirname(output), `${basename(output, ext)}.try${i}${ext}`);
        const attempts: Array<{ path: string; size: number; settings: AnimSettings }> = [];
        try {
          let index: number | null = 0;
          while (index !== null && attempts.length < MAX_ATTEMPTS) {
            const path = attemptPath(attempts.length);
            const clip = { start: args.start, duration: args.duration };
            await runEditJob(buildAnimArgs(args.input, path, format, ladder[index], clip), {
              output: path,
              durationSec: clipSec,
              extra,
            });
            const size = statSync(path).size;
            attempts.push({ path, size, settings: ladder[index] });
            if (size <= maxBytes) break;
            index = nextLadderIndex(index, size, maxBytes, ladder.length);
          }
          const fits = attempts.find((a) => a.size <= maxBytes);
          const chosen = fits ?? attempts.reduce((a, b) => (b.size < a.size ? b : a));
          renameSync(chosen.path, output);
          return okResponse({
            outputPath: output,
            format,
            sizeBytes: chosen.size,
            maxBytes,
            withinBudget: chosen.size <= maxBytes,
            settings: chosen.settings,
            attempts: attempts.map((a) => ({ ...a.settings, sizeBytes: a.size })),
            ...(fits
              ? {}
              : {
                  note:
                    `Could not get under ${maxBytes} bytes; kept the smallest attempt. ` +
                    "Export a shorter clip (start/duration), or try format: 'webp'.",
                }),
          });
        } finally {
          for (const a of attempts) rmSync(a.path, { force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
