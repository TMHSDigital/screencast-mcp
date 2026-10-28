import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { planPipeline, MAX_PIPELINE_STEPS, type PipelineStep } from "../utils/pipeline.js";
import { calloutFonts, prepareCalloutAssets } from "../utils/calloutAssets.js";
import { exportAnimation } from "../utils/animExport.js";
import type { CalloutAssets } from "../utils/callout.js";
import { calloutItemSchema, fontFileSchema } from "./callout.js";
import { zoomKeyframeSchema } from "./zoom.js";
import { redactRegionSchema } from "./redactRegion.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { PLATFORMS } from "../utils/produce.js";

const aspect = z.enum(["16:9", "9:16", "1:1", "4:5"]);
const fit = z.enum(["pad", "crop"]).optional();

const step = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("trim"),
    start: z.number().nonnegative(),
    end: z.number().positive().optional(),
    duration: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal("crop"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ op: z.literal("scale"), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }),
  z.object({ op: z.literal("speed"), factor: z.number().positive() }),
  z.object({
    op: z.literal("redact"),
    regions: z.array(redactRegionSchema).min(1),
    style: z.enum(["box", "blur", "pixelate"]).optional(),
    pad: z.number().int().nonnegative().optional(),
    color: z.string().optional(),
  }),
  z.object({ op: z.literal("callout"), items: z.array(calloutItemSchema).min(1).max(50), fontFile: fontFileSchema }),
  z.object({ op: z.literal("reframe"), aspect, fit }),
  z.object({ op: z.literal("zoom"), keyframes: z.array(zoomKeyframeSchema).min(1).max(100), transitionSec: z.number().positive().max(5).optional() }),
  z.object({ op: z.literal("export_preset"), platform: z.enum(PLATFORMS), fit }),
  z.object({
    op: z.literal("export_gif"),
    format: z.enum(["gif", "webp"]).optional(),
    maxBytes: z.number().int().min(10_000).optional(),
    fps: z.number().positive().max(30).optional(),
    width: z.number().int().min(64).max(1920).optional(),
  }),
]);

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  steps: z
    .array(step)
    .min(1)
    .max(MAX_PIPELINE_STEPS)
    .describe(
      "Edits in order, each { op, ...the same options as its tool }: trim, crop, scale, speed, redact " +
        "(redact_region), callout, reframe, zoom (keyframes), and as the last step only export_preset " +
        "or export_gif. Times in a step are on the timeline as it is at that step, after any earlier " +
        "trim or speed change; pixel positions are in the frame as it is at that step.",
    ),
  quality: z.enum(["draft", "standard", "high"]).optional().describe("Encoder preset for an mp4 result (default standard)."),
  dryRun: z.boolean().optional().describe("Return the planned ffmpeg command and output size without running it."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.tool(
    "pipeline",
    "Run several edits as one ffmpeg process: one re-encode and no intermediate files, instead of a " +
      "tool call and a re-encode per edit. Steps use the same options as the standalone tools " +
      "(trim, crop, scale, speed, redact, callout, reframe, zoom) and may end with export_preset or " +
      "export_gif. The same steps can be saved and re-run on another recording. dryRun returns the plan.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const steps = args.steps as PipelineStep[];
        const info = await probeMedia(args.input);
        if (!info.width || !info.height) throw new ScreencastError(`Could not read the size of ${args.input}.`);
        const src = {
          width: info.width,
          height: info.height,
          fps: info.fps ?? 30,
          durationSec: info.durationSec,
          hasAudio: info.audioCodec !== null,
        };
        const last = steps[steps.length - 1];
        const ext = last.op === "export_gif" ? `.${last.format ?? "gif"}` : ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `pipeline-${stamp()}-${rand()}${ext}`, args.overwrite);

        const work = mkdtempSync(join(tmpdir(), "screencast-pipeline-"));
        try {
          // Callout text and arrow files; a dry run plans with placeholder paths.
          // Fonts are chosen either way, so a dry run reports missing glyphs too (#231).
          const assets: Record<number, CalloutAssets> = {};
          const fallbackFonts: Array<{ step: number; item: number; fontFile: string }> = [];
          const warnings: string[] = [];
          for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (s.op !== "callout") continue;
            const a = args.dryRun
              ? { fontFile: "<font>", textFiles: s.items.map((c) => (c.type === "text" ? "<text>" : null)), arrowFiles: s.items.map((c) => (c.type === "arrow" ? "<arrow.png>" : null)), ...calloutFonts(s.items, s.fontFile) }
              : await prepareCalloutAssets(s.items, work, `s${i}_`, s.fontFile);
            assets[i] = a;
            fallbackFonts.push(...a.fallbackFonts.map((f) => ({ step: i, ...f })));
            warnings.push(...a.warnings.map((w) => `Step ${i}, ${w.charAt(0).toLowerCase()}${w.slice(1)}`));
          }
          // An export_gif tail renders to a temporary mp4 first; a dry run names it plainly.
          const target = last.op === "export_gif" ? (args.dryRun ? "<temporary stage1.mp4>" : join(work, "stage1.mp4")) : output;
          const plan = planPipeline(args.input, target, steps, src, assets, args.quality ?? "standard");
          const result = {
            steps: plan.summary,
            processes: plan.gif ? 2 : 1,
            width: plan.width,
            height: plan.height,
            durationSec: plan.durationSec,
            ...(fallbackFonts.length > 0 && { fallbackFonts }),
            ...(warnings.length > 0 && { warnings }),
          };
          if (args.dryRun) return okResponse({ dryRun: true, ...result, ffmpegArgs: plan.args });

          // The timeout follows the input ffmpeg decodes, not the (maybe sped-up) output (#237).
          await runEditJob(plan.args, { output: target, durationSec: plan.durationSec, inputDurationSec: info.durationSec, extra });
          if (plan.gif) {
            const anim = await exportAnimation(target, output, plan.gif, extra);
            return okResponse({ outputPath: output, ...result, animation: anim });
          }
          return okResponse({ outputPath: output, ...result });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
