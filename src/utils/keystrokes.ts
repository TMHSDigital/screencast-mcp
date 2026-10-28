/**
 * keystroke_overlay (#169): keycast-style badges ("Ctrl + Shift + P",
 * "Click", "Typing…") burned into a video from its input event log.
 *
 * The log never holds typed text (#210): typing is only `typing` bursts, and
 * `key` events exist only for Ctrl/Alt/Win chords recorded with
 * `keys: "shortcuts"`. So a badge can only ever say what the log says, and
 * `keys: "masked"` here goes further and shows a chord's modifiers only.
 *
 * One badge shows at a time (the next one replaces it), and one drawtext per
 * distinct label draws all of that label's appearances, enabled by a grouped
 * sum of between() terms (sumExpr), so a long recording with thousands of
 * clicks stays one short chain of filters. Builders are pure.
 */
import { ScreencastError } from "./errors.js";
import { escapeFilterPath } from "./fonts.js";
import { sumExpr } from "./expr.js";
import type { InputEvent } from "./events.js";
import { resolveQuality, type Quality } from "./targets.js";
import { validateColor } from "./validate.js";
import type { TimeOp } from "./chapters.js";
import { mapWindow } from "./timeline.js";

export type BadgeKind = "shortcut" | "click" | "typing";
export type KeyDisplay = "shortcuts" | "masked";
export const BADGE_POSITIONS = ["bottom", "bottom-left", "bottom-right", "top", "top-left", "top-right"] as const;
export type BadgePosition = (typeof BADGE_POSITIONS)[number];

export interface Badge {
  /** Seconds on the video's clock. */
  from: number;
  to: number;
  label: string;
  kind: BadgeKind;
}

export interface BadgePlanOptions {
  /** Show mouse clicks (default true). */
  clicks?: boolean;
  /** Show typing bursts as "Typing…" (default true). */
  typing?: boolean;
  /** shortcuts (default): the logged chord; masked: its modifiers only. */
  keys?: KeyDisplay;
  /** How long a badge stays up after its input (default 1.2 s). */
  lingerSec?: number;
}

export const DEFAULT_LINGER_SEC = 1.2;
/** Two clicks this close (s) and near each other are a double click. */
export const DOUBLE_CLICK_SEC = 0.5;
const DOUBLE_CLICK_PX = 8;
/** Distinct labels one render draws (one drawtext each). */
export const MAX_BADGE_LABELS = 100;
export const TYPING_LABEL = "Typing…";

const MODIFIERS = new Set(["Ctrl", "Alt", "Shift", "Win"]);
// The helper names keys from a fixed table (letters, digits, F-keys, named
// keys, punctuation); anything else in a log is not drawn.
const KEY_NAME = /^(?:[A-Z0-9]|F\d{1,2}|Enter|Tab|Esc|Space|Backspace|Delete|Insert|Left|Up|Right|Down|Home|End|PageUp|PageDown|[=\-,./`[\];'\\])$/;

/** A logged chord ("Ctrl+Shift+P") as a badge label ("Ctrl + Shift + P"), or
 * null when it is not a chord the logger writes. `masked` keeps only the
 * modifiers ("Ctrl + Shift + …"). Pure. */
export function formatChord(keys: string, display: KeyDisplay = "shortcuts"): string | null {
  // Split on "+" separators, but a trailing "+" key would be "Ctrl++"; the
  // logger names that key "=", so a "+" key never appears.
  const parts = keys.split("+");
  const key = parts.pop();
  if (key === undefined || parts.length === 0 || !KEY_NAME.test(key)) return null;
  if (!parts.every((p) => MODIFIERS.has(p)) || new Set(parts).size !== parts.length) return null;
  return [...parts, display === "masked" ? "…" : key].join(" + ");
}

const BUTTON_LABEL: Record<string, string> = {
  left: "Click",
  right: "Right click",
  middle: "Middle click",
  x1: "Back button",
  x2: "Forward button",
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Badges from an event log, in time order and never overlapping: repeats of a
 * chord within the linger time merge ("Ctrl + Z ×3"), close left clicks merge
 * into a double or triple click, and each badge ends when the next begins.
 * Pure.
 */
export function planBadges(events: InputEvent[], opts: BadgePlanOptions = {}): Badge[] {
  const linger = opts.lingerSec ?? DEFAULT_LINGER_SEC;
  if (!(linger > 0)) throw new ScreencastError("lingerSec must be positive.");
  const display = opts.keys ?? "shortcuts";
  const sorted = [...events].filter((e) => Number.isFinite(e.t) && e.t >= 0).sort((a, b) => a.t - b.t);

  interface Raw extends Badge {
    base: string;
    count: number;
    x?: number;
    y?: number;
    last: number;
  }
  const raw: Raw[] = [];
  for (const e of sorted) {
    if (e.type === "key" && e.keys) {
      const label = formatChord(e.keys, display);
      if (!label) continue;
      const prev = raw.at(-1);
      if (prev && prev.kind === "shortcut" && prev.base === label && e.t - prev.last <= linger) {
        prev.count++;
        prev.last = e.t;
        prev.label = `${label} ×${prev.count}`;
        prev.to = e.t + linger;
        continue;
      }
      raw.push({ from: e.t, to: e.t + linger, label, base: label, kind: "shortcut", count: 1, last: e.t });
    } else if (e.type === "down" && opts.clicks !== false && e.inFrame) {
      const base = BUTTON_LABEL[e.button ?? "left"] ?? "Click";
      const prev = raw.at(-1);
      if (
        base === "Click" && prev && prev.kind === "click" && prev.base === "Click" && prev.count < 3 &&
        e.t - prev.last <= DOUBLE_CLICK_SEC &&
        Math.abs(e.x - (prev.x ?? e.x)) <= DOUBLE_CLICK_PX && Math.abs(e.y - (prev.y ?? e.y)) <= DOUBLE_CLICK_PX
      ) {
        prev.count++;
        prev.last = e.t;
        prev.label = prev.count === 2 ? "Double click" : "Triple click";
        prev.to = e.t + linger;
        continue;
      }
      raw.push({ from: e.t, to: e.t + linger, label: base, base, kind: "click", count: 1, x: e.x, y: e.y, last: e.t });
    } else if (e.type === "typing" && opts.typing !== false) {
      const end = e.t + Math.max(e.durationSec ?? 0, 0);
      const prev = raw.at(-1);
      // Bursts split by a short pause read as one stretch of typing.
      if (prev && prev.kind === "typing" && e.t <= prev.to) {
        prev.to = Math.max(prev.to, end + linger / 2);
        prev.last = e.t;
        continue;
      }
      raw.push({ from: e.t, to: end + linger / 2, label: TYPING_LABEL, base: TYPING_LABEL, kind: "typing", count: 1, last: e.t });
    }
  }
  const out: Badge[] = [];
  raw.forEach((b, i) => {
    const next = raw[i + 1];
    const to = next ? Math.min(b.to, next.from) : b.to;
    if (to - b.from >= 0.05) out.push({ from: r3(b.from), to: r3(to), label: b.label, kind: b.kind });
  });
  return out;
}

export interface BadgeGroup {
  label: string;
  windows: Array<[number, number]>;
}

/** Badges grouped by label, in first-appearance order. Pure. */
export function groupBadges(badges: Badge[]): BadgeGroup[] {
  const groups = new Map<string, BadgeGroup>();
  for (const b of badges) {
    let g = groups.get(b.label);
    if (!g) {
      g = { label: b.label, windows: [] };
      groups.set(b.label, g);
    }
    g.windows.push([b.from, b.to]);
  }
  if (groups.size > MAX_BADGE_LABELS) {
    throw new ScreencastError(
      `${groups.size} different badges is more than ${MAX_BADGE_LABELS}; trim the video or turn off keys or clicks.`,
    );
  }
  return [...groups.values()];
}

/** Map badges through a change of timeline (a trim or speed change in a
 * pipeline): `map` returns the new window or null when it is cut. Pure. */
export function mapBadges(badges: Badge[], map: (from: number, to: number) => [number, number] | null): Badge[] {
  return badges.flatMap((b) => {
    const w = map(b.from, b.to);
    return w && w[1] - w[0] >= 0.05 ? [{ ...b, from: r3(w[0]), to: r3(w[1]) }] : [];
  });
}

/** A trim, speed change or cut, in pipeline order (chapters' TimeOp). */
export type BadgeTimeOp = TimeOp;

/** Badges on the source clock moved onto the timeline after `ops`: a trim
 * cuts and shifts them, a speed change rescales them, a cut closes up. Pure. */
export function retimeBadges(badges: Badge[], ops: readonly BadgeTimeOp[]): Badge[] {
  return mapBadges(badges, (from, to) => mapWindow(from, to, ops));
}

export interface BadgeStyle {
  position?: BadgePosition;
  /** Font size in px (default 4.5% of the frame height, at least 14). */
  size?: number;
  /** Text color (default white). */
  color?: string;
}

export interface KeystrokeAssets {
  fontFile: string;
  /** label -> the text file drawtext reads it from. */
  textFiles: Record<string, string>;
}

/** Default badge font size for a frame height. Pure. */
export function badgeSize(frameH: number, size?: number): number {
  if (size !== undefined) {
    if (!(size >= 8 && size <= 400)) throw new ScreencastError("size must be between 8 and 400.");
    return Math.round(size);
  }
  return Math.max(14, Math.round(frameH * 0.045));
}

/** Drawtext steps over `input`, one per label; the same dark panel as a text
 * callout. Pure. */
export function keystrokeSteps(
  groups: BadgeGroup[],
  assets: KeystrokeAssets,
  style: BadgeStyle,
  frame: { height: number },
  input: string,
  tag: string,
): { steps: string[]; out: string } {
  if (groups.length === 0) throw new ScreencastError("No badges to draw.");
  const size = badgeSize(frame.height, style.size);
  const border = Math.round(size / 3);
  const margin = border + Math.round(size * 0.6);
  const pos = style.position ?? "bottom";
  const x = pos.endsWith("left") ? `${margin}` : pos.endsWith("right") ? `w-tw-${margin}` : "(w-tw)/2";
  // lh is the font's line height, the same for every label, so badges do not
  // jump up and down with their glyphs.
  const y = pos.startsWith("top") ? `${margin}` : `h-lh-${margin}`;
  const color = validateColor(style.color ?? "white");
  const steps: string[] = [];
  let cur = input;
  groups.forEach((g, i) => {
    const file = assets.textFiles[g.label];
    if (!file) throw new ScreencastError(`Internal: no text file for badge "${g.label}".`);
    const enable = sumExpr(g.windows.map(([a, b]) => `between(t,${a},${b})`));
    const out = `[${tag}k${i}]`;
    steps.push(
      `${cur}drawtext=fontfile=${escapeFilterPath(assets.fontFile)}:textfile=${escapeFilterPath(file)}:expansion=none` +
        `:fontsize=${size}:fontcolor=${color}:box=1:boxcolor=black@0.6:boxborderw=${border}` +
        `:x=${x}:y=${y}:enable='${enable}'${out}`,
    );
    cur = out;
  });
  return { steps, out: cur };
}

/** Burn the badges into a video. Pure. */
export function buildKeystrokeArgs(
  input: string,
  output: string,
  groups: BadgeGroup[],
  assets: KeystrokeAssets,
  style: BadgeStyle,
  frame: { height: number },
  quality: Quality = "standard",
): string[] {
  const { steps, out } = keystrokeSteps(groups, assets, style, frame, "[0:v]", "");
  return [
    "-y", "-i", input,
    "-filter_complex", steps.join(";"),
    "-map", out, "-map", "0:a?",
    ...resolveQuality(quality),
    "-c:a", "copy",
    output,
  ];
}
