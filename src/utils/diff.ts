/**
 * Frame differencing for screen_diff and wait_for_change (#116).
 *
 * Frames are compared as small grayscale bitmaps (about 320 px wide). The image
 * is split into a grid of cells; a cell counts as changed when its mean
 * absolute difference passes a threshold, and touching changed cells are
 * grouped into bounding boxes mapped back to the source's pixel coordinates.
 * Everything here is pure, so it is unit-tested on synthetic bitmaps.
 */
import { ScreencastError } from "./errors.js";
import type { Monitor } from "./monitors.js";
import { targetInputArgs, SCREENSHOT_GRAB_FPS, type Target } from "./targets.js";

/** Width frames are analysed at. */
export const ANALYSIS_WIDTH = 320;
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

/** Compare two `width` x `height` grayscale bitmaps. `scale` maps analysis
 * pixels to source pixels; `origin` offsets the boxes (e.g. a region's x/y). */
export function diffFrames(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  opts: { scale?: number; origin?: { x: number; y: number }; pixelThreshold?: number; maxRegions?: number } = {},
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

  const scale = opts.scale ?? 1;
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
        x: ox + Math.round(x * scale),
        y: oy + Math.round(y * scale),
        width: Math.round(w * scale),
        height: Math.round(h * scale),
      };
    });

  const changedCount = changed.reduce((s, v) => s + v, 0);
  return { meanDiff: meanDifference(a, b), changedFraction: changedCount / changed.length, regions };
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
  return ["-y", "-v", "error", "-i", input, "-frames:v", "1", ...(boxes.length ? ["-vf", boxes.join(",")] : []), output];
}

/** Parse the `All:` score from ffmpeg's ssim filter output, or null. */
export function parseSsim(stderr: string): number | null {
  const m = stderr.match(/All:([\d.]+)/);
  return m ? Number(m[1]) : null;
}
