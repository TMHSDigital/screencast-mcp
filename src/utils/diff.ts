/**
 * Frame differencing for screen_diff and wait_for_change (#116).
 *
 * Frames are compared as small grayscale bitmaps (detectionSize: about a
 * quarter of the source width, 320-1600 px). The image is split into a grid of cells; a cell counts as changed when its mean
 * absolute difference passes a threshold, and touching changed cells are
 * grouped into bounding boxes mapped back to the source's pixel coordinates.
 * Everything here is pure, so it is unit-tested on synthetic bitmaps.
 */
import { ScreencastError } from "./errors.js";
import type { Monitor } from "./monitors.js";
import { targetInputArgs, SCREENSHOT_GRAB_FPS, type Target } from "./targets.js";
import { stillOutput } from "./paths.js";

/** Width frames are analysed at by analysisSize (auto-zoom's whole-video scan). */
export const ANALYSIS_WIDTH = 320;
/** screen_diff and wait_for_change analyse at one pixel per this many source
 * pixels, so a cell covers the same ~32 source px on a 4K monitor or a
 * three-monitor desktop as on a laptop, and a small label change still
 * passes the threshold (#234). */
export const SOURCE_PX_PER_ANALYSIS_PX = 4;
/** Cap on detectionSize's width, for cost (a 5760 px desktop analyses at 1440). */
export const MAX_DETECTION_WIDTH = 1600;
/** Cell size in analysis pixels. */
export const CELL = 8;
/** A cell's mean |a - b| (0-255) above this counts as changed. Low enough to
 * catch a text caret or a button highlight, high enough to ignore encoder noise. */
export const DEFAULT_PIXEL_THRESHOLD = 12;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Analysis size for a source of `width` x `height`: at most ANALYSIS_WIDTH
 * wide, aspect kept, both sides even and at least 2. */
export function analysisSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new ScreencastError("Image has no size.");
  const w = Math.min(ANALYSIS_WIDTH, width);
  const h = Math.max(2, Math.round((height * w) / width / 2) * 2);
  return { width: Math.max(2, Math.round(w / 2) * 2), height: h };
}

/** Analysis size for change detection (#234): SOURCE_PX_PER_ANALYSIS_PX
 * source pixels per analysis pixel, between ANALYSIS_WIDTH and
 * MAX_DETECTION_WIDTH wide (never wider than the source), aspect kept. */
export function detectionSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new ScreencastError("Image has no size.");
  const w = Math.min(width, Math.max(ANALYSIS_WIDTH, Math.min(MAX_DETECTION_WIDTH, Math.ceil(width / SOURCE_PX_PER_ANALYSIS_PX))));
  const h = Math.max(2, Math.round((height * w) / width / 2) * 2);
  return { width: Math.max(2, Math.round(w / 2) * 2), height: h };
}

/** Pixel size of a resolved capture target (`full` is the union of monitors). */
export function targetSize(target: Target, monitors: Monitor[]): Rect {
  switch (target.kind) {
    case "region":
      return { x: target.x, y: target.y, width: target.w, height: target.h };
    case "monitor": {
      const m = monitors.find((mm) => mm.index === target.index);
      if (!m) throw new ScreencastError(`No monitor ${target.index}.`);
      return { x: m.x, y: m.y, width: m.width, height: m.height };
    }
    case "full": {
      if (monitors.length === 0) throw new ScreencastError("No monitors found.");
      const left = Math.min(...monitors.map((m) => m.x));
      const top = Math.min(...monitors.map((m) => m.y));
      const right = Math.max(...monitors.map((m) => m.x + m.width));
      const bottom = Math.max(...monitors.map((m) => m.y + m.height));
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    default:
      throw new ScreencastError("Internal: resolve window targets to a region first.");
  }
}

/** Mean |a - b| over two equal-size grayscale bitmaps, as a 0-1 fraction. */
export function meanDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) throw new ScreencastError("Frames differ in size.");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}

export interface DiffResult {
  /** Mean absolute difference, 0 (identical) to 1. */
  meanDiff: number;
  /** Share of grid cells that changed, 0-1. */
  changedFraction: number;
  /** Bounding boxes of changed areas, in source pixels (offset by `origin`). */
  regions: Rect[];
}

export interface DiffOptions {
  /** Analysis-to-source pixel factor for both axes. */
  scale?: number;
  /** Per-axis factors (override scale), for a source not scaled uniformly (#211). */
  scaleX?: number;
  scaleY?: number;
  /** Offset added to every box. */
  origin?: { x: number; y: number };
  pixelThreshold?: number;
  maxRegions?: number;
}

/** Compare two `width` x `height` grayscale bitmaps. `scale` (or `scaleX` /
 * `scaleY`) maps analysis pixels to source pixels; `origin` offsets the boxes. */
export function diffFrames(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  opts: DiffOptions = {},
): DiffResult {
  if (a.length !== width * height || b.length !== width * height) {
    throw new ScreencastError("Frame size does not match its dimensions.");
  }
  const threshold = opts.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const changed = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let sum = 0;
      let n = 0;
      for (let y = cy * CELL; y < Math.min(height, (cy + 1) * CELL); y++) {
        for (let x = cx * CELL; x < Math.min(width, (cx + 1) * CELL); x++) {
          const i = y * width + x;
          sum += Math.abs(a[i] - b[i]);
          n++;
        }
      }
      if (sum / n > threshold) changed[cy * cols + cx] = 1;
    }
  }

  // Group touching changed cells (8-neighbour flood fill) into boxes.
  const seen = new Uint8Array(cols * rows);
  const boxes: Array<{ x0: number; y0: number; x1: number; y1: number; cells: number }> = [];
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue;
    const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, cells: 0 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const c = stack.pop()!;
      const cx = c % cols;
      const cy = Math.floor(c / cols);
      box.x0 = Math.min(box.x0, cx);
      box.y0 = Math.min(box.y0, cy);
      box.x1 = Math.max(box.x1, cx);
      box.y1 = Math.max(box.y1, cy);
      box.cells++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nc = ny * cols + nx;
          if (changed[nc] && !seen[nc]) {
            seen[nc] = 1;
            stack.push(nc);
          }
        }
      }
    }
    boxes.push(box);
  }

  const sx = opts.scaleX ?? opts.scale ?? 1;
  const sy = opts.scaleY ?? opts.scale ?? 1;
  const ox = opts.origin?.x ?? 0;
  const oy = opts.origin?.y ?? 0;
  const regions = boxes
    .sort((p, q) => q.cells - p.cells)
    .slice(0, opts.maxRegions ?? 20)
    .map((bx) => {
      const x = bx.x0 * CELL;
      const y = bx.y0 * CELL;
      const w = Math.min(width, (bx.x1 + 1) * CELL) - x;
      const h = Math.min(height, (bx.y1 + 1) * CELL) - y;
      return {
        x: ox + Math.round(x * sx),
        y: oy + Math.round(y * sy),
        width: Math.round(w * sx),
        height: Math.round(h * sy),
      };
    });

  const changedCount = changed.reduce((s, v) => s + v, 0);
  return { meanDiff: meanDifference(a, b), changedFraction: changedCount / changed.length, regions };
}

/** Diff options mapping analysis boxes onto a captured target's own pixels,
 * i.e. onto the screenshot of it, not the desktop (#233): callers report the
 * target's x/y as `origin` instead. */
export function targetDiffOptions(
  area: { width: number; height: number },
  size: { width: number; height: number },
  pixelThreshold?: number,
): DiffOptions {
  return { scaleX: area.width / size.width, scaleY: area.height / size.height, pixelThreshold };
}

/**
 * Settle detection for wait_for_change (#234). Each frame is compared with the
 * previous one and with the first frame of the current quiet stretch, so a
 * change too slow to pass the threshold between two frames (a progress bar
 * creeping along) still ends the quiet stretch once it adds up.
 */
export class SettleTracker {
  private previous: Uint8Array;
  private anchor: Uint8Array;

  constructor(
    first: Uint8Array,
    private readonly width: number,
    private readonly height: number,
    private readonly opts: DiffOptions = {},
  ) {
    this.previous = first;
    this.anchor = first;
  }

  /** Feed the next frame; returns the changed regions, empty when still quiet. */
  push(frame: Uint8Array): Rect[] {
    const step = diffFrames(this.previous, frame, this.width, this.height, this.opts).regions;
    const drift = step.length > 0 ? step : diffFrames(this.anchor, frame, this.width, this.height, this.opts).regions;
    this.previous = frame;
    if (drift.length > 0) this.anchor = frame;
    return drift;
  }
}

/** Grab args that decode one frame of a still or video file to a raw gray
 * bitmap at the analysis size on stdout. */
export function buildRawFrameArgs(input: string, size: { width: number; height: number }): string[] {
  return [
    "-v", "error", "-i", input, "-frames:v", "1",
    "-vf", `scale=${size.width}:${size.height}:flags=area,format=gray`,
    "-f", "rawvideo", "-",
  ];
}

/** Grab one live frame of a resolved target as a raw gray bitmap at the
 * analysis size on stdout (gdigrab at 30 fps; see SCREENSHOT_GRAB_FPS). */
export function buildRawGrabArgs(
  target: Target,
  monitors: Monitor[],
  size: { width: number; height: number },
): string[] {
  return [
    "-v", "error", "-f", "gdigrab", "-framerate", String(SCREENSHOT_GRAB_FPS),
    ...targetInputArgs(target, monitors),
    "-frames:v", "1",
    "-vf", `scale=${size.width}:${size.height}:flags=area,format=gray`,
    "-f", "rawvideo", "-",
  ];
}

/** SSIM between two images, both scaled to `size`; score printed to stderr. */
export function buildSsimArgs(a: string, b: string, size: { width: number; height: number }): string[] {
  const s = `scale=${size.width}:${size.height}:flags=area,format=gray`;
  return ["-v", "info", "-i", a, "-i", b, "-lavfi", `[0]${s}[x];[1]${s}[y];[x][y]ssim`, "-frames:v", "1", "-f", "null", "-"];
}

/** Draw each changed region as a red outline on `input`, for a quick visual. */
export function buildHighlightArgs(input: string, regions: Rect[], output: string): string[] {
  const boxes = regions.map((r) => `drawbox=x=${r.x}:y=${r.y}:w=${r.width}:h=${r.height}:color=red@0.9:t=3`);
  return ["-y", "-v", "error", "-i", input, "-frames:v", "1", ...(boxes.length ? ["-vf", boxes.join(",")] : []), ...stillOutput(output)];
}

/** Parse the `All:` score from ffmpeg's ssim filter output, or null. */
export function parseSsim(stderr: string): number | null {
  const m = stderr.match(/All:([\d.]+)/);
  return m ? Number(m[1]) : null;
}
