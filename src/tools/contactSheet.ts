import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, runCapture, probeMedia } from "../utils/ffmpeg.js";
import { jobTimeoutMs } from "../utils/jobs.js";
import {
  buildSceneScanArgs,
  parseSceneScan,
  pickSceneFrames,
  DEFAULT_SCENE_THRESHOLD,
} from "../utils/media.js";
import {
  evenTimes,
  formatTimecode,
  sheetGrid,
  buildTileArgs,
  buildSheetArgs,
  buildPosterArgs,
  DEFAULT_SHEET_COUNT,
  MAX_SHEET_COUNT,
  DEFAULT_TILE_WIDTH,
} from "../utils/sheet.js";
import { bundledFontPath } from "../utils/fonts.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_SHEET_COUNT)
    .optional()
    .describe(`How many frames to tile (default ${DEFAULT_SHEET_COUNT}, max ${MAX_SHEET_COUNT}).`),
  mode: z
    .enum(["even", "scenes"])
    .optional()
    .describe(
      "'even' spreads frames evenly across the video (default); 'scenes' uses the " +
        "opening frame plus the strongest scene changes, so static stretches take no tiles.",
    ),
  sceneThreshold: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe(`Mode 'scenes': how much a frame must change to count (default ${DEFAULT_SCENE_THRESHOLD}).`),
  columns: z.number().int().min(1).max(12).optional().describe("Tiles per row (default: roughly square)."),
  tileWidth: z
    .number()
    .int()
    .min(64)
    .max(1920)
    .optional()
    .describe(`Width of each tile in px (default ${DEFAULT_TILE_WIDTH}).`),
  poster: z
    .boolean()
    .optional()
    .describe(
      "Instead of a sheet, write one representative poster frame (ffmpeg's thumbnail " +
        "filter over 30 candidates spread across the video), e.g. for a video thumbnail.",
    ),
  output: z.string().optional().describe("Optional output .png path. Defaults under SCREENCAST_HOME/frames."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
  returnImage: z
    .boolean()
    .optional()
    .describe("Also return the sheet inline as an image the model can view directly (default true)."),
  maxImageWidth: z
    .number()
    .int()
    .min(16)
    .optional()
    .describe(`Downscale the inline image to at most this width (default ${DEFAULT_MAX_IMAGE_WIDTH}).`),
};

export function register(server: McpServer): void {
  server.tool(
    "contact_sheet",
    "Tile timestamped frames of a video into ONE image, so the agent can see a whole " +
      "recording in a single look: evenly spaced, or at the scene changes. Returns the " +
      "image path and the sheet inline. poster: true writes a single representative " +
      "frame instead.",
    inputSchema,
    async (args) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const { durationSec } = await probeMedia(args.input);
        if (durationSec === null) throw new ScreencastError(`Could not read duration of ${args.input}.`);
        const kind = args.poster ? "poster" : "sheet";
        const output = resolveOutput(
          args.output,
          subdir("frames"),
          `${kind}-${stamp()}-${rand()}.png`,
          args.overwrite,
        );
        const tileWidth = args.tileWidth ?? DEFAULT_TILE_WIDTH;

        let result: Record<string, unknown>;
        if (args.poster) {
          await runFfmpeg(buildPosterArgs(args.input, durationSec, output, Math.max(tileWidth, 1280)), jobTimeoutMs(durationSec));
          result = { outputPath: output, poster: true };
        } else {
          const count = args.count ?? DEFAULT_SHEET_COUNT;
          let times: number[];
          if (args.mode === "scenes") {
            const scan = await runCapture(
              ffmpeg,
              buildSceneScanArgs(args.input, args.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD),
              jobTimeoutMs(durationSec),
            );
            if (scan.code !== 0) {
              throw new ScreencastError(`Scene scan failed (exit ${scan.code}): ${scan.stderr.trim().slice(-400)}`);
            }
            times = pickSceneFrames(parseSceneScan(scan.stdout), count);
          } else {
            times = evenTimes(durationSec, count);
          }
          const grid = sheetGrid(times.length, args.columns);
          // Tiles and their label files live in a private temp dir, removed
          // whatever happens.
          const work = mkdtempSync(join(tmpdir(), "screencast-sheet-"));
          try {
            const font = bundledFontPath("bold");
            for (let i = 0; i < times.length; i++) {
              const labelFile = join(work, `label_${i}.txt`);
              writeFileSync(labelFile, formatTimecode(times[i]));
              const tile = join(work, `tile_${String(i).padStart(3, "0")}.png`);
              await runFfmpeg(buildTileArgs(args.input, times[i], tile, tileWidth, font, labelFile), 60_000);
            }
            await runFfmpeg(buildSheetArgs(join(work, "tile_%03d.png"), grid, output), 60_000);
          } finally {
            rmSync(work, { recursive: true, force: true });
          }
          result = {
            outputPath: output,
            mode: args.mode ?? "even",
            frameTimes: times,
            columns: grid.columns,
            rows: grid.rows,
          };
        }

        const images =
          args.returnImage === false
            ? []
            : (await encodeInlineImages([output], args.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH, 1)).images;
        return okResponse({ ...result, inlineImages: images.length }, images);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
