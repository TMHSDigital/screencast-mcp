/**
 * Backdrop (#171): frame a capture on a gradient, solid, or wallpaper
 * background with padding, rounded corners, and a soft drop shadow, optionally
 * on a fixed output aspect (16:9, 1:1, 9:16, 4:5). Works on a video or a still.
 *
 * Everything static is drawn once: a single-frame "frame" image (background,
 * shadow, and a transparent rounded hole where the content goes) is built in
 * the graph from lavfi sources, and overlaid on the content padded to the
 * canvas. The content stays the main overlay input, so the output keeps its
 * timing (a variable-frame-rate capture stays VFR) and per-frame work is one
 * pad and one overlay. Builders are pure.
 */
import { ScreencastError } from "./errors.js";
import { validateColor } from "./validate.js";
import { ASPECT_DIMS, type Aspect } from "./produce.js";
import { resolveQuality, type Quality } from "./targets.js";
import { stillOutput } from "./paths.js";

/** Named looks in the project's REC/timecode palette (docs/site.css). */
export const BACKDROP_PRESETS = {
  /** The site's desktop: a quiet near-black slate. */
  desktop: ["#1B2330", "#0A0D12"],
  /** Record-light red into a deep oxblood. */
  rec: ["#FF4545", "#5C0F1A"],
  /** Timecode amber into REC red. */
  amber: ["#FFB454", "#FF4545"],
  /** A pale panel for light-themed UIs. */
  light: ["#F4F7FA", "#B9C4D0"],
} as const satisfies Record<string, readonly string[]>;
export type BackdropPreset = keyof typeof BACKDROP_PRESETS;
export const BACKDROP_PRESET_NAMES = Object.keys(BACKDROP_PRESETS) as [BackdropPreset, ...BackdropPreset[]];
export const DEFAULT_BACKDROP_PRESET: BackdropPreset = "desktop";

/** gradients takes at most 8 colors; 4 keeps the schema small. */
export const MAX_BACKDROP_COLORS = 4;
export const DEFAULT_SHADOW_OPACITY = 0.5;

export interface BackdropOptions {
  /** A named gradient (default desktop); ignored when colors or image is set. */
  preset?: BackdropPreset;
  /** 1 color = solid, 2-4 = a diagonal gradient. */
  colors?: string[];
  /** A wallpaper image, scaled to cover the canvas (the caller checks it exists). */
  image?: string;
  /** Space around the content in px (rounded to even). Default 6% of the longer side. */
  padding?: number;
  /** Corner radius in px. Default 1.2% of the content's longer side; 0 = square. */
  radius?: number;
  /** Shadow blur in px. Default 2.5% of the content's longer side; 0 = none. */
  shadow?: number;
  /** Shadow opacity 0-1 (default 0.5). */
  shadowOpacity?: number;
  /** Put the result on this aspect's canvas (ASPECT_DIMS), scaling the content to fit. */
  aspect?: Aspect;
}

export interface BackdropLayout {
  canvasW: number;
  canvasH: number;
  /** Content size on the canvas (after any scale). */
  contentW: number;
  contentH: number;
  /** Content position on the canvas (even, so a 4:2:0 pad does not shift it). */
  x: number;
  y: number;
  padding: number;
  radius: number;
  shadow: number;
  /** How far the shadow drops below the content, in px. */
  shadowOffset: number;
  /** True when the content is scaled to fit an aspect canvas. */
  scaled: boolean;
}

const even = (n: number) => 2 * Math.round(n / 2);
const evenDown = (n: number) => 2 * Math.floor(n / 2);

function nonNegInt(v: number | undefined, label: string, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || v < 0 || v > max) throw new ScreencastError(`${label} must be between 0 and ${max}.`);
  return Math.round(v);
}

/** Canvas and content geometry for a W x H source. Pure. */
export function backdropLayout(W: number, H: number, opts: BackdropOptions = {}): BackdropLayout {
  if (!(W > 0 && H > 0)) throw new ScreencastError("The input has no frame size.");
  const padOpt = nonNegInt(opts.padding, "padding", 2000);
  const radiusOpt = nonNegInt(opts.radius, "radius", 1000);
  const shadowOpt = nonNegInt(opts.shadow, "shadow", 200);

  let canvasW: number;
  let canvasH: number;
  let contentW = W;
  let contentH = H;
  let x: number;
  let y: number;
  let padding: number;
  let scaled = false;
  if (opts.aspect) {
    const dim = ASPECT_DIMS[opts.aspect];
    if (!dim) throw new ScreencastError(`Unknown aspect "${opts.aspect}".`);
    canvasW = dim.w;
    canvasH = dim.h;
    padding = even(padOpt ?? Math.max(canvasW, canvasH) * 0.06);
    const availW = canvasW - 2 * padding;
    const availH = canvasH - 2 * padding;
    if (availW < 16 || availH < 16) throw new ScreencastError(`padding ${padding} leaves no room on a ${opts.aspect} canvas.`);
    const s = Math.min(availW / W, availH / H);
    contentW = Math.max(2, evenDown(W * s));
    contentH = Math.max(2, evenDown(H * s));
    scaled = contentW !== W || contentH !== H;
    x = evenDown((canvasW - contentW) / 2);
    y = evenDown((canvasH - contentH) / 2);
  } else {
    padding = even(padOpt ?? Math.max(W, H) * 0.06);
    // An odd source still gets an even canvas (4:2:0 video needs one): the
    // extra column or row goes on the right or bottom.
    canvasW = W + 2 * padding + (W % 2);
    canvasH = H + 2 * padding + (H % 2);
    x = padding;
    y = padding;
  }
  const longer = Math.max(contentW, contentH);
  const radius = Math.min(radiusOpt ?? Math.round(longer * 0.012), Math.floor(Math.min(contentW, contentH) / 2));
  const shadow = shadowOpt ?? Math.round(longer * 0.025);
  const below = canvasH - y - contentH;
  const shadowOffset = shadow > 0 ? Math.max(0, Math.min(Math.round(shadow / 2), below)) : 0;
  return { canvasW, canvasH, contentW, contentH, x, y, padding, radius, shadow, shadowOffset, scaled };
}

/** The colors a backdrop draws: explicit colors, else the preset's. Pure. */
export function backdropColors(opts: BackdropOptions): string[] {
  if (opts.colors !== undefined) {
    if (opts.colors.length < 1 || opts.colors.length > MAX_BACKDROP_COLORS) {
      throw new ScreencastError(`colors takes 1 to ${MAX_BACKDROP_COLORS} colors.`);
    }
    return opts.colors.map((c, i) => validateColor(c, `colors[${i}]`));
  }
  const preset = opts.preset ?? DEFAULT_BACKDROP_PRESET;
  const colors = BACKDROP_PRESETS[preset];
  if (!colors) throw new ScreencastError(`Unknown backdrop preset "${preset}".`);
  return [...colors];
}

/** geq luma for a rounded-rectangle mask the size of its plane (W x H):
 * 255 inside, 0 outside, antialiased over one pixel at the corners. `invert`
 * gives the hole (0 inside). Pure. */
export function roundedMaskExpr(radius: number, invert = false): string {
  const r = radius;
  const dx = `max(max(${r}-X-0.5,X+0.5-(W-${r})),0)`;
  const dy = `max(max(${r}-Y-0.5,Y+0.5-(H-${r})),0)`;
  const inside = `clip(${r}+0.5-hypot(${dx},${dy}),0,1)`;
  return invert ? `255-255*${inside}` : `255*${inside}`;
}

/**
 * Filter steps that put the stream labelled `input` (a W x H frame) on a
 * backdrop. A wallpaper `image` becomes an extra input numbered `firstInput`
 * (its args are in extraInputs). Labels are prefixed with `tag`. Shared by
 * backdrop and pipeline. Pure.
 */
export function backdropSteps(
  opts: BackdropOptions,
  src: { width: number; height: number },
  input: string,
  firstInput: number,
  tag: string,
  still = false,
): { steps: string[]; out: string; extraInputs: string[]; layout: BackdropLayout } {
  const L = backdropLayout(src.width, src.height, opts);
  if (opts.shadowOpacity !== undefined && !(opts.shadowOpacity >= 0 && opts.shadowOpacity <= 1)) {
    throw new ScreencastError("shadowOpacity must be between 0 and 1.");
  }
  const opacity = opts.shadowOpacity ?? DEFAULT_SHADOW_OPACITY;
  const { canvasW: CW, canvasH: CH, contentW: w, contentH: h, x, y } = L;
  const one = ":r=1:d=1"; // a single frame: everything static is drawn once
  const steps: string[] = [];
  const extraInputs: string[] = [];

  // Background, one frame, canvas-sized.
  const bg = `[${tag}bg]`;
  if (opts.image) {
    extraInputs.push("-i", opts.image);
    steps.push(
      `[${firstInput}:v]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},setsar=1,trim=end_frame=1,format=rgba${bg}`,
    );
  } else {
    const colors = backdropColors(opts);
    if (colors.length === 1) {
      steps.push(`color=c=${colors[0]}:s=${CW}x${CH}${one},format=rgba${bg}`);
    } else {
      const cs = colors.map((c, i) => `c${i}=${c}`).join(":");
      // x0..y1 fix the line (unset, gradients picks a random one); the first
      // frame is not yet rotated, and trim keeps only it.
      steps.push(
        `gradients=s=${CW}x${CH}:${cs}:n=${colors.length}:x0=0:y0=0:x1=${CW}:y1=${CH}:r=1,trim=end_frame=1,format=rgba${bg}`,
      );
    }
  }

  // Shadow: the content's rounded shape, dropped and blurred, as the alpha of
  // a black layer over the background.
  let base = bg;
  if (L.shadow > 0 && opacity > 0) {
    const sa = `[${tag}sa]`;
    const sc = `[${tag}sc]`;
    const sh = `[${tag}sh]`;
    const bs = `[${tag}bs]`;
    const shape = L.radius > 0 ? `format=gray,geq=lum='${roundedMaskExpr(L.radius)}'` : "format=gray";
    steps.push(
      `color=c=white:s=${w}x${h}${one},${shape},pad=${CW}:${CH}:${x}:${y + L.shadowOffset}:color=black,` +
        `gblur=sigma=${(L.shadow / 2).toFixed(2)}${sa}`,
    );
    steps.push(`color=c=black:s=${CW}x${CH}${one}${sc}`);
    steps.push(`${sc}${sa}alphamerge,format=rgba,colorchannelmixer=aa=${opacity}${sh}`);
    steps.push(`${base}${sh}overlay=0:0:format=rgb${bs}`);
    base = bs;
  }

  // The frame: background (+ shadow) with a transparent rounded hole for the content.
  const hole = `[${tag}hole]`;
  const frame = `[${tag}frame]`;
  const holeShape = L.radius > 0 ? `format=gray,geq=lum='${roundedMaskExpr(L.radius, true)}'` : "format=gray";
  steps.push(`color=c=black:s=${w}x${h}${one},${holeShape},pad=${CW}:${CH}:${x}:${y}:color=white${hole}`);
  steps.push(`${base}${hole}alphamerge,format=rgba${frame}`);

  // Per frame: pad the content onto the canvas and lay the frame over it.
  const padded = `[${tag}pad]`;
  const out = `[${tag}bd]`;
  const fit = L.scaled ? `scale=${w}:${h},setsar=1,` : "";
  steps.push(`${input}${fit}pad=${CW}:${CH}:${x}:${y}:color=black${padded}`);
  steps.push(`${padded}${frame}overlay=0:0${still ? ":format=rgb" : ""}${out}`);
  return { steps, out, extraInputs, layout: L };
}

/** Put a video (or, with `still`, one image) on a backdrop. Pure. */
export function buildBackdropArgs(
  input: string,
  output: string,
  opts: BackdropOptions,
  src: { width: number; height: number },
  still = false,
  quality: Quality = "standard",
): { args: string[]; layout: BackdropLayout } {
  const { steps, out, extraInputs, layout } = backdropSteps(opts, src, "[0:v]", 1, "", still);
  const final = "[vout]";
  steps.push(`${out}format=${still ? "rgb24" : "yuv420p"}${final}`);
  const head = ["-y", "-i", input, ...extraInputs, "-filter_complex", steps.join(";"), "-map", final];
  const args = still
    ? [...head, "-frames:v", "1", ...stillOutput(output)]
    : [...head, "-map", "0:a?", ...resolveQuality(quality), "-c:a", "copy", "-movflags", "+faststart", output];
  return { args, layout };
}
