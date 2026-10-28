import { z } from "zod";
import { existsSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, runCapture, runFfmpeg, runFfmpegBuffer, probeMedia } from "../utils/ffmpeg.js";
import {
  detectionSize,
  diffFrames,
  buildRawFrameArgs,
  buildSsimArgs,
  buildHighlightArgs,
  parseSsim,
  DEFAULT_PIXEL_THRESHOLD,
} from "../utils/diff.js";
import { stamp, rand } from "../utils/paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";

const inputSchema = {
  a: z.string().min(1).describe("Before image (or video: first frame)."),
  b: z.string().min(1).describe("After image (or video); scaled to a's size."),
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
    .describe("Return b inline with changes outlined (default true)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "screen_diff",
    {
      title: "Screen Diff",
      description:
        "Compare two screenshots or frames: SSIM score, changed share, and changed boxes in b's " +
        "pixels, to check a UI change happened only where expected.",
      inputSchema,
      outputSchema: looseOutput({
        identical: z.boolean(),
        ssim: z.number().nullable(),
        meanDiff: z.number(),
        changedFraction: z.number(),
        regions: z.array(z.unknown()),
      }),
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        for (const f of [args.a, args.b]) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const [ia, ib] = await Promise.all([probeMedia(args.a), probeMedia(args.b)]);
        if (!ia.width || !ia.height) throw new ScreencastError(`Could not read the size of ${args.a}.`);
        const size = detectionSize(ia.width, ia.height);
        const [ra, rb, ssimRun] = await Promise.all([
          runFfmpegBuffer(buildRawFrameArgs(args.a, size), 30_000, { signal: extra.signal }),
          runFfmpegBuffer(buildRawFrameArgs(args.b, size), 30_000, { signal: extra.signal }),
          runCapture(requireFfmpeg().ffmpeg, buildSsimArgs(args.a, args.b, size), 30_000, { signal: extra.signal }),
        ]);
        // Map boxes onto b's own pixels so they can be drawn on (and clicked in)
        // b, per axis: b was stretched to a's aspect ratio (#211).
        const diff = diffFrames(ra, rb, size.width, size.height, {
          scaleX: (ib.width ?? ia.width) / size.width,
          scaleY: (ib.height ?? ia.height) / size.height,
          pixelThreshold: args.pixelThreshold,
        });

        const images = [];
        if (args.returnImage !== false) {
          // Only returned inline, so it is not left on disk (#209).
          const highlighted = join(tmpdir(), `screencast-diff-${stamp()}-${rand()}.png`);
          try {
            await runFfmpeg(buildHighlightArgs(args.b, diff.regions, highlighted), 30_000, { signal: extra.signal });
            images.push(...(await encodeInlineImages([highlighted], DEFAULT_MAX_IMAGE_WIDTH, 1)).images);
          } finally {
            rmSync(highlighted, { force: true });
          }
        }
        return okResponse(
          {
            identical: diff.regions.length === 0,
            ssim: parseSsim(ssimRun.stderr),
            meanDiff: Number(diff.meanDiff.toFixed(4)),
            changedFraction: Number(diff.changedFraction.toFixed(4)),
            regions: diff.regions,
            ...(ib.width !== ia.width || ib.height !== ia.height
              ? { note: `b (${ib.width}x${ib.height}) was compared at a's size (${ia.width}x${ia.height}).` }
              : {}),
          },
          images,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
