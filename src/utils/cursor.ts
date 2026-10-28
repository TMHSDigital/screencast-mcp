/**
 * Re-rendered cursor (#170): record without the OS cursor (start_recording
 * cursor: "events"), then draw a smoothed, scaled, auto-hiding one from the
 * input event log, with a ripple on clicks and an optional spotlight.
 *
 * The log samples the cursor at most every MOVE_SAMPLE_MS while it moves, on
 * the video's clock and in video pixels. Those samples become a target path; a
 * critically damped spring follows it (led by its own lag, so the drawn cursor
 * arrives on time), and the result is simplified to straight segments a
 * fraction of a pixel from the curve.
 *
 * Every per-frame value (the sprite's x/y, its visibility, the spotlight and
 * click ripple positions) is driven by a sendcmd file: one command per segment
 * sets overlay x/y to that segment's linear expression in t, and `enable`
 * commands show and hide the layers. That keeps the work per frame constant
 * however long the recording is, where one big expression would grow with it.
 *
 * Paths are planned on the source's clock and pixels; transformCursor moves
 * them through a pipeline's earlier trims, speed changes and cuts (the same
 * TimeOps as markers and keystroke badges) and crops and scales. Everything
 * here is pure.
 */
import { fileURLToPath } from "node:url";
import { ScreencastError } from "./errors.js";
import { escapeFilterPath } from "./fonts.js";
import { MOVE_SAMPLE_MS, type InputEvent } from "./events.js";
import type { TimeOp } from "./chapters.js";
import { mapTime, mapWindow } from "./timeline.js";
import { resolveQuality, type Quality } from "./targets.js";

/** assets/cursor/arrow.png (scripts/make-cursor-sprite.mjs): its size, the
 * tip's pixel (the hotspot), and the arrow's height without outline/shadow. */
export const CURSOR_SPRITE = { w: 114, h: 168, hotX: 9, hotY: 9, arrowH: 135 } as const;

/** The bundled cursor sprite. Resolved from dist/utils/, like the fonts. */
export function cursorSpritePath(): string {
  return fileURLToPath(new URL("../../assets/cursor/arrow.png", import.meta.url));
}

export interface PathPoint {
  /** Seconds. */
  t: number;
  x: number;
  y: number;
}

export interface CursorPlan {
  /** The cursor tip over time; linear between points, held after the last. */
  path: PathPoint[];
  /** When the cursor shows, [from, to); `to` may be Infinity (never hides). */
  visible: Array<[number, number]>;
  /** Mouse button presses, where they happened. */
  clicks: PathPoint[];
}

export interface CursorPlanOptions {
  /** 0 = the logged path as is, 1 = very floaty (default 0.5). */
  smoothing?: number;
  /** Hide after this long without mouse input; 0 = never (default 2). */
  hideAfterSec?: number;
}

export interface CursorStyle {
  /** Cursor size relative to a typical one at the frame's height (default 1.5). */
  size?: number;
  /** A ripple at each click (default true). */
  clicks?: boolean;
  /** Dim everything but a circle around the cursor (default false). */
  spotlight?: boolean;
}

export const DEFAULT_SMOOTHING = 0.5;
export const DEFAULT_HIDE_AFTER_SEC = 2;
export const DEFAULT_CURSOR_SIZE = 1.5;
/** How long a click ripple lasts (s). */
export const RIPPLE_SEC = 0.4;
/** Simulation step and the path's sample rate. */
const SIM_HZ = 240;
const PATH_EVERY = 4; // 60 Hz path
/** Simplified segments stay this close (px) to the smoothed curve. */
const SIMPLIFY_PX = 0.35;

const POSITION_TYPES = new Set(["move", "down", "up", "wheel"]);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The spring's angular frequency and the lead that cancels its lag, for a
 * smoothing amount (0 < s <= 1). Pure. */
export function springFor(smoothing: number): { omega: number; lead: number } {
  const omega = 6 + (1 - smoothing) * 34;
  return { omega, lead: Math.min(2 / omega, 0.2) };
}

/** Logged positions as a target path: linear while the cursor moves, held
 * while it rests (a sample after a pause starts from the old spot one sample
 * interval earlier, rather than drifting there across the pause). Pure. */
export function targetPath(samples: readonly PathPoint[]): PathPoint[] {
  const out: PathPoint[] = [];
  const step = MOVE_SAMPLE_MS / 1000;
  for (const s of samples) {
    const prev = out.at(-1);
    if (prev && s.t - prev.t > step * 2 && (prev.x !== s.x || prev.y !== s.y)) {
      out.push({ t: s.t - step, x: prev.x, y: prev.y });
    }
    if (prev && s.t === prev.t) out[out.length - 1] = s;
    else out.push(s);
  }
  return out;
}

/** The path's position at t (held before the first and after the last point). Pure. */
export function pathAt(path: readonly PathPoint[], t: number, from = 0): { x: number; y: number; i: number } {
  if (path.length === 0) return { x: 0, y: 0, i: 0 };
  let i = Math.max(0, Math.min(from, path.length - 1));
  while (i > 0 && path[i]!.t > t) i--;
  while (i < path.length - 1 && path[i + 1]!.t <= t) i++;
  const a = path[i]!;
  const b = path[i + 1];
  if (!b || t <= a.t) return { x: a.x, y: a.y, i };
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, i };
}

/** Follow `target` with a critically damped spring from `from` to `to`,
 * sampled at 60 Hz. The target is read `lead` seconds ahead, so the spring's
 * lag is cancelled and the cursor arrives where (and when) the real one did.
 * Pure. */
export function springPath(target: readonly PathPoint[], omega: number, lead: number, from: number, to: number): PathPoint[] {
  if (target.length === 0) return [];
  const dt = 1 / SIM_HZ;
  let hint = 0;
  const at = (t: number) => {
    const p = pathAt(target, t + lead, hint);
    hint = p.i;
    return p;
  };
  const start = at(from);
  let x = start.x;
  let y = start.y;
  let vx = 0;
  let vy = 0;
  const out: PathPoint[] = [{ t: r3(from), x, y }];
  const e = Math.exp(-omega * dt);
  const steps = Math.max(0, Math.ceil((to - from) * SIM_HZ));
  for (let n = 1; n <= steps; n++) {
    const t = Math.min(to, from + n * dt);
    const p = at(t);
    // Exact critically damped step toward a target held over dt.
    const cx = x - p.x;
    const cy = y - p.y;
    const tx = (vx + omega * cx) * dt;
    const ty = (vy + omega * cy) * dt;
    vx = (vx - omega * tx) * e;
    vy = (vy - omega * ty) * e;
    x = p.x + (cx + tx) * e;
    y = p.y + (cy + ty) * e;
    if (n % PATH_EVERY === 0 || n === steps) out.push({ t: r3(t), x, y });
  }
  return out;
}

/** Drop points that lie within `tol` px of the straight segment between
 * their neighbours in time (Ramer-Douglas-Peucker, iterative). Pure. */
export function simplifyPath(path: readonly PathPoint[], tol = SIMPLIFY_PX): PathPoint[] {
  if (path.length <= 2) return [...path];
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const A = path[a]!;
    const B = path[b]!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const P = path[i]!;
      const f = B.t > A.t ? (P.t - A.t) / (B.t - A.t) : 0;
      const d = Math.hypot(P.x - (A.x + (B.x - A.x) * f), P.y - (A.y + (B.y - A.y) * f));
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return path.filter((_, i) => keep[i] === 1);
}

/** Merge overlapping windows. Pure. */
function mergeWindows(ws: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const w of [...ws].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/**
 * Plan the cursor from an event log, on the source's clock and pixels:
 * the smoothed path (to `endSec`, the video's length, when known), when it
 * shows, and the clicks. An empty plan means the log has no positions. Pure.
 */
export function planCursor(events: readonly InputEvent[], opts: CursorPlanOptions = {}, endSec: number | null = null): CursorPlan {
  const smoothing = opts.smoothing ?? DEFAULT_SMOOTHING;
  if (!(smoothing >= 0 && smoothing <= 1)) throw new ScreencastError("smoothing must be between 0 and 1.");
  const hideAfter = opts.hideAfterSec ?? DEFAULT_HIDE_AFTER_SEC;
  if (!(hideAfter >= 0)) throw new ScreencastError("hideAfterSec must be 0 or more.");
  const samples = events
    .filter((e) => POSITION_TYPES.has(e.type) && Number.isFinite(e.t) && e.t >= 0 && Number.isFinite(e.x) && Number.isFinite(e.y))
    .filter((e) => endSec === null || e.t <= endSec)
    .sort((a, b) => a.t - b.t);
  if (samples.length === 0) return { path: [], visible: [], clicks: [] };
  const target = targetPath(samples.map((e) => ({ t: e.t, x: e.x, y: e.y })));
  const first = target[0]!.t;
  const last = target.at(-1)!.t;
  let path: PathPoint[];
  let lead = 0;
  if (smoothing === 0) {
    path = target.map((p) => ({ ...p }));
    if (endSec !== null && endSec > last) path.push({ ...target.at(-1)!, t: endSec });
  } else {
    const spring = springFor(smoothing);
    lead = spring.lead;
    const from = Math.max(0, first - lead);
    // Run until the video ends (or the spring has settled, with no length).
    const to = Math.max(from, endSec ?? last + 8 / spring.omega);
    path = springPath(target, spring.omega, lead, from, to);
  }
  const start = Math.max(0, first - lead);
  const visible: Array<[number, number]> =
    hideAfter === 0
      ? [[start, endSec ?? Infinity]]
      : mergeWindows(samples.map((e) => [Math.max(0, e.t - lead), e.t + hideAfter]));
  const clicks = samples.filter((e) => e.type === "down").map((e) => ({ t: e.t, x: e.x, y: e.y }));
  return {
    path,
    visible: visible.map(([a, b]) => [r3(a), endSec !== null ? Math.min(b, endSec) : b] as [number, number]).filter(([a, b]) => b > a),
    clicks,
  };
}

/** Source pixels -> the step's pixels: x * sx + ox (crops and scales). */
export interface Geometry {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
}

const IDENTITY: Geometry = { sx: 1, sy: 1, ox: 0, oy: 0 };

/** A plan on the source's clock and pixels moved through timing changes
 * (trims, speed, cuts) and a crop/scale geometry, then simplified. Pure. */
export function transformCursor(plan: CursorPlan, ops: readonly TimeOp[] = [], geo: Geometry = IDENTITY): CursorPlan {
  const move = (p: PathPoint): PathPoint | null => {
    const t = mapTime(p.t, ops);
    return t === null ? null : { t: r3(t), x: p.x * geo.sx + geo.ox, y: p.y * geo.sy + geo.oy };
  };
  const path: PathPoint[] = [];
  for (const p of plan.path) {
    const m = move(p);
    if (!m) continue;
    // A cut maps a removed stretch onto one instant: keep where it ends.
    if (path.length > 0 && path.at(-1)!.t >= m.t) path[path.length - 1] = { ...m, t: path.at(-1)!.t };
    else path.push(m);
  }
  const visible = plan.visible.flatMap(([a, b]) => {
    const w = mapWindow(a, b, ops);
    return w && w[1] - w[0] >= 0.05 ? [[r3(w[0]), Number.isFinite(w[1]) ? r3(w[1]) : w[1]] as [number, number]] : [];
  });
  const clicks = plan.clicks.flatMap((c) => {
    const m = move(c);
    return m ? [m] : [];
  });
  return { path: simplifyPath(path), visible, clicks };
}

const num = (n: number, d = 2) => {
  const v = Number(n.toFixed(d));
  return Object.is(v, -0) ? "0" : String(v);
};

/** `v0 + (t - t0) * k` as an ffmpeg expression (no spaces or commas, so it
 * needs no quoting in a sendcmd file). Pure. */
export function linearExpr(v0: number, t0: number, k: number): string {
  const kk = Number(k.toFixed(3));
  if (kk === 0) return num(v0);
  return `${num(v0)}${kk < 0 ? "-" : "+"}(t-${num(t0, 3)})*${num(Math.abs(kk), 3)}`;
}

export interface CursorLayout {
  /** Scaled sprite size and where its tip is. */
  spriteW: number;
  spriteH: number;
  hotX: number;
  hotY: number;
  /** Ripple diameters (px), smallest first. */
  ripples: number[];
  spotRadius: number;
}

/** Sizes for a frame height. Pure. */
export function cursorLayout(frameH: number, size = DEFAULT_CURSOR_SIZE): CursorLayout {
  if (!(size >= 0.25 && size <= 8)) throw new ScreencastError("size must be between 0.25 and 8.");
  const arrowH = Math.max(8, frameH * 0.025 * size);
  const k = arrowH / CURSOR_SPRITE.arrowH;
  const d = Math.max(12, Math.round(arrowH * 2.2));
  return {
    spriteW: Math.max(2, Math.round(CURSOR_SPRITE.w * k)),
    spriteH: Math.max(2, Math.round(CURSOR_SPRITE.h * k)),
    hotX: CURSOR_SPRITE.hotX * k,
    hotY: CURSOR_SPRITE.hotY * k,
    ripples: [0.45, 0.72, 1].map((f) => Math.max(6, Math.round((d * f) / 2) * 2)),
    spotRadius: Math.max(24, Math.round(frameH * 0.12)),
  };
}

interface Command {
  t: number;
  text: string;
}

/** The sendcmd script: `<t> <target> <command> <arg>, ...;` per instant. Pure. */
export function formatCommands(cmds: Command[]): string {
  const byTime = new Map<string, string[]>();
  for (const c of [...cmds].sort((a, b) => a.t - b.t)) {
    const key = num(Math.max(0, c.t), 3);
    const list = byTime.get(key) ?? [];
    list.push(c.text);
    byTime.set(key, list);
  }
  return [...byTime.entries()].map(([t, list]) => `${t} ${list.join(", ")};`).join("\n") + "\n";
}

/** Commands that move overlay `target` along the path, offset by (dx, dy). Pure. */
function pathCommands(path: readonly PathPoint[], target: string, dx: number, dy: number): Command[] {
  return path.map((p, i) => {
    const n = path[i + 1];
    const span = n ? n.t - p.t : 0;
    const kx = n && span > 0 ? (n.x - p.x) / span : 0;
    const ky = n && span > 0 ? (n.y - p.y) / span : 0;
    return {
      t: p.t,
      text: `${target} x ${linearExpr(p.x + dx, p.t, kx)}, ${target} y ${linearExpr(p.y + dy, p.t, ky)}`,
    };
  });
}

/** Commands that enable overlay `target` inside each window. Pure. */
function windowCommands(windows: ReadonlyArray<readonly [number, number]>, target: string): Command[] {
  return windows.flatMap(([a, b]) => [
    { t: a, text: `${target} enable 1` },
    ...(Number.isFinite(b) ? [{ t: b, text: `${target} enable 0` }] : []),
  ]);
}

/**
 * Filter steps that draw the cursor over `input` (a W x H frame): the sprite
 * is extra input `firstInput` (see extraInputs), and `commandsFile` must hold
 * the returned `commands` when ffmpeg runs. Labels and filter names are
 * prefixed with `tag`. Shared by the cursor tool and pipeline. Pure.
 */
export function cursorSteps(
  plan: CursorPlan,
  style: CursorStyle,
  frame: { width: number; height: number },
  input: string,
  firstInput: number,
  tag: string,
  sprite: string,
  commandsFile: string,
): { steps: string[]; out: string; extraInputs: string[]; commands: string } {
  if (plan.path.length === 0) throw new ScreencastError("No cursor positions to draw.");
  const L = cursorLayout(frame.height, style.size);
  const { width: W, height: H } = frame;
  const name = (s: string) => `overlay@${tag}c${s}`;
  const steps: string[] = [];
  const cmds: Command[] = [];
  const p0 = plan.path[0]!;
  let cur = `[${tag}cm]`;
  steps.push(`${input}sendcmd=f=${escapeFilterPath(commandsFile)}${cur}`);
  const layer = (src: string, id: string, dx: number, dy: number, windows: ReadonlyArray<readonly [number, number]>) => {
    const out = `[${tag}c${id}o]`;
    steps.push(`${cur}${src}${name(id)}=x=${num(p0.x + dx)}:y=${num(p0.y + dy)}:enable=0${out}`);
    cmds.push(...windowCommands(windows, name(id)));
    cur = out;
  };

  // Spotlight: a frame-sized dark layer twice the frame's size with a soft
  // hole in its middle, centred on the cursor. Drawn once at quarter size.
  if (style.spotlight) {
    const q = 4;
    const mw = Math.ceil((2 * W) / q);
    const mh = Math.ceil((2 * H) / q);
    const r = L.spotRadius / q;
    const feather = r * 0.8;
    const a = `255*0.55*clip((hypot(X-${num(mw / 2)},Y-${num(mh / 2)})-${num(r)})/${num(feather)},0,1)`;
    steps.push(`color=c=black:s=${mw}x${mh}:r=1:d=1,format=rgba,geq=r=0:g=0:b=0:a='${a}',scale=${2 * W}:${2 * H}[${tag}csm]`);
    // Centre the hole a little into the arrow, not on its very tip.
    const cx = L.spriteW * 0.25 - W;
    const cy = L.spriteH * 0.3 - H;
    layer(`[${tag}csm]`, "s", cx, cy, plan.visible);
    cmds.push(...pathCommands(plan.path, name("s"), cx, cy));
  }

  // Click ripples: three rings, small to large, each for a third of RIPPLE_SEC.
  if (style.clicks !== false && plan.clicks.length > 0) {
    const third = RIPPLE_SEC / 3;
    L.ripples.forEach((d, k) => {
      const c = d / 2;
      const th = Math.max(1.5, d * 0.05);
      const dist = `abs(hypot(X-${num(c - 0.5)},Y-${num(c - 0.5)})-${num(c - th - 1)})`;
      const alpha = [0.9, 0.65, 0.4][k]!;
      // White core, dark rim: visible on light and dark screens.
      const white = `255*lt(${dist},${num(th * 0.45)})`;
      steps.push(
        `color=c=black:s=${d}x${d}:r=1:d=1,format=rgba,geq=r='${white}':g='${white}':b='${white}':` +
          `a='255*${alpha}*clip(${num(th)}-${dist},0,1)'[${tag}cr${k}]`,
      );
      const windows = plan.clicks.map((p) => [p.t + k * third, p.t + (k + 1) * third] as const);
      layer(`[${tag}cr${k}]`, `r${k}`, -c, -c, []);
      for (const [i, p] of plan.clicks.entries()) {
        const [a, b] = windows[i]!;
        const next = windows[i + 1];
        cmds.push({ t: a, text: `${name(`r${k}`)} x ${num(p.x - c)}, ${name(`r${k}`)} y ${num(p.y - c)}, ${name(`r${k}`)} enable 1` });
        // A quick second click takes the ring over; do not hide it early.
        if (!next || next[0] >= b) cmds.push({ t: b, text: `${name(`r${k}`)} enable 0` });
      }
    });
  }

  // The cursor itself, its tip on the path.
  steps.push(`[${firstInput}:v]scale=${L.spriteW}:${L.spriteH}:flags=lanczos,format=rgba[${tag}csp]`);
  layer(`[${tag}csp]`, "p", -L.hotX, -L.hotY, plan.visible);
  cmds.push(...pathCommands(plan.path, name("p"), -L.hotX, -L.hotY));

  return { steps, out: cur, extraInputs: ["-i", sprite], commands: formatCommands(cmds) };
}

/** Draw the cursor over a video. Pure. */
export function buildCursorArgs(
  input: string,
  output: string,
  plan: CursorPlan,
  style: CursorStyle,
  frame: { width: number; height: number },
  sprite: string,
  commandsFile: string,
  quality: Quality = "standard",
): { args: string[]; commands: string } {
  const { steps, out, extraInputs, commands } = cursorSteps(plan, style, frame, "[0:v]", 1, "", sprite, commandsFile);
  return {
    args: [
      "-y", "-i", input, ...extraInputs,
      "-filter_complex", steps.join(";"),
      "-map", out, "-map", "0:a?",
      ...resolveQuality(quality),
      "-c:a", "copy",
      output,
    ],
    commands,
  };
}
