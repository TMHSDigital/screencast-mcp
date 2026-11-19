import { z } from "zod";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { MAX_PIPELINE_STEPS, type AudioMeasurements } from "../utils/pipeline.js";
import { pipelineStepSchema } from "../utils/pipelineStep.js";
import { exportAnimation } from "../utils/animExport.js";
import { RECIPES } from "../utils/recipes.js";
import { sourceStamp, writeEditSpec } from "../utils/editSpec.js";
import { packageVersion } from "../utils/packageRoot.js";
import { addChapters, checkSteps, makePlanner, prepareAssets, resolvePending, resolveRequest, resolveSecrets, scanIdle, writeSidecars, type PipelineRequest } from "../utils/pipelineRun.js";
import { overwriteField, editOutputField } from "../utils/editTool.js";

const inputSchema = {
  input: z.string().min(1).optional().describe("Source video path."),
  fromEdit: z.string().min(1).optional().describe("Re-render an .edit.json; steps replace same-op steps."),
  steps: z
    .array(pipelineStepSchema)
    .max(MAX_PIPELINE_STEPS)
    .optional()
    .describe(
      "Edits in order, each { op, ...its tool's options }; export_preset/export_gif only last. Times " +
        "and pixels are relative to the video as it is at that step (after earlier trims, speed, crops). " +
        "zoom follow:\"clicks\" plans from the event log; burn_subtitles takes subtitles or transcribe:true.",
    ),
  recipe: z
    .enum(RECIPES)
    .optional()
    .describe(
      "Polish preset expanded to steps (see dryRun): pr_demo = cut_idle, click zoom, GIF <=10 MB; tutorial = " +
        "+ audio, captions, 1080p mp4; social_reel = 9:16, big captions. Given steps replace its same-op step; " +
        "trim, redact, crop and cursor go first (source pixels and time).",
    ),
  quality: z.enum(["draft", "standard", "high"]).optional().describe("Encoder preset for an mp4 result (default standard)."),
  dryRun: z.boolean().optional().describe("Return the plan (ffmpeg command, output size) without running it."),
  output: editOutputField,
  overwrite: overwriteField,
  chapters: z
    .boolean()
    .optional()
    .describe("Keep the input's markers as chapters, re-timed through trims and speed."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "pipeline",
    {
      title: "Edit Pipeline",
      description:
        "Run several edits (trim, crop, scale, speed, cut_idle, redact, callout, keystroke_overlay, cursor, reframe, zoom, backdrop, " +
        "audio, burn_subtitles, title_card, music, then optionally export_preset or export_gif) in one ffmpeg pass: one re-encode, no " +
        "intermediate files. Prefer it over chaining edit tools; a recipe does the usual polish in one call.",
      inputSchema,
      outputSchema: looseOutput({ processes: z.number().int(), steps: z.array(z.string()) }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        const dryRun = args.dryRun ?? false;
        const req = await resolveRequest(args);
        const clicks = checkSteps(req.steps, req.input);
        const idle = await scanIdle(ffmpeg, req, extra.signal);
        const steps = await resolveSecrets(req, dryRun, extra.signal);
        const work = mkdtempSync(join(tmpdir(), "screencast-pipeline-"));
        try {
          const assets = await prepareAssets(steps, req, work, dryRun);
          // An export_gif tail renders to a temporary mp4 first; a dry run names it plainly.
          const target = req.gif ? (dryRun ? "<temporary stage1.mp4>" : join(work, "stage1.mp4")) : req.output;
          const measured = { idle, clicks, audio: {} as Record<number, AudioMeasurements>, subtitles: {} as Record<number, string> };
          const planner = makePlanner(steps, req, assets, measured, target);
          // A dry run skips the probes and reports them as measuredOnRun.
          const resolved = dryRun ? { plan: planner() } : await resolvePending(ffmpeg, steps, req, planner, measured, work, extra.signal);
          const { plan, chapters, markers } = req.chapters
            ? await addChapters(resolved.plan, planner, req, work, dryRun, extra.signal)
            : { plan: resolved.plan, chapters: [], markers: [] };
          const result = {
            ...(args.recipe && { recipe: args.recipe, expandedSteps: steps }),
            steps: plan.summary,
            ...(dryRun && plan.pending.length > 0 && { measuredOnRun: plan.pending.map((p) => `step ${p.step + 1}: ${p.kind}`) }),
            processes: plan.gif ? 2 : 1,
            width: plan.width,
            height: plan.height,
            durationSec: plan.durationSec,
            ...(assets.fallbackFonts.length > 0 && { fallbackFonts: assets.fallbackFonts }),
            ...(chapters.length > 0 && { chapters }),
          };
          const warnings = () => (req.warnings.length > 0 ? { warnings: req.warnings } : {});
          if (dryRun) return okResponse({ dryRun: true, ...result, ...warnings(), ffmpegArgs: plan.args });

          for (const f of plan.files) writeFileSync(f.path, f.content);
          // The timeout follows the input ffmpeg decodes, not the (maybe sped-up) output (#237).
          await runEditJob(plan.args, { output: target, durationSec: plan.durationSec, inputDurationSec: req.info.durationSec, extra });
          if (plan.gif) {
            const animation = await exportAnimation(target, req.output, plan.gif, extra);
            return okResponse({ outputPath: req.output, ...result, ...warnings(), animation, ...saveSpec(req) });
          }
          const sidecars = writeSidecars(req, plan, resolved.transcript, markers);
          return okResponse({ outputPath: req.output, ...result, ...warnings(), ...sidecars, ...saveSpec(req) });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}

/** The spec that made this output, for fromEdit (#340); best effort. It keeps
 * the steps as asked (secrets: true, not the regions a scan found), so a
 * re-render scans again instead of doubling. */
function saveSpec(req: PipelineRequest): { editSpecPath?: string } {
  try {
    return {
      editSpecPath: writeEditSpec(req.output, {
        serverVersion: packageVersion(),
        source: sourceStamp(req.input),
        steps: req.steps,
        ...(req.recipe && { recipe: req.recipe }),
        quality: req.quality,
        chapters: req.chapters,
      }),
    };
  } catch {
    return {};
  }
}
