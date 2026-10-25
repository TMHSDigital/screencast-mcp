/**
 * Animated zoom-and-pan (#119): Screen Studio-style emphasis for screencasts.
 *
 * A zoom is a list of keyframes, each a rectangle of the source to fill the
 * frame by a given time. Between keyframes the view holds, then eases into
 * the next one over `transition` seconds (smoothstep). It is rendered with
 * zoompan (d=1: one output frame per input frame at a fixed size). A
 * scale + crop chain cannot do this: crop reads its input size once, so a
 * per-frame scale leaves it cropping the top-left corner. The source is
 * upscaled 2x first so zoompan's whole-pixel positions do not judder.
 *
 * Auto mode needs no input capture: it zooms toward where the screen changed,
 * using the same cell-grid differ as screen_diff, and zooms back out when
 * activity stops or the whole screen changes. All helpers are pure.
 */
import { ScreencastError } from "./errors.js";
import { diffFrames, type Rect } from "./diff.js";
import { resolveQuality, type Quality } from "./targets.js";

export const DEFAULT_TRANSITION_SEC = 0.6;
export const MAX_ZOOM = 6;
export const DEFAULT_AUTO_MAX_ZOOM = 2.5;

/** A user keyframe: a rectangle to fill the frame by time t, or the full frame. */
export interface ZoomKeyframe {
  t: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Zoom back out to the whole frame. */
  full?: boolean;
}

/** Internal view: zoom factor and centre, in source pixels. */
export interface View {
  t: number;
  z: number;
  cx: number;
  cy: number;
}

/** Turn keyframes into views for a W x H source, adding a full-frame start at
 * t=0 when the first keyframe is later. Pure. */
export function keyframesToViews(kfs: ZoomKeyframe[], W: number, H: number, maxZoom = MAX_ZOOM): View[] {
  if (kfs.length === 0) throw new ScreencastError("Give at least one keyframe.");
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  const views = sorted.map((k): View => {
    if (!Number.isFinite(k.t) || k.t < 0) throw new ScreencastError("Keyframe t must be a non-negative number.");
    if (k.full || k.width === undefined || k.height === undefined) return { t: k.t, z: 1, cx: W / 2, cy: H / 2 };
    if (!(k.width > 0) || !(k.height > 0)) throw new ScreencastError("Keyframe width and height must be positive.");
    const z = Math.max(1, Math.min(maxZoom, W / k.width, H / k.height));
    return { t: k.t, z, cx: (k.x ?? 0) + k.width / 2, cy: (k.y ?? 0) + k.height / 2 };
  });
  if (views[0].t > 0) views.unshift({ t: 0, z: 1, cx: W / 2, cy: H / 2 });
  return views;
}

const n = (v: number) => Number(v.toFixed(4)).toString();

/** A zoompan expression for one view property over input time `it`: hold each
 * value, then ease (smoothstep) into the next over the transition before its
 * keyframe. Pure. */
export function viewExpr(views: View[], key: "z" | "cx" | "cy", transition: number): string {
  let expr = n(views[views.length - 1][key]);
  for (let i = views.length - 2; i >= 0; i--) {
    const a = views[i][key];
    const b = views[i + 1][key];
    const end = views[i + 1].t;
    const T = Math.max(0.001, Math.min(transition, end - views[i].t));
    const start = end - T;
    const s = `((it-${n(start)})/${n(T)})`;
    const ease = a === b ? n(a) : `${n(a)}+${n(b - a)}*${s}*${s}*(3-2*${s})`;
    expr = `if(lt(it,${n(start)}),${n(a)},if(lt(it,${n(end)}),${ease},${expr}))`;
  }
  return expr;
}

/** Render the zoom. `up` is the pre-zoompan upscale factor (2 for sources up
 * to 1920 wide, else 1, to keep frames a sane size). Pure. */
export function buildZoomArgs(
  input: string,
  output: string,
  views: View[],
  size: { width: number; height: number; fps: number },
  transition = DEFAULT_TRANSITION_SEC,
  quality: Quality = "standard",
): string[] {
  const { width: W, height: H, fps } = size;
  const up = W <= 1920 ? 2 : 1;
  const z = viewExpr(views, "z", transition);
  const cx = viewExpr(views, "cx", transition);
  const cy = viewExpr(views, "cy", transition);
  const vf =
    `scale=${W * up}:${H * up},` +
    `zoompan=z='${z}':x='clip((${cx})*${up}-iw/zoom/2,0,iw-iw/zoom)':y='clip((${cy})*${up}-ih/zoom/2,0,ih-ih/zoom)'` +
    `:d=1:s=${W}x${H}:fps=${n(fps)}`;
  return ["-y", "-i", input, "-vf", vf, ...resolveQuality(quality), "-c:a", "copy", output];
}

export interface AutoOptions {
  /** Seconds between analysed frames (default 0.25). */
  step?: number;
  /** Stay zoomed this long after the last change (default 2). */
  holdSec?: number;
  maxZoom?: number;
  /** A change covering more than this share of the screen is a scene change:
   * zoom out instead of in (default 0.3). */
  globalFraction?: number;
  transition?: number;
}

/** Plan keyframes from a sequence of low-res gray frames (`w` x `h`, one per
 * `step` seconds) of a W x H source: zoom toward localised changes, hold,
 * and zoom out when activity stops or the whole screen changes. Pure. */
export function planAutoZoom(
  frames: Uint8Array[],
  w: number,
  h: number,
  W: number,
  H: number,
  opts: AutoOptions = {},
): ZoomKeyframe[] {
  const step = opts.step ?? 0.25;
  const hold = opts.holdSec ?? 2;
  const maxZoom = opts.maxZoom ?? DEFAULT_AUTO_MAX_ZOOM;
  const globalFraction = opts.globalFraction ?? 0.3;
  const T = opts.transition ?? DEFAULT_TRANSITION_SEC;
  const scale = W / w;
  const minW = W / maxZoom;
  const minH = H / maxZoom;

  type Focus = { start: number; last: number; box: Rect };
  const focuses: Focus[] = [];
  let cur: Focus | null = null;
  const close = () => {
    if (cur) focuses.push(cur);
    cur = null;
  };
  for (let i = 1; i < frames.length; i++) {
    const t = i * step;
    const d = diffFrames(frames[i - 1], frames[i], w, h, { scale });
    if (d.regions.length === 0) {
      if (cur && t - cur.last > hold) close();
      continue;
    }
    if (d.changedFraction > globalFraction) {
      close();
      continue;
    }
    const box = unionRects(d.regions);
    if (cur && t - cur.last <= hold && near(cur.box, box, W, H)) {
      cur.box = unionRects([cur.box, box]);
      cur.last = t;
    } else {
      close();
      cur = { start: t, last: t, box };
    }
  }
  close();

  const kfs: ZoomKeyframe[] = [];
  let lastT = 0;
  for (const f of focuses) {
    const view = fitView(f.box, W, H, minW, minH);
    // Reach the zoom as the change starts; release `hold` after it ends.
    const inAt = Math.max(f.start, lastT + T);
    const outAt = Math.max(f.last + hold, inAt + T);
    kfs.push({ t: round(inAt), ...view }, { t: round(outAt), full: true });
    lastT = outAt;
  }
  return kfs;
}

const round = (v: number) => Math.round(v * 100) / 100;

function unionRects(rs: Rect[]): Rect {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.width));
  const y1 = Math.max(...rs.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Two boxes count as the same area of interest when the union is still
 * small enough to zoom into meaningfully (under half the screen each way). */
function near(a: Rect, b: Rect, W: number, H: number): boolean {
  const u = unionRects([a, b]);
  return u.width <= W / 2 && u.height <= H / 2;
}

/** Pad a box by 20%, grow it to the frame's aspect ratio and the minimum size
 * for maxZoom, and keep it inside the frame. Pure. */
export function fitView(box: Rect, W: number, H: number, minW: number, minH: number): Required<Pick<ZoomKeyframe, "x" | "y" | "width" | "height">> {
  let width = Math.max(box.width * 1.4, minW);
  let height = Math.max(box.height * 1.4, minH);
  const aspect = W / H;
  if (width / height > aspect) height = width / aspect;
  else width = height * aspect;
  width = Math.min(width, W);
  height = Math.min(height, H);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const x = Math.max(0, Math.min(W - width, cx - width / 2));
  const y = Math.max(0, Math.min(H - height, cy - height / 2));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Decode a video to low-res gray frames every `step` seconds, for planning. */
export function buildAnalysisArgs(input: string, size: { width: number; height: number }, step: number): string[] {
  return [
    "-v", "error", "-i", input, "-an",
    "-vf", `fps=${n(1 / step)},scale=${size.width}:${size.height}:flags=area,format=gray`,
    "-f", "rawvideo", "-",
  ];
}
