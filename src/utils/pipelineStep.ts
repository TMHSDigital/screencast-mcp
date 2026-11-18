/**
 * The pipeline step schema (#368): one definition, used by the tool's input
 * schema and, through z.infer, by the planner's types, so the two cannot
 * drift apart.
 */
import { z } from "zod";
import { redactRegionSchema, REDACT_STYLES, type RedactRegion } from "./media.js";
import { PLATFORMS, ASPECTS, REFRAME_FITS } from "./produce.js";
import { calloutItemSchema, fontFileSchema } from "./callout.js";
import { MAX_ZOOM, zoomKeyframeSchema } from "./zoom.js";
import { idleOptionFields, speedRangeSchema, MAX_RANGE_FACTOR } from "./idle.js";
import { DENOISE_STRENGTHS, loudnessTargetSchema } from "./audio.js";
import { CAPTION_STYLE_NAMES } from "./captions.js";
import { backdropOptionsSchema } from "./backdrop.js";
import { keystrokeOptionsSchema } from "./keystrokes.js";
import { cursorOptionsSchema } from "./cursor.js";

const aspect = z.enum(ASPECTS);
const fit = z.enum(REFRAME_FITS).optional();

export const pipelineStepSchema = z.discriminatedUnion("op", [
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
  z.object({ op: z.literal("speed"), factor: z.number().positive().optional(), segments: z.array(speedRangeSchema).min(1).optional() }),
  z.object({
    op: z.literal("redact"),
    regions: z.array(redactRegionSchema).min(1).optional(),
    secrets: z.union([z.boolean(), z.string().min(1).max(500)]).optional().describe("OCR for on-screen secrets: true or a regex."),
    style: z.enum(REDACT_STYLES).optional(),
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
  z.object({
    op: z.literal("cut_idle"),
    minIdleSec: z.number().positive().optional(),
    keepSec: z.number().min(0).optional(),
    action: z.enum(["cut", "speed"]).optional(),
    factor: z.number().gt(1).max(MAX_RANGE_FACTOR).optional(),
    ...idleOptionFields,
  }),
  z.object({
    op: z.literal("audio"),
    normalize: loudnessTargetSchema.optional(),
    denoise: z.enum(DENOISE_STRENGTHS).optional(),
  }),
  z.object({
    op: z.literal("burn_subtitles"),
    subtitles: z.string().min(1).optional(),
    transcribe: z.boolean().optional(),
    style: z.enum(CAPTION_STYLE_NAMES).optional(),
  }),
  z.object({ op: z.literal("backdrop"), ...backdropOptionsSchema }),
  z.object({ op: z.literal("keystroke_overlay"), ...keystrokeOptionsSchema }),
  z.object({ op: z.literal("cursor"), ...cursorOptionsSchema }),
  z.object({
    op: z.literal("music"),
    music: z.string().min(1),
    musicVolume: z.number().nonnegative().optional(),
    fadeIn: z.number().nonnegative().optional(),
    fadeOut: z.number().nonnegative().optional(),
    duck: z.boolean().optional(),
  }),
  z.object({ op: z.literal("export_preset"), platform: z.enum(PLATFORMS), fit }),
  z.object({
    op: z.literal("export_gif"),
    format: z.enum(["gif", "webp"]).optional(),
    maxBytes: z.number().int().min(10_000).optional(),
    fps: z.number().positive().max(30).optional(),
    width: z.number().int().min(64).max(1920).optional(),
  }),
]);

/** A step as asked: what the tool accepts, recipes produce, and an edit
 * spec keeps (a redact may name no regions and ask for a secret scan). */
export type PipelineStepInput = z.infer<typeof pipelineStepSchema>;

type RedactInput = Extract<PipelineStepInput, { op: "redact" }>;

/** A step as planned: a redact's regions are resolved (the secret scan's
 * hits added) before planning. */
export type PipelineStep = Exclude<PipelineStepInput, { op: "redact" }> | (Omit<RedactInput, "regions"> & { regions: RedactRegion[] });
