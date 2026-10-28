import { z } from "zod";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia, hasFilter, runCapture, runFfmpeg, scriptLongFilters } from "../utils/ffmpeg.js";
import { jobTimeoutMs, runEditJob } from "../utils/jobs.js";
import { planPipeline, probeArgs, MAX_PIPELINE_STEPS, type AudioMeasurements, type PipelinePending, type PipelineStep } from "../utils/pipeline.js";
import { calloutFonts, prepareCalloutAssets } from "../utils/calloutAssets.js";
import { exportAnimation } from "../utils/animExport.js";
import type { CalloutAssets } from "../utils/callout.js";
import { calloutItemSchema, fontFileSchema } from "./callout.js";
import { readClicks, zoomKeyframeSchema } from "./zoom.js";
import { redactRegionSchema } from "./redactRegion.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { PLATFORMS } from "../utils/produce.js";
import { buildChapters, ffmetadata, markerPoints, markersOrChapters, retimeMarkers, writeMarkers, type Chapter, type Marker } from "../utils/chapters.js";
import type { CursorStepAssets, KeystrokeStepAssets } from "../utils/pipeline.js";
import { cursorOptionsSchema, loadCursor } from "./cursor.js";
import { cursorSpritePath } from "../utils/cursor.js";
import { backdropOptionsSchema } from "./backdrop.js";
import { keystrokeOptionsSchema, loadBadges, prepareKeystrokeAssets } from "./keystrokeOverlay.js";
import { MAX_ZOOM, type ClickPoint } from "../utils/zoom.js";
import { buildIdleScanArgs, intersect, parseFreezes, parseSilences, DEFAULT_MIN_IDLE_SEC } from "../utils/idle.js";
import { buildLoudnessMeasureArgs, buildNoiseFloorArgs, loudnessTarget, parseLoudnorm, parseNoiseFloor } from "../utils/audio.js";
import { buildTranscribeArgs, formatSrt, normalizeCues, parseSrt, resolveWhisperModel } from "../utils/captions.js";
import { eventPaths } from "../utils/events.js";
import { bundledFontPath } from "../utils/fonts.js";
import { retimeAss, retimeCues, type Span } from "../utils/timeline.js";
import { applyOverrides, recipeSteps, RECIPES } from "../utils/recipes.js";

/** Why a recipe cannot transcribe captions here, or null when it can. */
function transcribeBlocker(): string | null {
  if (!hasFilter("whisper")) return "this ffmpeg has no whisper filter (FFmpeg 8 with whisper.cpp).";
  try {
    resolveWhisperModel(undefined);
    return null;
  } catch {
    return "no whisper model (set SCREENCAST_WHISPER_MODEL).";
  }
}

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
  z.object({
    op: z.literal("zoom"),
    keyframes: z.array(zoomKeyframeSchema).min(1).max(100).optional(),
    follow: z.literal("clicks").optional(),
    maxZoom: z.number().min(1).max(MAX_ZOOM).optional(),
    holdSec: z.number().positive().max(30).optional(),
    transitionSec: z.number().positive().max(5).optional(),
  }),
  z.object({ op: z.literal("cut_idle"), minIdleSec: z.number().positive().optional(), keepSec: z.number().min(0).optional() }),
  z.object({
    op: z.literal("audio"),
    normalize: z.union([z.enum(["youtube", "podcast", "broadcast"]), z.number().min(-70).max(-5)]).optional(),
    denoise: z.enum(["light", "medium", "strong"]).optional(),
  }),
  z.object({
    op: z.literal("burn_subtitles"),
    subtitles: z.string().optional(),
    transcribe: z.boolean().optional(),
    style: z.enum(["clean", "social"]).optional(),
  }),
  z.object({ op: z.literal("backdrop"), ...backdropOptionsSchema }),
  z.object({ op: z.literal("keystroke_overlay"), ...keystrokeOptionsSchema }),
  z.object({ op: z.literal("cursor"), ...cursorOptionsSchema }),
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
        "+ audio, captions, 1080p mp4; social_reel = 9:16, big captions. Given steps replace its same-op step.",
    ),
  quality: z.enum(["draft", "standard", "high"]).optional().describe("Encoder preset for an mp4 result (default standard)."),
  dryRun: z.boolean().optional().describe("Return the plan (ffmpeg command, output size) without running it."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
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
        "audio, burn_subtitles, then optionally export_preset or export_gif) in one ffmpeg pass: one re-encode, no " +
        "intermediate files. Prefer it over chaining edit tools; a recipe does the usual polish in one call.",
      inputSchema,
      outputSchema: looseOutput({ processes: z.number().int(), steps: z.array(z.string()) }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const info = await probeMedia(args.input);
        const hasAudio = info.audioCodec !== null;
        const warnings: string[] = [];
        // A recipe (#244) is a list of steps; caller steps override it.
        let steps = (args.steps ?? []) as PipelineStep[];
        if (args.recipe) {
          const logged = readClicks(eventPaths(args.input).jsonl);
          const r = recipeSteps(args.recipe, {
            hasAudio,
            hasClicks: !!logged && logged.length > 0,
            transcribeBlocker: hasAudio ? transcribeBlocker() : null,
          });
          steps = applyOverrides(r.steps, steps);
          warnings.push(...r.notes);
        }
        if (steps.length === 0) throw new ScreencastError("Give steps, a recipe, or both.");
        if (steps.length > MAX_PIPELINE_STEPS) throw new ScreencastError(`At most ${MAX_PIPELINE_STEPS} steps.`);
        if (!info.width || !info.height) throw new ScreencastError(`Could not read the size of ${args.input}.`);
        const src = {
          width: info.width,
          height: info.height,
          fps: info.fps ?? 30,
          durationSec: info.durationSec,
          hasAudio,
        };
        const timeout = jobTimeoutMs(info.durationSec);
        // Polish steps (#244): files and tools they need, checked before any work.
        for (const [i, s] of steps.entries()) {
          if (s.op !== "burn_subtitles") continue;
          if (!hasFilter("subtitles")) {
            throw new ScreencastError("This ffmpeg has no subtitles filter (it needs libass).", "Install a full ffmpeg build, e.g. `winget install Gyan.FFmpeg`.");
          }
          if (s.subtitles && !existsSync(s.subtitles)) throw new ScreencastError(`step ${i + 1}: subtitles file not found: ${s.subtitles}`);
          if (s.transcribe) {
            if (!hasFilter("whisper")) throw new ScreencastError(`step ${i + 1}: transcribe needs FFmpeg 8 built with whisper.cpp (no whisper filter here).`);
            resolveWhisperModel(undefined);
          }
        }
        // Clicks for zoom follow:"clicks", from the input's event log.
        const clicks: Record<number, ClickPoint[]> = {};
        for (const [i, s] of steps.entries()) {
          if (s.op !== "zoom" || s.follow !== "clicks") continue;
          const path = eventPaths(args.input).jsonl;
          const logged = readClicks(path);
          if (!logged) throw new ScreencastError(`step ${i + 1}: no event log at ${path}; record with start_recording events: true.`);
          clicks[i] = logged;
        }
        // cut_idle: scan the source once for frozen (and silent) stretches;
        // planPipeline moves them onto the step's timeline.
        let idle: Span[] | undefined;
        const idleAt = steps.findIndex((s) => s.op === "cut_idle");
        const idleStep = steps[idleAt];
        if (idleStep?.op === "cut_idle") {
          const total = info.durationSec;
          if (total === null) throw new ScreencastError(`Could not read the duration of ${args.input}.`);
          // A stretch minIdleSec long at the step is longer in the source after a speed-up.
          const speedUp = steps.slice(0, idleAt).reduce((f, x) => (x.op === "speed" ? f * x.factor : f), 1);
          const useAudio = hasAudio;
          const scan = await runCapture(ffmpeg, buildIdleScanArgs(args.input, (idleStep.minIdleSec ?? DEFAULT_MIN_IDLE_SEC) * speedUp, useAudio), timeout, {
            signal: extra.signal,
          });
          if (scan.code !== 0) throw new ScreencastError(`Idle scan failed (exit ${scan.code}): ${scan.stderr.trim().slice(-400)}`);
          const freezes = parseFreezes(scan.stderr, total);
          idle = useAudio ? intersect(freezes, parseSilences(scan.stderr, total)) : freezes;
        }
        const last = steps.at(-1);
        if (!last) throw new ScreencastError("Provide at least one step.");
        const ext = last.op === "export_gif" ? `.${last.format ?? "gif"}` : ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `pipeline-${stamp()}-${rand()}${ext}`, args.overwrite);

        const work = mkdtempSync(join(tmpdir(), "screencast-pipeline-"));
        try {
          // Callout text and arrow files; a dry run plans with placeholder paths.
          // Fonts are chosen either way, so a dry run reports missing glyphs too (#231).
          const assets: Record<number, CalloutAssets> = {};
          const fallbackFonts: Array<{ step: number; item: number; fontFile: string }> = [];
          for (const [i, s] of steps.entries()) {
            if (s.op !== "callout") continue;
            const a = args.dryRun
              ? { fontFile: "<font>", textFiles: s.items.map((c) => (c.type === "text" ? "<text>" : null)), arrowFiles: s.items.map((c) => (c.type === "arrow" ? "<arrow.png>" : null)), ...calloutFonts(s.items, s.fontFile) }
              : await prepareCalloutAssets(s.items, work, `s${i}_`, s.fontFile);
            assets[i] = a;
            fallbackFonts.push(...a.fallbackFonts.map((f) => ({ step: i, ...f })));
            warnings.push(...a.warnings.map((w) => `Step ${i}, ${w.charAt(0).toLowerCase()}${w.slice(1)}`));
          }
          // Keystroke badges come from the input's event log, on its clock;
          // planPipeline moves them through earlier trims and speed changes.
          const keystrokes: Record<number, KeystrokeStepAssets> = {};
          for (const [i, s] of steps.entries()) {
            if (s.op === "backdrop" && s.image && !existsSync(s.image)) {
              throw new ScreencastError(`step ${i + 1}: background image not found: ${s.image}`);
            }
            if (s.op !== "keystroke_overlay") continue;
            const { badges } = loadBadges(args.input, s.events, s);
            const labels = [...new Set(badges.map((b) => b.label))];
            const k = prepareKeystrokeAssets(labels, args.dryRun ? null : work, `s${i}_`, s.fontFile);
            keystrokes[i] = { badges, fontFile: k.fontFile, textFiles: k.textFiles };
            warnings.push(...k.warnings.map((w) => `Step ${i}, ${w.charAt(0).toLowerCase()}${w.slice(1)}`));
          }
          // The cursor (#170) is planned on the source's clock too; planPipeline
          // moves it through earlier trims, speed, cuts, crops and scales.
          const cursor: Record<number, CursorStepAssets> = {};
          for (const [i, s] of steps.entries()) {
            if (s.op !== "cursor") continue;
            cursor[i] = {
              plan: loadCursor(args.input, s.events, s, info.durationSec),
              sprite: cursorSpritePath(),
              commandsFile: args.dryRun ? `<cursor ${i}.cmd>` : join(work, `s${i}_cursor.cmd`),
            };
          }
          // An export_gif tail renders to a temporary mp4 first; a dry run names it plainly.
          const target = last.op === "export_gif" ? (args.dryRun ? "<temporary stage1.mp4>" : join(work, "stage1.mp4")) : output;
          const audioM: Record<number, AudioMeasurements> = {};
          const subtitles: Record<number, string> = {};
          const fontsDir = dirname(bundledFontPath("regular"));
          const planWith = (chaptersFile?: string) =>
            planPipeline(args.input, target, steps, src, assets, args.quality ?? "standard", {
              keystrokes, cursor, idle, clicks, audio: audioM, subtitles, fontsDir, chaptersFile,
            });
          let plan = planWith();
          // Probes run in step order with a re-plan after each, since each one
          // hears the audio as the earlier steps leave it. A dry run skips them.
          let transcript: string | undefined;
          for (let n = 0; !args.dryRun && plan.pending.length > 0; n++) {
            const p = plan.pending[0] as PipelinePending;
            if (n > steps.length * 3) throw new ScreencastError(`Internal: step ${p.step + 1} ${p.kind} did not resolve.`);
            const s = steps[p.step] as PipelineStep;
            const capture = async (base: string[]) => {
              const sc = scriptLongFilters(probeArgs(base, p));
              try {
                const r = await runCapture(ffmpeg, sc.args, timeout, { signal: extra.signal });
                if (r.code !== 0) throw new ScreencastError(`step ${p.step + 1} ${p.kind} scan failed (exit ${r.code}): ${r.stderr.trim().slice(-400)}`);
                return r;
              } finally {
                sc.cleanup();
              }
            };
            if (p.kind === "noisefloor") {
              audioM[p.step] = { ...audioM[p.step], floorDb: parseNoiseFloor((await capture(buildNoiseFloorArgs(args.input))).stdout) };
            } else if (p.kind === "loudness" && s.op === "audio") {
              const r = await capture(buildLoudnessMeasureArgs(args.input, loudnessTarget(s.normalize)));
              try {
                audioM[p.step] = { ...audioM[p.step], loudness: parseLoudnorm(r.stderr) };
              } catch {
                warnings.push(`Step ${p.step + 1}: the audio is silent; not normalized.`);
                audioM[p.step] = { ...audioM[p.step], silent: true };
              }
            } else if (p.kind === "transcribe" && s.op === "burn_subtitles") {
              const raw = join(work, `s${p.step}_raw.srt`);
              await runFfmpeg(probeArgs(buildTranscribeArgs(args.input, resolveWhisperModel(undefined), raw), p), timeout, {
                signal: extra.signal,
              });
              const cues = existsSync(raw) ? normalizeCues(parseSrt(readFileSync(raw, "utf8"))) : [];
              subtitles[p.step] = cues.length > 0 ? join(work, `s${p.step}.srt`) : "";
              if (cues.length > 0) {
                transcript = formatSrt(cues);
                writeFileSync(subtitles[p.step]!, transcript);
              } else warnings.push(`Step ${p.step + 1}: no speech was recognised; no captions.`);
            } else if (p.kind === "subtitles" && s.op === "burn_subtitles" && s.subtitles) {
              // The file is on the source's clock; move it past earlier trims, speed and cuts.
              if (p.ops.length === 0) subtitles[p.step] = s.subtitles;
              else {
                const text = readFileSync(s.subtitles, "utf8");
                const ass = /\.(ass|ssa)$/i.test(s.subtitles);
                const moved = ass ? retimeAss(text, p.ops) : formatSrt(retimeCues(normalizeCues(parseSrt(text)), p.ops));
                const file = join(work, `s${p.step}${ass ? ".ass" : ".srt"}`);
                writeFileSync(file, moved);
                subtitles[p.step] = ass || moved.trim() ? file : "";
              }
            } else {
              throw new ScreencastError(`Internal: step ${p.step + 1} cannot resolve ${p.kind}.`);
            }
            plan = planWith();
          }
          // Chapters (#174): the input's markers, re-timed through the plan's
          // trims and speed changes, muxed from an FFMETADATA input.
          let chapterList: Chapter[] = [];
          let retimed: Marker[] = [];
          if (args.chapters) {
            const found = plan.gif ? null : await markersOrChapters(args.input, extra.signal);
            if (!found) warnings.push("chapters: a GIF/WebP cannot hold chapters; none written.");
            else if (found.markers.length === 0) warnings.push("chapters: the input has no markers (add_marker) or chapters; none written.");
            else {
              retimed = retimeMarkers(found.markers, plan.timeOps);
              chapterList = plan.durationSec ? buildChapters(markerPoints(retimed), plan.durationSec) : [];
              if (chapterList.length === 0) warnings.push("chapters: no marker falls inside the result; none written.");
              else {
                const file = args.dryRun ? "<chapters.txt>" : join(work, "chapters.txt");
                if (!args.dryRun) writeFileSync(file, ffmetadata(chapterList));
                plan = planWith(file);
              }
            }
          }
          const result = {
            ...(args.recipe && { recipe: args.recipe, expandedSteps: steps }),
            steps: plan.summary,
            ...(args.dryRun && plan.pending.length > 0 && { measuredOnRun: plan.pending.map((p) => `step ${p.step + 1}: ${p.kind}`) }),
            processes: plan.gif ? 2 : 1,
            width: plan.width,
            height: plan.height,
            durationSec: plan.durationSec,
            ...(fallbackFonts.length > 0 && { fallbackFonts }),
            ...(warnings.length > 0 && { warnings }),
            ...(chapterList.length > 0 && { chapters: chapterList }),
          };
          if (args.dryRun) return okResponse({ dryRun: true, ...result, ffmpegArgs: plan.args });

          for (const f of plan.files) writeFileSync(f.path, f.content);
          // The timeout follows the input ffmpeg decodes, not the (maybe sped-up) output (#237).
          await runEditJob(plan.args, { output: target, durationSec: plan.durationSec, inputDurationSec: info.durationSec, extra });
          if (plan.gif) {
            const anim = await exportAnimation(target, output, plan.gif, extra);
            return okResponse({ outputPath: output, ...result, animation: anim });
          }
          // A transcript made for captions goes next to the result.
          let subtitlesPath: string | undefined;
          if (transcript) {
            try {
              subtitlesPath = output.replace(/\.[^./\\]+$/, "") + ".srt";
              writeFileSync(subtitlesPath, transcript);
            } catch {
              subtitlesPath = undefined;
            }
          }
          // The re-timed markers go with the result, for the player and chapters.
          let markersPath: string | undefined;
          if (chapterList.length > 0) {
            try {
              markersPath = writeMarkers(output, retimed.filter((m) => m.t < (plan.durationSec ?? Infinity)));
            } catch {
              /* best effort: the chapters are in the file */
            }
          }
          return okResponse({ outputPath: output, ...result, ...(markersPath && { markersPath }), ...(subtitlesPath && { subtitlesPath }) });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
