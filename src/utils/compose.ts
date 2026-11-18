/**
 * compose (#338): lay several videos out at once (side by side, stacked, or
 * in a grid) for before/after clips, an app next to its terminal, or two runs
 * of one flow. Every input is scaled into the same cell (letterboxed, never
 * stretched), optionally labelled, brought to one frame rate, and placed
 * with xstack. Inputs can be lined up on a shared marker, and shorter ones
 * hold their last frame (or the output ends with the shortest). Pure.
 */
import { ScreencastError } from "./errors.js";
import { escapeFilterPath } from "./fonts.js";
import { type Quality } from "./targets.js";
import { encodeTail } from "./encode.js";

export const COMPOSE_LAYOUTS = ["side_by_side", "stack", "grid"] as const;
export type ComposeLayout = (typeof COMPOSE_LAYOUTS)[number];

export const MIN_COMPOSE_INPUTS = 2;
export const MAX_COMPOSE_INPUTS = 9;
/** Widest or tallest output compose makes, in pixels. */
export const MAX_COMPOSE_SIDE = 3840;
/** Tallest cell, so two 4K sources do not make an 8K-wide file. */
export const MAX_CELL_HEIGHT = 1080;

export interface ComposeSource {
  path: string;
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  /** Seconds skipped at the start (to line up a marker). */
  skipSec: number;
  /** A text file holding the label, and the font to draw it with. */
  label?: { textFile: string; fontFile: string };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Columns and rows for `n` cells. Pure. */
export function gridShape(layout: ComposeLayout, n: number): { cols: number; rows: number } {
  if (layout === "side_by_side") return { cols: n, rows: 1 };
  if (layout === "stack") return { cols: 1, rows: n };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

/** One cell's size: the first input's shape, at most MAX_CELL_HEIGHT tall,
 * shrunk until the whole layout fits MAX_COMPOSE_SIDE. Pure. */
export function cellSize(first: { width: number; height: number }, shape: { cols: number; rows: number }): { width: number; height: number } {
  let h = Math.min(first.height, MAX_CELL_HEIGHT);
  let w = (first.width * h) / first.height;
  const fit = Math.min(1, MAX_COMPOSE_SIDE / (w * shape.cols), MAX_COMPOSE_SIDE / (h * shape.rows));
  w *= fit;
  h *= fit;
  return { width: even(w), height: even(h) };
}

/** How long each input plays after its skip, and the output's length. Pure. */
export function composeDuration(sources: readonly ComposeSource[], endWith: "longest" | "shortest"): number {
  const lens = sources.map((s) => Math.max(0, s.durationSec - s.skipSec));
  return endWith === "longest" ? Math.max(...lens) : Math.min(...lens);
}

export interface ComposeOptions {
  layout: ComposeLayout;
  endWith: "longest" | "shortest";
  /** Which input's audio to keep, "mix" for all of them, or "none". */
  audio: number | "mix" | "none";
  fps: number;
  quality?: Quality;
}

export function buildComposeArgs(sources: readonly ComposeSource[], output: string, o: ComposeOptions): string[] {
  const n = sources.length;
  if (n < MIN_COMPOSE_INPUTS || n > MAX_COMPOSE_INPUTS) {
    throw new ScreencastError(`compose takes ${MIN_COMPOSE_INPUTS} to ${MAX_COMPOSE_INPUTS} inputs.`);
  }
  const first = sources[0]!;
  const shape = gridShape(o.layout, n);
  const cell = cellSize(first, shape);
  const total = composeDuration(sources, o.endWith);
  if (!(total > 0)) throw new ScreencastError("Nothing is left to show after lining the inputs up.");
  const graph: string[] = [];
  sources.forEach((s, i) => {
    const hold = Math.max(0, total - (s.durationSec - s.skipSec));
    const label = s.label
      ? `,drawtext=fontfile=${escapeFilterPath(s.label.fontFile)}:textfile=${escapeFilterPath(s.label.textFile)}:expansion=none:` +
        `fontcolor=white:fontsize=${Math.max(14, Math.round(cell.height / 18))}:x=12:y=12:box=1:boxcolor=black@0.6:boxborderw=8`
      : "";
    graph.push(
      `[${i}:v]fps=${o.fps},scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease,` +
        `pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p` +
        (hold > 0.001 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : "") +
        `${label}[c${i}]`,
    );
  });
  const layout = sources.map((_, i) => `${(i % shape.cols) * cell.width}_${Math.floor(i / shape.cols) * cell.height}`).join("|");
  graph.push(`${sources.map((_, i) => `[c${i}]`).join("")}xstack=inputs=${n}:layout=${layout}:fill=black[v]`);

  const withAudio = sources.map((s, i) => (s.hasAudio ? i : -1)).filter((i) => i >= 0);
  let audioMap: string[] = [];
  if (o.audio === "mix" && withAudio.length > 0) {
    graph.push(`${withAudio.map((i) => `[${i}:a]`).join("")}amix=inputs=${withAudio.length}:normalize=0:duration=longest,apad[a]`);
    audioMap = ["-map", "[a]"];
  } else if (typeof o.audio === "number") {
    if (!sources[o.audio]) throw new ScreencastError(`audio ${o.audio} is not an input (0-${n - 1}).`);
    if (!sources[o.audio]!.hasAudio) throw new ScreencastError(`Input ${o.audio} has no audio; pick another, "mix", or "none".`);
    graph.push(`[${o.audio}:a]apad[a]`);
    audioMap = ["-map", "[a]"];
  }
  const hasAudio = audioMap.length > 0;
  return [
    "-y",
    ...sources.flatMap((s) => [...(s.skipSec > 0 ? ["-ss", s.skipSec.toFixed(3)] : []), "-i", s.path]),
    "-filter_complex", graph.join(";"),
    "-map", "[v]", ...audioMap,
    "-t", total.toFixed(3),
    ...encodeTail({ quality: o.quality ?? "standard", audio: hasAudio ? "aac" : "omit" }),
    output,
  ];
}
