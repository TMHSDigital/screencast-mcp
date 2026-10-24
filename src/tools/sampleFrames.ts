import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import {
  buildSampleByFpsArgs,
  buildSampleAtTimestampArgs,
} from "../utils/media.js";
import { subdir, stamp, rand } from "../utils/paths.js";
import {
  encodeInlineImages,
  clampInlineCount,
  DEFAULT_MAX_IMAGE_WIDTH,
  DEFAULT_MAX_INLINE_IMAGES,
  MAX_INLINE_IMAGES,
} from "../utils/images.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video file."),
  fps: z
    .number()
    .positive()
    .optional()
    .describe("Sample this many frames per second. Mutually exclusive with timestamps."),
  timestamps: z
    .array(z.number().nonnegative())
    .optional()
    .describe("Explicit second offsets to grab one frame at each. Mutually exclusive with fps."),
  outputDir: z
    .string()
    .optional()
    .describe("Optional folder for the frames. Defaults to SCREENCAST_HOME/frames/<id>."),
  returnImages: z
    .boolean()
    .optional()
    .describe(
      "Also return the frames inline as images the model can view directly " +
        "(default true). Only the first maxInlineImages frames are embedded.",
    ),
  maxInlineImages: z
    .number()
    .int()
    .min(0)
    .max(MAX_INLINE_IMAGES)
    .optional()
    .describe(
      `How many frames to embed inline (default ${DEFAULT_MAX_INLINE_IMAGES}, max ${MAX_INLINE_IMAGES}). ` +
        "Every frame is still written to disk and listed by path.",
    ),
  maxImageWidth: z
    .number()
    .int()
    .min(16)
    .optional()
    .describe(`Downscale inline images to at most this width (default ${DEFAULT_MAX_IMAGE_WIDTH}).`),
};

export function register(server: McpServer): void {
  server.tool(
    "sample_frames",
    "Sample frames from a video so the agent can actually view what happened: " +
      "either at a fixed rate (fps) or at explicit timestamps. Writes PNG frames " +
      "to a folder and returns their paths, plus the first few frames inline so " +
      "the model can view them directly (disable with returnImages: false).",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const hasFps = args.fps !== undefined;
        const hasTs = args.timestamps !== undefined && args.timestamps.length > 0;
        if (hasFps === hasTs) {
          throw new ScreencastError(
            "Provide exactly one of: fps (fixed rate) or timestamps (explicit offsets).",
          );
        }

        const dir = args.outputDir ?? join(subdir("frames"), `sample-${stamp()}-${rand()}`);
        mkdirSync(dir, { recursive: true });

        let frames: string[] = [];
        const skipped: number[] = [];
        if (hasFps) {
          const isPng = (f: string) => f.endsWith(".png");
          // Snapshot any pre-existing PNGs so a reused outputDir does not
          // contaminate the result; return only the frames this run wrote.
          const before = new Set(readdirSync(dir).filter(isPng));
          const pattern = join(dir, "frame_%05d.png");
          await runFfmpeg(buildSampleByFpsArgs(args.input, args.fps!, pattern), 5 * 60_000);
          frames = readdirSync(dir)
            .filter(isPng)
            .filter((f) => !before.has(f))
            .sort()
            .map((f) => join(dir, f));
        } else {
          const ts = args.timestamps!;
          for (let i = 0; i < ts.length; i++) {
            const out = join(dir, `frame_${String(i).padStart(3, "0")}_${ts[i]}s.png`);
            // Clear any stale file at this path (reused outputDir) so existence
            // after the run reflects only what this invocation wrote.
            rmSync(out, { force: true });
            await runFfmpeg(buildSampleAtTimestampArgs(args.input, ts[i], out), 60_000);
            // A timestamp past the end of the video makes ffmpeg exit 0 without
            // writing a file. Report only frames that actually exist (#35).
            if (existsSync(out)) frames.push(out);
            else skipped.push(ts[i]);
          }
        }

        const inline =
          args.returnImages === false
            ? { images: [], omitted: 0 }
            : await encodeInlineImages(
                frames,
                args.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH,
                clampInlineCount(args.maxInlineImages),
              );

        return okResponse(
          {
            frameDir: dir,
            frameCount: frames.length,
            frames,
            mode: hasFps ? `fps=${args.fps}` : `timestamps=[${args.timestamps!.join(", ")}]`,
            inlineImages: inline.images.length,
            ...(inline.omitted > 0
              ? {
                  inlineNote:
                    `Embedded the first ${inline.images.length} of ${frames.length} frames inline; ` +
                    `the other ${inline.omitted} are on disk at the listed paths.`,
                }
              : {}),
            ...(skipped.length > 0
              ? {
                  skippedTimestamps: skipped,
                  note:
                    `No frame was written for ${skipped.length} timestamp(s) past the ` +
                    `end of the video: [${skipped.join(", ")}].`,
                }
              : {}),
          },
          inline.images,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
