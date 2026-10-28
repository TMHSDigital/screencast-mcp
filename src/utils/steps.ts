/**
 * Numbered steps from an input event log (#118): the shared core of
 * bug_report's "Steps to reproduce" (#198) and step_guide's how-to (#172).
 *
 * Clicks (with double-clicks folded), shortcuts, typing bursts (the typed text
 * is never logged, so never shown), scrolls joined into one step, and gaps
 * where events may be missing. Cursor moves and button releases are not steps.
 * Pure, so it is unit-tested without ffmpeg or Windows.
 */
import type { InputEvent, GapReason } from "./events.js";

export type StepAction = "click" | "double_click" | "shortcut" | "typing" | "scroll" | "gap";

export interface ReproStep {
  /** Seconds on the recording's clock. */
  t: number;
  action: StepAction;
  /** One line a person can follow. */
  text: string;
  x?: number;
  y?: number;
}

/** A step plus the event details a caption needs. */
export interface InputStep extends ReproStep {
  /** Mouse button of a click (left, right, middle, ...). */
  button?: string;
  /** False when a click or scroll landed outside the recorded area. */
  inFrame?: boolean;
  /** The chord of a shortcut, e.g. "Ctrl+S". */
  keys?: string;
  /** Length of a typing burst or gap, in seconds. */
  durationSec?: number;
}

/** Two presses this close (s, px) with the same button read as a double-click. */
const DOUBLE_CLICK_SEC = 0.5;
const DOUBLE_CLICK_PX = 6;
/** Wheel notches this close together (s) are one scroll. */
const SCROLL_JOIN_SEC = 1;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

const GAP_WHY: Record<GapReason, string> = {
  input_not_seen: "input went to an elevated window or the lock screen, or the hook was removed",
  helper_stalled: "the event logger paused",
  helper_stopped: "the event logger stopped",
};

function clickText(button: string | undefined, double: boolean, e: InputEvent): string {
  const verb = double ? "double-click" : "click";
  const which = button && button !== "left" ? `${button.charAt(0).toUpperCase()}${button.slice(1)} ${verb}` : `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  return e.inFrame ? `${which} at (${e.x}, ${e.y})` : `${which} outside the recorded area`;
}

/** Steps with their event details (see the module comment). Pure. */
export function inputSteps(events: InputEvent[]): InputStep[] {
  const steps: InputStep[] = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  let lastDown: { e: InputEvent; step: InputStep } | null = null;
  let scroll: { step: InputStep; axis: "vertical" | "horizontal"; notches: number; last: number } | null = null;
  const scrollText = (axis: "vertical" | "horizontal", notches: number) => {
    const dir = axis === "vertical" ? (notches >= 0 ? "up" : "down") : notches >= 0 ? "right" : "left";
    const n = Math.abs(notches);
    return `Scroll ${dir} ${n} notch${n === 1 ? "" : "es"}`;
  };
  for (const e of sorted) {
    if (e.type === "move" || e.type === "up") continue;
    if (e.type !== "wheel") scroll = null;
    if (e.type === "down") {
      const prev = lastDown;
      if (
        prev &&
        prev.e.button === e.button &&
        e.t - prev.e.t <= DOUBLE_CLICK_SEC &&
        Math.abs(e.x - prev.e.x) <= DOUBLE_CLICK_PX &&
        Math.abs(e.y - prev.e.y) <= DOUBLE_CLICK_PX &&
        prev.step.action === "click" &&
        steps.at(-1) === prev.step
      ) {
        prev.step.action = "double_click";
        prev.step.text = clickText(e.button, true, prev.e);
        lastDown = null;
        continue;
      }
      const step: InputStep = {
        t: e.t,
        action: "click",
        text: clickText(e.button, false, e),
        x: e.x,
        y: e.y,
        button: e.button ?? "left",
        inFrame: e.inFrame,
      };
      steps.push(step);
      lastDown = { e, step };
      continue;
    }
    lastDown = null;
    if (e.type === "wheel") {
      const axis = e.axis ?? "vertical";
      const delta = e.delta ?? 0;
      if (scroll && scroll.axis === axis && e.t - scroll.last <= SCROLL_JOIN_SEC && Math.sign(delta) === Math.sign(scroll.notches)) {
        scroll.notches += delta;
        scroll.last = e.t;
        scroll.step.text = scrollText(axis, scroll.notches);
        continue;
      }
      const step: InputStep = { t: e.t, action: "scroll", text: scrollText(axis, delta), x: e.x, y: e.y, inFrame: e.inFrame };
      steps.push(step);
      scroll = { step, axis, notches: delta, last: e.t };
    } else if (e.type === "key") {
      steps.push({ t: e.t, action: "shortcut", text: `Press ${e.keys ?? "a shortcut"}`, ...(e.keys ? { keys: e.keys } : {}) });
    } else if (e.type === "typing") {
      const d = e.durationSec ?? 0;
      steps.push({ t: e.t, action: "typing", text: `Type${d > 0 ? ` for ${r3(d)} s` : ""} (keys are not logged)`, durationSec: d });
    } else if (e.type === "gap") {
      const why = GAP_WHY[e.reason ?? "input_not_seen"];
      const d = r3(e.durationSec ?? 0);
      steps.push({ t: e.t, action: "gap", text: `Input may be missing for ${d} s (${why})`, durationSec: d });
    }
  }
  return steps;
}

/** Numbered repro steps (bug_report's shape: no event details). Pure. */
export function reconstructSteps(events: InputEvent[]): ReproStep[] {
  return inputSteps(events).map(({ button: _b, inFrame: _i, keys: _k, durationSec: _d, ...step }) => step);
}
