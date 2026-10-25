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
  rings?: { clicks: ClickPoint[]; color: string },
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
  if (!rings || rings.clicks.length === 0) {
    return ["-y", "-i", input, "-vf", vf, ...resolveQuality(quality), "-c:a", "copy", output];
  }
  // Rings go on before the zoom, in source pixels, so they move with it.
  const graph = [
    "[0:v]null[in]",
    ...ringFilters(rings.clicks, W, H, fps, rings.color),
    `[out]${vf}[v]`,
  ].join(";");
  return [
    "-y", "-i", input, "-filter_complex", graph,
    "-map", "[v]", "-map", "0:a?", ...resolveQuality(quality), "-c:a", "copy", output,
  ];
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

/** A click to zoom toward or ring: video time and position in video pixels. */
export interface ClickPoint {
  t: number;
  x: number;
  y: number;
}

/**
 * Plan keyframes from clicks (#119, from the input event log #118). Clicks
 * less than `holdSec` apart form one zoomed-in run that pans from click to
 * click; the view is reached as each click happens (the ease starts
 * `transition` earlier, so the camera arrives with the cursor) and zooms out
 * `holdSec` after the run's last click. Pure.
 */
export function planClickZoom(clicks: ClickPoint[], W: number, H: number, opts: AutoOptions = {}): ZoomKeyframe[] {
  const hold = opts.holdSec ?? 2;
  const maxZoom = opts.maxZoom ?? DEFAULT_AUTO_MAX_ZOOM;
  const T = opts.transition ?? DEFAULT_TRANSITION_SEC;
  const minW = W / maxZoom;
  const minH = H / maxZoom;
  const pad = Math.min(W, H) * 0.05;
  const sorted = [...clicks].sort((a, b) => a.t - b.t);

  const kfs: ZoomKeyframe[] = [];
  let lastT = 0;
  let runEnd = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const view = fitView({ x: c.x - pad, y: c.y - pad, width: 2 * pad, height: 2 * pad }, W, H, minW, minH);
    const prev = kfs[kfs.length - 1];
    // Already well inside the current view: no pan, just extend the run.
    if (prev && !prev.full && c.t - runEnd <= hold && insideView(prev, c)) {
      runEnd = c.t;
      continue;
    }
    if (c.t - runEnd > hold && kfs.length > 0) {
      // Close the previous run before starting a new one.
      const outAt = Math.max(runEnd + hold, lastT + T);
      kfs.push({ t: round(outAt), full: true });
      lastT = outAt;
    }
    const at = Math.max(c.t, lastT + T);
    kfs.push({ t: round(at), ...view });
    lastT = at;
    runEnd = c.t;
  }
  if (kfs.length > 0) kfs.push({ t: round(Math.max(runEnd + hold, lastT + T)), full: true });
  return kfs;
}

/** True when a point lies in the middle 70% of a view, away from its edges. */
function insideView(v: ZoomKeyframe, p: ClickPoint): boolean {
  const mx = v.width! * 0.15;
  const my = v.height! * 0.15;
  return p.x >= v.x! + mx && p.x <= v.x! + v.width! - mx && p.y >= v.y! + my && p.y <= v.y! + v.height! - my;
}

export const RING_SEC = 0.6;
export const DEFAULT_RING_COLOR = "#FF4545";

/** Ring diameter in pixels for a W x H video: about 9% of the short side. */
export function ringSize(W: number, H: number): number {
  return Math.max(40, 2 * Math.round(Math.min(W, H) * 0.045));
}

/**
 * Filter chains that draw an expanding, fading ring at each click, applied to
 * `[in]` and ending at `[out]`. Each ring is its own short colour source whose
 * radius and alpha follow its own clock T, shifted to the click time. Pure.
 */
export function ringFilters(clicks: ClickPoint[], W: number, H: number, fps: number, color: string): string[] {
  const D = ringSize(W, H);
  const c = D / 2;
  const th = Math.max(3, Math.round(D / 10));
  const r0 = c * 0.3;
  const dr = c - th / 2 - r0;
  const steps: string[] = [];
  let cur = "[in]";
  clicks.forEach((k, i) => {
    // Solid for the first half, then fading; the ring grows the whole time.
    const alpha = `if(lt(abs(hypot(X-${c},Y-${c})-(${n(r0)}+${n(dr)}*T/${RING_SEC})),${th / 2}),255*min(1,2-2*T/${RING_SEC}),0)`;
    steps.push(
      `color=c=${color}:s=${D}x${D}:r=${n(fps)}:d=${RING_SEC},format=rgba,` +
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}',setpts=PTS+${n(k.t)}/TB[ring${i}]`,
    );
    const out = i === clicks.length - 1 ? "[out]" : `[r${i}]`;
    steps.push(`${cur}[ring${i}]overlay=x=${n(k.x - c)}:y=${n(k.y - c)}:eof_action=pass${out}`);
    cur = `[r${i}]`;
  });
  return steps;
}
