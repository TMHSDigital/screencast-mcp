/**
 * Timed annotations (#121): boxes, text labels, and arrows that appear over a
 * video between two timestamps. Boxes and text are drawbox / drawtext with an
 * `enable` window. ffmpeg cannot draw an arbitrary line, so an arrow is drawn
 * as an image (a shaft plus a triangular head, via geq), rotated to its angle,
 * and overlaid centred on the arrow's midpoint. Builders are pure.
 */
import { ScreencastError } from "./errors.js";
import { escapeFilterPath } from "./fonts.js";
import { enableExpr } from "./media.js";
import { resolveQuality, type Quality } from "./targets.js";
import { validateColor } from "./validate.js";
import { stillOutput } from "./paths.js";

interface Timed {
  /** Show from this second (default: start of video). */
  from?: number;
  /** Hide after this second (default: end of video). */
  to?: number;
  color?: string;
}
export interface BoxCallout extends Timed {
  type: "box";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Outline thickness in px (default 4); ignored when fill is set. */
  thickness?: number;
  /** Fill the box instead of outlining it. */
  fill?: boolean;
}
export interface TextCallout extends Timed {
  type: "text";
  x: number;
  y: number;
  text: string;
  /** Font size in px (default 32). */
  size?: number;
  /** Draw a translucent dark panel behind the text (default true). */
  background?: boolean;
}
export interface ArrowCallout extends Timed {
  type: "arrow";
  /** Tail. */
  x1: number;
  y1: number;
  /** Head (the point the arrow points at). */
  x2: number;
  y2: number;
  /** Shaft thickness in px (default 8). */
  thickness?: number;
}
export type Callout = BoxCallout | TextCallout | ArrowCallout;

const nonNeg = (v: number, label: string) => {
  if (!Number.isFinite(v) || v < 0) throw new ScreencastError(`${label} must be a non-negative number.`);
  return Math.round(v);
};

function enable(c: Timed): string {
  const e = enableExpr(c.from, c.to);
  return e ? `:enable='${e}'` : "";
}

/** Geometry of an arrow image: its length, thickness, rotation (radians,
 * clockwise in screen coordinates), and centre. Pure. */
export function arrowGeometry(a: ArrowCallout): { length: number; thickness: number; angle: number; cx: number; cy: number } {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const length = Math.round(Math.hypot(dx, dy));
  const thickness = Math.max(2, Math.round(a.thickness ?? 8));
  if (length < thickness * 3) throw new ScreencastError("An arrow must be at least three times as long as it is thick.");
  return { length, thickness, angle: Math.atan2(dy, dx), cx: (a.x1 + a.x2) / 2, cy: (a.y1 + a.y2) / 2 };
}

/** Render one arrow, already rotated, as a transparent PNG. Pure args. */
export function buildArrowImageArgs(a: ArrowCallout, output: string): string[] {
  const { length, thickness, angle } = arrowGeometry(a);
  const color = validateColor(a.color ?? "red");
  const head = thickness * 3;
  const ang = angle.toFixed(6);
  // Opaque where: the shaft (|y - mid| < t/2 before the head), or inside the
  // triangular head (|y - mid| < remaining length / 2).
  const alpha = `if(lt(X,W-H),if(lt(abs(Y-H/2),${thickness}/2),255,0),if(lt(abs(Y-H/2),(W-X)/2),255,0))`;
  return [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=${length}x${head}`,
    "-vf", `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}',rotate=a=${ang}:ow=rotw(${ang}):oh=roth(${ang}):c=none`,
    "-frames:v", "1",
    ...stillOutput(output),
  ];
}

export interface CalloutAssets {
  fontFile: string;
  /** Per item: the text file for a text callout, else null. */
  textFiles: Array<string | null>;
  /** Per item: the rendered arrow PNG for an arrow callout, else null. */
  arrowFiles: Array<string | null>;
}

/** Filter steps that draw every callout over the stream labelled `input`
 * (later items on top). Arrow images become extra inputs numbered from
 * `firstInput`; labels are prefixed with `tag`. Shared by callout and
 * pipeline. Pure. */
export function calloutSteps(
  items: Callout[],
  assets: CalloutAssets,
  input: string,
  firstInput: number,
  tag: string,
): { steps: string[]; out: string; extraInputs: string[] } {
  if (items.length === 0) throw new ScreencastError("Give at least one callout.");
  const extraInputs: string[] = [];
  const steps: string[] = [];
  let cur = input;
  items.forEach((c, i) => {
    const out = `[${tag}c${i}]`;
    if (c.type === "box") {
      const color = validateColor(c.color ?? "red");
      const t = c.fill ? "fill" : String(Math.max(1, Math.round(c.thickness ?? 4)));
      steps.push(
        `${cur}drawbox=x=${nonNeg(c.x, "x")}:y=${nonNeg(c.y, "y")}:w=${nonNeg(c.width, "width")}:h=${nonNeg(c.height, "height")}` +
          `:color=${color}:t=${t}${enable(c)}${out}`,
      );
    } else if (c.type === "text") {
      const file = assets.textFiles[i];
      if (!file) throw new ScreencastError("Internal: missing text file for a text callout.");
      const color = validateColor(c.color ?? "white");
      const size = Math.max(8, Math.round(c.size ?? 32));
      const panel = c.background === false ? "" : `:box=1:boxcolor=black@0.6:boxborderw=${Math.round(size / 3)}`;
      steps.push(
        `${cur}drawtext=fontfile=${escapeFilterPath(assets.fontFile)}:textfile=${escapeFilterPath(file)}:expansion=none` +
          `:x=${nonNeg(c.x, "x")}:y=${nonNeg(c.y, "y")}:fontsize=${size}:fontcolor=${color}${panel}${enable(c)}${out}`,
      );
    } else {
      const file = assets.arrowFiles[i];
      if (!file) throw new ScreencastError("Internal: missing image for an arrow callout.");
      const { cx, cy } = arrowGeometry(c);
      const n = firstInput + extraInputs.length / 4;
      extraInputs.push("-loop", "1", "-i", file);
      steps.push(`${cur}[${n}:v]overlay=x=${cx.toFixed(1)}-w/2:y=${cy.toFixed(1)}-h/2:shortest=1${enable(c)}${out}`);
    }
    cur = out;
  });
  return { steps, out: cur, extraInputs };
}

/** Draw every callout in order (later items on top). Pure. */
export function buildCalloutArgs(
  input: string,
  output: string,
  items: Callout[],
  assets: CalloutAssets,
  quality: Quality = "standard",
): string[] {
  const { steps, out, extraInputs } = calloutSteps(items, assets, "[0:v]", 1, "");
  return [
    "-y", "-i", input, ...extraInputs,
    "-filter_complex", steps.join(";"),
    "-map", out, "-map", "0:a?",
    ...resolveQuality(quality),
    "-c:a", "copy",
    output,
  ];
}
