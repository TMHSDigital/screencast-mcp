import { describe, it, expect } from "vitest";
import type { InputEvent } from "../utils/events.js";
import {
  formatChord,
  planBadges,
  groupBadges,
  retimeBadges,
  keystrokeSteps,
  buildKeystrokeArgs,
  badgeSize,
  MAX_BADGE_LABELS,
  TYPING_LABEL,
} from "../utils/keystrokes.js";
import { planPipeline } from "../utils/pipeline.js";
import { SUM_GROUP } from "../utils/expr.js";

const key = (t: number, keys: string): InputEvent => ({ t, type: "key", x: 0, y: 0, inFrame: true, keys });
const down = (t: number, x = 100, y = 100, button = "left", inFrame = true): InputEvent => ({ t, type: "down", x, y, inFrame, button });
const typing = (t: number, durationSec: number): InputEvent => ({ t, type: "typing", x: 0, y: 0, inFrame: true, durationSec });

describe("formatChord (#169)", () => {
  it("spaces a logged chord out and keeps its key", () => {
    expect(formatChord("Ctrl+Shift+P")).toBe("Ctrl + Shift + P");
    expect(formatChord("Alt+Tab")).toBe("Alt + Tab");
    expect(formatChord("Ctrl+-")).toBe("Ctrl + -");
    expect(formatChord("Win+F12")).toBe("Win + F12");
  });

  it("masks the key, keeping only the modifiers", () => {
    expect(formatChord("Ctrl+Shift+P", "masked")).toBe("Ctrl + Shift + …");
  });

  it("refuses anything the logger never writes: text, no modifier, unknown names", () => {
    expect(formatChord("P")).toBeNull();
    expect(formatChord("Ctrl+hunter2")).toBeNull();
    expect(formatChord("Super+P")).toBeNull();
    expect(formatChord("Ctrl+Ctrl+P")).toBeNull();
    expect(formatChord("")).toBeNull();
  });
});

describe("planBadges", () => {
  it("groups repeats of a chord within the linger time", () => {
    const b = planBadges([key(1, "Ctrl+Z"), key(1.5, "Ctrl+Z"), key(2.2, "Ctrl+Z"), key(5, "Ctrl+Z")]);
    expect(b.map((x) => x.label)).toEqual(["Ctrl + Z ×3", "Ctrl + Z"]);
    expect(b[0]).toMatchObject({ from: 1, to: 3.4, kind: "shortcut" });
  });

  it("merges close left clicks into double and triple clicks, but not far apart ones", () => {
    const b = planBadges([down(1), down(1.2, 102, 101), down(1.4), down(1.6), down(4, 100), down(4.3, 400)]);
    expect(b.map((x) => x.label)).toEqual(["Triple click", "Click", "Click", "Click"]);
  });

  it("names other buttons and skips clicks outside the frame, or all clicks when off", () => {
    const evs = [down(1, 0, 0, "right"), down(3, 0, 0, "middle"), down(5, -50, 0, "left", false)];
    expect(planBadges(evs).map((x) => x.label)).toEqual(["Right click", "Middle click"]);
    expect(planBadges(evs, { clicks: false })).toEqual([]);
  });

  it("shows typing bursts as Typing… and never anything typed", () => {
    const b = planBadges([typing(1, 1.5), typing(2.8, 0.5)]);
    expect(b).toEqual([{ from: 1, to: 3.9, label: TYPING_LABEL, kind: "typing" }]);
    expect(planBadges([typing(1, 1)], { typing: false })).toEqual([]);
  });

  it("a masked log (no key events) yields only clicks and typing", () => {
    const masked = [typing(0.5, 1), down(3)];
    expect(planBadges(masked).map((x) => x.kind)).toEqual(["typing", "click"]);
  });

  it("masks chords in keys: masked display", () => {
    expect(planBadges([key(1, "Ctrl+Shift+S")], { keys: "masked" })[0]?.label).toBe("Ctrl + Shift + …");
  });

  it("never overlaps: a badge ends when the next starts", () => {
    const b = planBadges([key(1, "Ctrl+S"), down(1.5), key(1.5, "Alt+Tab")], { lingerSec: 2 });
    for (let i = 1; i < b.length; i++) expect(b[i]!.from).toBeGreaterThanOrEqual(b[i - 1]!.to);
    expect(b[0]).toMatchObject({ from: 1, to: 1.5 });
  });

  it("rejects a non-positive linger", () => {
    expect(() => planBadges([], { lingerSec: 0 })).toThrow(/lingerSec/);
  });
});

describe("groupBadges / retimeBadges", () => {
  it("groups windows by label in first-appearance order", () => {
    const g = groupBadges(planBadges([down(1), key(3, "Ctrl+S"), down(6)]));
    expect(g.map((x) => x.label)).toEqual(["Click", "Ctrl + S"]);
    expect(g[0]!.windows).toHaveLength(2);
  });

  it("caps the number of distinct labels", () => {
    const many = Array.from({ length: MAX_BADGE_LABELS + 1 }, (_, i) => ({ from: i, to: i + 0.5, label: `L${i}`, kind: "click" as const }));
    expect(() => groupBadges(many)).toThrow(/more than/);
  });

  it("moves badges through a trim and a speed change, dropping the cut ones", () => {
    const b = [
      { from: 1, to: 2, label: "A", kind: "click" as const },
      { from: 4, to: 6, label: "B", kind: "click" as const },
      { from: 9.5, to: 11, label: "C", kind: "click" as const },
    ];
    const r = retimeBadges(b, [{ op: "trim", start: 3, end: 10 }, { op: "speed", factor: 2 }]);
    expect(r).toEqual([
      { from: 0.5, to: 1.5, label: "B", kind: "click" },
      { from: 3.25, to: 3.5, label: "C", kind: "click" },
    ]);
  });
});

describe("keystrokeSteps / buildKeystrokeArgs", () => {
  const assets = { fontFile: "C:/fonts/Inter-Bold.ttf", textFiles: { Click: "C:/w/b0.txt", "Ctrl + S": "C:/w/b1.txt" } };

  it("draws one drawtext per label on the callout panel, enabled for each of its windows", () => {
    const groups = groupBadges(planBadges([down(1), key(3, "Ctrl+S"), down(6)]));
    const { steps, out } = keystrokeSteps(groups, assets, {}, { height: 1080 }, "[0:v]", "p2");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("textfile=C\\\\:/w/b0.txt:expansion=none");
    expect(steps[0]).toContain("fontsize=49:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=16");
    expect(steps[0]).toContain("x=(w-tw)/2:y=h-lh-45");
    expect(steps[0]).toContain("enable='between(t,1,2.2)+between(t,6,7.2)'");
    expect(out).toBe("[p2k1]");
  });

  it("places badges in a corner and validates the color", () => {
    const groups = [{ label: "Click", windows: [[0, 1]] as Array<[number, number]> }];
    const tl = keystrokeSteps(groups, assets, { position: "top-left", size: 30 }, { height: 720 }, "[v]", "").steps[0];
    expect(tl).toContain(":x=28:y=28:");
    const br = keystrokeSteps(groups, assets, { position: "bottom-right", size: 30 }, { height: 720 }, "[v]", "").steps[0];
    expect(br).toContain(":x=w-tw-28:y=h-lh-28:");
    expect(() => keystrokeSteps(groups, assets, { color: "red'" }, { height: 720 }, "[v]", "")).toThrow(/color/);
  });

  it("keeps a long timeline's enable expression in grouped sums (#225)", () => {
    const clicks = Array.from({ length: 500 }, (_, i) => down(i * 3));
    const groups = groupBadges(planBadges(clicks));
    const step = keystrokeSteps(groups, assets, {}, { height: 360 }, "[0:v]", "").steps[0]!;
    const flat = step.slice(step.indexOf("enable='") + 8, step.lastIndexOf("'"));
    // 500 terms as 10 parenthesised groups of SUM_GROUP, never a flat sum of 100+.
    const groupsOf = flat.split(")+(");
    expect(groupsOf).toHaveLength(500 / SUM_GROUP);
    for (const part of groupsOf) expect(part.split("+between").length).toBeLessThanOrEqual(SUM_GROUP);
  });

  it("uses a size from the frame height unless given", () => {
    expect(badgeSize(1080)).toBe(49);
    expect(badgeSize(200)).toBe(14);
    expect(badgeSize(1080, 30)).toBe(30);
    expect(() => badgeSize(1080, 2)).toThrow(/size/);
  });

  it("writes the video with audio copied", () => {
    const groups = [{ label: "Click", windows: [[0, 1]] as Array<[number, number]> }];
    const args = buildKeystrokeArgs("in.mp4", "out.mp4", groups, assets, {}, { height: 480 });
    expect(args).toEqual(expect.arrayContaining(["-filter_complex", "-map", "0:a?", "-c:a", "copy"]));
    expect(args.at(-1)).toBe("out.mp4");
  });
});

describe("keystroke_overlay as a pipeline step", () => {
  const src = { width: 640, height: 360, fps: 30, durationSec: 20, hasAudio: false };
  const badges = planBadges([down(2), key(8, "Ctrl+S"), down(15)]);
  const k = { badges, fontFile: "F.ttf", textFiles: { Click: "c.txt", "Ctrl + S": "s.txt" } };

  it("re-times badges through a leading trim and a speed change", () => {
    const plan = planPipeline(
      "in.mp4", "out.mp4",
      [{ op: "trim", start: 5, end: 20 }, { op: "speed", factor: 2 }, { op: "keystroke_overlay" }],
      src, {}, "standard", { keystrokes: { 2: k } },
    );
    const g = plan.args.join(" ");
    // Ctrl+S at 8 s is 3 s into the trim, 1.5 s after the 2x speed-up; the click at 2 s is cut.
    expect(g).toContain("between(t,1.5,2.1)");
    expect(g).toContain("between(t,5,5.6)");
    expect(g).not.toContain("between(t,2,");
    expect(plan.summary.at(-1)).toBe("keystroke_overlay 2 badge(s)");
  });

  it("is a no-op step when every badge was trimmed away", () => {
    const plan = planPipeline("in.mp4", "out.mp4", [{ op: "trim", start: 17, end: 20 }, { op: "keystroke_overlay" }], src, {}, "standard", { keystrokes: { 1: k } });
    expect(plan.summary.at(-1)).toMatch(/no badges/);
  });

  it("needs its badges", () => {
    expect(() => planPipeline("in.mp4", "out.mp4", [{ op: "keystroke_overlay" }], src)).toThrow(/missing keystroke badges/);
  });
});
