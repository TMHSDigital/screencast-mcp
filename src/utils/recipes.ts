/**
 * Polish recipes for pipeline (#244): "turn this raw recording into something
 * shareable" as one call. A recipe is only a list of pipeline steps, expanded
 * here so a dry run shows exactly what will run and the caller can override
 * any step. Steps that need something the input lacks (an event log with
 * clicks for zoom, audio for loudness and captions, whisper for a transcript)
 * are left out with a note rather than failing. Pure.
 */
import { ScreencastError } from "./errors.js";
import type { PipelineStep } from "./pipeline.js";

export const RECIPES = ["pr_demo", "tutorial", "social_reel"] as const;
export type Recipe = (typeof RECIPES)[number];

/** The largest GIF pr_demo aims for: GitHub shows inline images up to 10 MB. */
export const PR_DEMO_MAX_BYTES = 10_000_000;

export interface RecipeContext {
  hasAudio: boolean;
  /** The input has an event log with at least one click. */
  hasClicks: boolean;
  /** Why captions cannot be transcribed (no whisper filter or model), or null when they can. */
  transcribeBlocker: string | null;
}

const EXPORTS = new Set<PipelineStep["op"]>(["export_preset", "export_gif"]);

/** The steps a recipe stands for, given what the input has, plus notes on
 * anything left out. Pure. */
export function recipeSteps(recipe: Recipe, ctx: RecipeContext): { steps: PipelineStep[]; notes: string[] } {
  const notes: string[] = [];
  const steps: PipelineStep[] = [{ op: "cut_idle" }];
  if (ctx.hasClicks) steps.push({ op: "zoom", follow: "clicks" });
  else notes.push("zoom left out: no event log with clicks (record with start_recording events: true).");
  const captions = (style: "clean" | "social") => {
    if (!ctx.hasAudio) return;
    if (ctx.transcribeBlocker) notes.push(`captions left out: ${ctx.transcribeBlocker}`);
    else steps.push({ op: "burn_subtitles", transcribe: true, style });
  };
  if (!ctx.hasAudio && recipe !== "pr_demo") notes.push("audio and captions left out: the input has no audio.");
  switch (recipe) {
    case "pr_demo":
      steps.push({ op: "export_gif", maxBytes: PR_DEMO_MAX_BYTES });
      break;
    case "tutorial":
      if (ctx.hasAudio) steps.push({ op: "audio", denoise: "light", normalize: "youtube" });
      captions("clean");
      steps.push({ op: "export_preset", platform: "youtube" });
      break;
    case "social_reel":
      if (ctx.hasAudio) steps.push({ op: "audio", normalize: "youtube" });
      // Captions go on the vertical canvas, so they sit in the bar under the footage.
      steps.push({ op: "reframe", aspect: "9:16" });
      captions("social");
      steps.push({ op: "export_preset", platform: "instagram_reel" });
      break;
    default:
      throw new ScreencastError(`Unknown recipe "${String(recipe)}".`);
  }
  return { steps, notes };
}

/** Lay caller steps over a recipe's: a step replaces the recipe's step with
 * the same op (any export replaces the recipe's export); a trim goes first;
 * the rest go before the recipe's export, in order. Pure. */
export function applyOverrides(base: PipelineStep[], overrides: PipelineStep[]): PipelineStep[] {
  const out = [...base];
  const tail = out.at(-1) && EXPORTS.has(out.at(-1)!.op) ? out.pop()! : null;
  let exportStep = tail;
  const recipeLen = out.length;
  const replaced = new Set<number>();
  const first: PipelineStep[] = [];
  for (const o of overrides) {
    if (EXPORTS.has(o.op)) {
      exportStep = o;
      continue;
    }
    const i = out.findIndex((s, j) => j < recipeLen && !replaced.has(j) && s.op === o.op);
    // A trim goes first, so its times are the source's (as contact_sheet shows them).
    if (i === -1 && o.op === "trim") first.push(o);
    else if (i === -1) out.push(o);
    else {
      out[i] = o;
      replaced.add(i);
    }
  }
  return [...first, ...out, ...(exportStep ? [exportStep] : [])];
}
