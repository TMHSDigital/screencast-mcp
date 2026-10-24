import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, runCapture, probeMedia } from "../utils/ffmpeg.js";
import { jobTimeoutMs } from "../utils/jobs.js";
import {
  buildSampleByFpsArgs,
  buildSampleAtTimestampArgs,
  planFpsSampling,
  buildSceneScanArgs,
  parseSceneScan,
  pickSceneFrames,
  DEFAULT_SCENE_THRESHOLD,
  type SceneChange,
  DEFAULT_MAX_FRAMES,
  MAX_FRAMES_CEILING,
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
  mode: z
    .enum(["fps", "timestamps", "scenes"])
    .optional()
    .describe(
      "How to pick frames. 'scenes' returns only frames where the screen changed " +
        "(plus the first frame), strongest changes first up to maxFrames, which is " +
        "usually the cheapest way to review a recording. Defaults to 'fps' or " +
        "'timestamps' depending on which of those is given.",
    ),
  fps: z
    .number()
    .positive()
    .optional()
    .describe("Sample this many frames per second (mode 'fps')."),
  timestamps: z
    .array(z.number().nonnegative())
    .optional()
    .describe("Explicit second offsets to grab one frame at each (mode 'timestamps')."),
  sceneThreshold: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe(
      `Mode 'scenes': how much the frame must change to count, 0-1 (default ${DEFAULT_SCENE_THRESHOLD}; ` +
        "raise it to keep only big changes).",
    ),
  dedupe: z
    .boolean()
    .optional()
    .describe("Mode 'fps': drop frames that are nearly identical to the previous one (default false)."),
  outputDir: z
    .string()
    .optional()
    .describe("Optional folder for the frames. Defaults to SCREENCAST_HOME/frames/<id>."),
  maxFrames: z
    .number()
    .int()
    .min(1)
    .max(MAX_FRAMES_CEILING)
    .optional()
    .describe(
      `Most frames this call may write (default ${DEFAULT_MAX_FRAMES}, max ${MAX_FRAMES_CEILING}). ` +
        "In fps mode a rate that would exceed it is lowered so the frames still span the whole video.",
    ),
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
        const mode = args.mode ?? (hasTs ? "timestamps" : "fps");
        const valid =
          mode === "scenes" ? !hasFps && !hasTs
          : mode === "fps" ? hasFps && !hasTs
          : hasTs && !hasFps;
        if (!valid) {
          throw new ScreencastError(
            "Use exactly one way to pick frames: fps (fixed rate), timestamps " +
              "(explicit offsets), or mode: 'scenes' (with neither fps nor timestamps).",
          );
        }

        const maxFrames = args.maxFrames ?? DEFAULT_MAX_FRAMES;
        if (hasTs && args.timestamps!.length > maxFrames) {
          throw new ScreencastError(
            `${args.timestamps!.length} timestamps exceeds maxFrames (${maxFrames}). ` +
              `Pass fewer timestamps, or raise maxFrames (up to ${MAX_FRAMES_CEILING}).`,
          );
        }
        // Size an fps request against the video's length before writing
        // anything, so a high rate on a long recording cannot fill the disk (#80).
        const durationSec = mode === "timestamps" ? null : (await probeMedia(args.input)).durationSec;
        const plan = mode === "fps" ? planFpsSampling(durationSec, args.fps!, maxFrames) : null;

        // Scenes (#114): a cheap low-res pass finds where the screen changed;
        // the chosen moments are then grabbed at full size like timestamps.
        let scenes: SceneChange[] | null = null;
        let sceneTimes: number[] = [];
        if (mode === "scenes") {
          const { ffmpeg } = requireFfmpeg();
          const scan = await runCapture(
            ffmpeg,
            buildSceneScanArgs(args.input, args.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD),
            jobTimeoutMs(durationSec),
          );
          if (scan.code !== 0) {
            throw new ScreencastError(`Scene scan failed (exit ${scan.code}): ${scan.stderr.trim().slice(-400)}`);
          }
          scenes = parseSceneScan(scan.stdout);
          sceneTimes = pickSceneFrames(scenes, maxFrames);
        }

        const dir = args.outputDir ?? join(subdir("frames"), `sample-${stamp()}-${rand()}`);
        mkdirSync(dir, { recursive: true });

        let frames: string[] = [];
        const skipped: number[] = [];
        if (plan) {
          const isPng = (f: string) => f.endsWith(".png");
          // Snapshot any pre-existing PNGs so a reused outputDir does not
          // contaminate the result; return only the frames this run wrote.
          const before = new Set(readdirSync(dir).filter(isPng));
          const pattern = join(dir, "frame_%05d.png");
          await runFfmpeg(
            buildSampleByFpsArgs(args.input, plan.fps, pattern, maxFrames, args.dedupe === true),
            5 * 60_000,
          );
          frames = readdirSync(dir)
            .filter(isPng)
            .filter((f) => !before.has(f))
            .sort()
            .map((f) => join(dir, f));
        } else {
          const ts = mode === "scenes" ? sceneTimes : args.timestamps!;
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
            mode: plan
              ? `fps=${plan.fps}${args.dedupe ? " (deduped)" : ""}`
              : scenes
                ? `scenes (threshold ${args.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD})`
                : `timestamps=[${args.timestamps!.join(", ")}]`,
            ...(scenes
              ? {
                  frameTimes: sceneTimes,
                  sceneChangesFound: scenes.length,
                  ...(scenes.length + 1 > maxFrames
                    ? {
                        capNote:
                          `Found ${scenes.length} scene changes; kept the opening frame and the ` +
                          `${maxFrames - 1} strongest (maxFrames ${maxFrames}). Raise sceneThreshold ` +
                          "to keep only bigger changes, or raise maxFrames.",
                      }
                    : {}),
                }
              : {}),
            ...(plan?.clamped
              ? {
                  requestedFps: args.fps,
                  capNote:
                    `fps=${args.fps} would write about ${plan.requestedFrames} frames, over ` +
                    `maxFrames (${maxFrames}); sampled at fps=${plan.fps} instead so the ` +
                    `frames still span the whole video. Raise maxFrames or use timestamps for more detail.`,
                }
              : {}),
            ...(plan && !plan.clamped && frames.length >= maxFrames
              ? { capNote: `Stopped at maxFrames (${maxFrames}); the video's length could not be probed in advance.` }
              : {}),
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
