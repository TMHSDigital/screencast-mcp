import { z } from "zod";
import { existsSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
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
  a: z.string().min(1).describe("The 'before' image (or video: its first frame is used)."),
  b: z.string().min(1).describe("The 'after' image (or video). Scaled to a's size if it differs."),
  pixelThreshold: z
    .number()
    .min(0)
    .max(255)
    .optional()
    .describe(
      `How different (0-255 mean) a cell of about 32x32 image pixels must be to count as changed ` +
        `(default ${DEFAULT_PIXEL_THRESHOLD}: catches a changed label or a toast).`,
    ),
  returnImage: z
    .boolean()
    .optional()
    .describe("Also return 'b' inline with the changed regions outlined in red (default true)."),
};

export function register(server: McpServer): void {
  server.tool(
    "screen_diff",
    "Compare two screenshots or frames: returns an SSIM similarity score, the share of the " +
      "image that changed, and bounding boxes of the changed areas in b's pixel coordinates, " +
      "plus b inline with those areas outlined. Use it to check that a UI change happened " +
      "(and only where expected).",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        for (const f of [args.a, args.b]) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const [ia, ib] = await Promise.all([probeMedia(args.a), probeMedia(args.b)]);
        if (!ia.width || !ia.height) throw new ScreencastError(`Could not read the size of ${args.a}.`);
        const size = detectionSize(ia.width, ia.height);
        const [ra, rb, ssimRun] = await Promise.all([
          runFfmpegBuffer(buildRawFrameArgs(args.a, size)),
          runFfmpegBuffer(buildRawFrameArgs(args.b, size)),
          runCapture(requireFfmpeg().ffmpeg, buildSsimArgs(args.a, args.b, size), 30_000),
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
            await runFfmpeg(buildHighlightArgs(args.b, diff.regions, highlighted), 30_000);
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
