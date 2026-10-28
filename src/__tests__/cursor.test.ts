import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CURSOR_SPRITE,
  cursorLayout,
  cursorSpritePath,
  cursorSteps,
  buildCursorArgs,
  formatCommands,
  linearExpr,
  pathAt,
  planCursor,
  simplifyPath,
  springFor,
  springPath,
  targetPath,
  transformCursor,
  type CursorPlan,
  type PathPoint,
} from "../utils/cursor.js";
import type { InputEvent } from "../utils/events.js";
import { planPipeline, type PipelineStep } from "../utils/pipeline.js";
import { buildCaptureArgs } from "../utils/targets.js";
import { buildWgcGrabArgs } from "../utils/wgc.js";

const ev = (t: number, x: number, y: number, type: InputEvent["type"] = "move"): InputEvent => ({ t, type, x, y, inFrame: true });

describe("targetPath", () => {
  it("holds the old spot across a pause instead of drifting", () => {
    const p = targetPath([{ t: 1, x: 0, y: 0 }, { t: 5, x: 100, y: 0 }]);
    expect(p).toEqual([{ t: 1, x: 0, y: 0 }, { t: 4.967, x: 0, y: 0 }, { t: 5, x: 100, y: 0 }].map((q) => ({ ...q, t: expect.closeTo(q.t, 3) })));
    expect(pathAt(p, 3).x).toBe(0);
  });
  it("keeps continuous movement linear and merges equal times", () => {
    const p = targetPath([{ t: 0, x: 0, y: 0 }, { t: 0.033, x: 10, y: 0 }, { t: 0.033, x: 12, y: 0 }]);
    expect(p).toHaveLength(2);
    expect(p[1]!.x).toBe(12);
  });
});

describe("pathAt", () => {
  const path: PathPoint[] = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 20 }];
  it("interpolates and holds at the ends", () => {
    expect(pathAt(path, 0.5)).toMatchObject({ x: 5, y: 10 });
    expect(pathAt(path, -1)).toMatchObject({ x: 0, y: 0 });
    expect(pathAt(path, 9)).toMatchObject({ x: 10, y: 20 });
  });
});

describe("springPath", () => {
  it("settles on the target and arrives about on time thanks to the lead", () => {
    const { omega, lead } = springFor(0.5);
    const target = targetPath([{ t: 0, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }, { t: 1.2, x: 200, y: 100 }]);
    const p = springPath(target, omega, lead, 0, 3);
    const end = p.at(-1)!;
    expect(end.x).toBeCloseTo(200, 0);
    expect(end.y).toBeCloseTo(100, 0);
    // Shortly after the real cursor got there, the drawn one is close.
    expect(pathAt(p, 1.35).x).toBeGreaterThan(185);
    // It never overshoots (critically damped).
    expect(Math.max(...p.map((q) => q.x))).toBeLessThanOrEqual(200.01);
    // 60 Hz samples.
    expect(p[1]!.t - p[0]!.t).toBeCloseTo(1 / 60, 3);
  });
  it("smooths jitter", () => {
    const jitter = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.033, x: 100 + (i % 2 ? 4 : -4), y: 50 }));
    const { omega, lead } = springFor(0.5);
    const p = springPath(targetPath(jitter), omega, lead, 0, 2);
    const late = p.filter((q) => q.t > 0.5 && q.t < 1.9).map((q) => q.x);
    expect(Math.max(...late) - Math.min(...late)).toBeLessThan(3);
  });
});

describe("simplifyPath", () => {
  it("collapses a straight constant-speed run to its ends and keeps corners", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ t: i / 10, x: i * 2, y: 0 }));
    expect(simplifyPath(line)).toEqual([line[0], line[49]]);
    const corner = [...line, ...Array.from({ length: 20 }, (_, i) => ({ t: 5 + i / 10, x: 98, y: (i + 1) * 3 }))];
    const s = simplifyPath(corner);
    expect(s.length).toBeGreaterThan(2);
    expect(s.length).toBeLessThan(6);
    for (const q of corner) {
      const at = pathAt(s, q.t);
      expect(Math.hypot(at.x - q.x, at.y - q.y)).toBeLessThan(0.36);
    }
  });
  it("treats a pause as a segment, not as drift", () => {
    const pts = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }, { t: 2, x: 0, y: 0 }, { t: 2.1, x: 50, y: 0 }];
    expect(simplifyPath(pts)).toEqual([pts[0], pts[2], pts[3]]);
  });
});

describe("planCursor", () => {
  it("returns an empty plan for a log without positions", () => {
    expect(planCursor([{ t: 1, type: "typing", x: 0, y: 0, inFrame: true, durationSec: 1 }]).path).toEqual([]);
  });
  it("hides the cursor after hideAfterSec without mouse input and merges windows", () => {
    const plan = planCursor([ev(1, 10, 10), ev(1.5, 20, 10), ev(6, 30, 10)], { smoothing: 0, hideAfterSec: 2 }, 10);
    expect(plan.visible).toEqual([[1, 3.5], [6, 8]]);
  });
  it("never hides with hideAfterSec 0, until the video ends", () => {
    const plan = planCursor([ev(1, 10, 10)], { hideAfterSec: 0 }, 10);
    const { lead } = springFor(0.5);
    expect(plan.visible).toEqual([[expect.closeTo(1 - lead, 3), 10]]);
    expect(planCursor([ev(1, 10, 10)], { hideAfterSec: 0, smoothing: 0 }).visible).toEqual([[1, Infinity]]);
  });
  it("uses the logged path as is with smoothing 0, held to the end", () => {
    const plan = planCursor([ev(1, 10, 10), ev(1.033, 20, 15)], { smoothing: 0 }, 4);
    expect(plan.path).toEqual([{ t: 1, x: 10, y: 10 }, { t: 1.033, x: 20, y: 15 }, { t: 4, x: 20, y: 15 }]);
  });
  it("runs the spring to the video's end and keeps clicks where they were", () => {
    const plan = planCursor([ev(0.5, 10, 10), ev(0.6, 50, 50, "down"), ev(0.7, 50, 50, "up"), ev(0.8, 51, 50, "wheel")], {}, 5);
    expect(plan.path.at(-1)!.t).toBe(5);
    expect(plan.clicks).toEqual([{ t: 0.6, x: 50, y: 50 }]);
  });
  it("ignores events after the video ends and rejects bad options", () => {
    expect(planCursor([ev(1, 1, 1), ev(9, 2, 2)], { smoothing: 0 }, 5).path.at(-1)).toEqual({ t: 5, x: 1, y: 1 });
    expect(() => planCursor([], { smoothing: 2 })).toThrow(/smoothing/);
    expect(() => planCursor([], { hideAfterSec: -1 })).toThrow(/hideAfterSec/);
  });
});

describe("transformCursor", () => {
  const plan: CursorPlan = {
    path: [{ t: 0, x: 0, y: 0 }, { t: 4, x: 400, y: 0 }, { t: 10, x: 400, y: 0 }],
    visible: [[1, 6], [8, Infinity]],
    clicks: [{ t: 2, x: 200, y: 0 }, { t: 9, x: 400, y: 0 }],
  };
  it("re-times through a trim and a speed change and scales the pixels", () => {
    const m = transformCursor(plan, [{ op: "trim", start: 1, end: 9 }, { op: "speed", factor: 2 }], { sx: 0.5, sy: 0.5, ox: -10, oy: 0 });
    expect(m.path[0]).toEqual({ t: 1.5, x: 190, y: 0 });
    expect(m.path.at(-1)!.t).toBeLessThanOrEqual(4);
    expect(m.visible).toEqual([[0, 2.5], [3.5, 4]]);
    expect(m.clicks).toEqual([{ t: 0.5, x: 90, y: 0 }]);
  });
  it("closes up a cut, keeping where the cut stretch ends", () => {
    const m = transformCursor(
      { ...plan, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }, { t: 2, x: 20, y: 0 }, { t: 3, x: 30, y: 0 }, { t: 4, x: 90, y: 0 }] },
      [{ op: "cut", spans: [{ start: 1, end: 3 }] }],
    );
    expect(m.path).toEqual([{ t: 0, x: 0, y: 0 }, { t: 1, x: 30, y: 0 }, { t: 2, x: 90, y: 0 }]);
  });
});

describe("expressions and commands", () => {
  it("writes linear expressions without spaces or commas", () => {
    expect(linearExpr(10, 1.5, 0)).toBe("10");
    expect(linearExpr(10, 1.5, 4)).toBe("10+(t-1.5)*4");
    expect(linearExpr(-3.256, 2, -12.5)).toBe("-3.26-(t-2)*12.5");
  });
  it("groups commands per instant in time order", () => {
    expect(formatCommands([{ t: 2, text: "a x 1" }, { t: 0.5, text: "b enable 1" }, { t: 2, text: "a y 2" }])).toBe(
      "0.5 b enable 1;\n2 a x 1, a y 2;\n",
    );
  });
});

describe("cursorSteps / buildCursorArgs", () => {
  const plan: CursorPlan = {
    path: [{ t: 0, x: 100, y: 50 }, { t: 1, x: 200, y: 50 }, { t: 2, x: 200, y: 50 }],
    visible: [[0, 3]],
    clicks: [{ t: 1, x: 200, y: 50 }, { t: 1.05, x: 200, y: 50 }],
  };
  it("drives the sprite from a sendcmd script and hides it outside the windows", () => {
    const { steps, out, extraInputs, commands } = cursorSteps(plan, { clicks: false }, { width: 640, height: 360 }, "[v]", 2, "p1", "C:\\a\\arrow.png", "C:\\w\\c.cmd");
    expect(steps[0]).toBe("[v]sendcmd=f=C\\\\:/w/c.cmd[p1cm]");
    expect(extraInputs).toEqual(["-i", "C:\\a\\arrow.png"]);
    const L = cursorLayout(360);
    expect(steps).toContain(`[2:v]scale=${L.spriteW}:${L.spriteH}:flags=lanczos,format=rgba[p1csp]`);
    expect(steps.at(-1)).toMatch(/^\[p1cm\]\[p1csp\]overlay@p1cp=x=[\d.]+:y=[\d.]+:enable=0\[p1cpo\]$/);
    expect(out).toBe("[p1cpo]");
    const hx = Number((100 - L.hotX).toFixed(2));
    expect(commands).toContain(`0 overlay@p1cp enable 1, overlay@p1cp x ${hx}+(t-0)*100, overlay@p1cp y ${Number((50 - L.hotY).toFixed(2))};`);
    expect(commands).toContain("3 overlay@p1cp enable 0;");
  });
  it("adds a spotlight under the cursor and ripples at clicks", () => {
    const { steps, commands } = cursorSteps(plan, { spotlight: true }, { width: 640, height: 360 }, "[0:v]", 1, "", "a.png", "c.cmd");
    expect(steps.some((s) => s.includes("geq=r=0:g=0:b=0:a=") && s.includes("scale=1280:720[csm]"))).toBe(true);
    expect(steps.filter((s) => /overlay@cr\d=/.test(s))).toHaveLength(3);
    expect(commands).toMatch(/overlay@cs x -?[\d.]+\+\(t-0\)\*100/);
    // The quick second click keeps the first ring up rather than hiding it early.
    expect(commands.match(/overlay@cr0 enable 0/g)).toHaveLength(1);
  });
  it("builds a full command that keeps the audio", () => {
    const { args } = buildCursorArgs("in.mp4", "out.mp4", plan, {}, { width: 640, height: 360 }, "a.png", "c.cmd");
    expect(args.slice(0, 5)).toEqual(["-y", "-i", "in.mp4", "-i", "a.png"]);
    expect(args).toContain("0:a?");
    expect(() => cursorSteps({ ...plan, path: [] }, {}, { width: 1, height: 1 }, "[0:v]", 1, "", "a", "c")).toThrow(/No cursor/);
    expect(() => cursorLayout(360, 20)).toThrow(/size/);
  });
});

describe("the bundled sprite", () => {
  it("matches CURSOR_SPRITE", () => {
    const png = readFileSync(cursorSpritePath());
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(CURSOR_SPRITE.w);
    expect(png.readUInt32BE(20)).toBe(CURSOR_SPRITE.h);
    // The tip pixel is part of the arrow's outline, and the far corner is clear.
    expect(png[25]).toBe(6); // RGBA
  });
});

describe("cursor as a pipeline step", () => {
  const src = { width: 640, height: 360, fps: 30, durationSec: 20, hasAudio: false };
  const plan = planCursor([ev(6, 100, 100), ev(6.5, 300, 200, "down"), ev(18, 50, 50)], { smoothing: 0 }, 20);
  const assets = { 3: { plan, sprite: "arrow.png", commandsFile: "c.cmd" } };
  const steps: PipelineStep[] = [{ op: "trim", start: 5, end: 15 }, { op: "speed", factor: 2 }, { op: "scale", width: 320 }, { op: "cursor", spotlight: true }];

  it("re-times and re-scales the cursor and hands back its sendcmd script", () => {
    const p = planPipeline("in.mp4", "out.mp4", steps, src, {}, "standard", { cursor: assets });
    expect(p.summary.at(-1)).toBe("cursor 3 segment(s), 1 click(s), spotlight");
    expect(p.args).toEqual(expect.arrayContaining(["-i", "arrow.png"]));
    expect(p.files).toHaveLength(1);
    const cmd = p.files[0]!.content;
    // The click at 6.5 s source is 0.75 s after the trim and speed-up, at half size.
    expect(cmd).toMatch(/^0\.75 .*overlay@p3cr0 x 14[0-9.]*, overlay@p3cr0 y 9[0-9.]*/m);
    expect(p.args.join(" ")).toMatch(/sendcmd=f=c\.cmd\[p3cm\]/);
  });
  it("must come before zoom", () => {
    expect(() =>
      planPipeline("in.mp4", "out.mp4", [{ op: "zoom", keyframes: [{ t: 0, full: true }] }, { op: "cursor" }], src, {}, "standard", { cursor: { 1: assets[3] } }),
    ).toThrow(/before zoom/);
    const ok = planPipeline("in.mp4", "out.mp4", [{ op: "cursor" }, { op: "zoom", keyframes: [{ t: 0, full: true }] }], src, {}, "standard", { cursor: { 0: assets[3] } });
    expect(ok.summary[0]).toMatch(/^cursor/);
  });
  it("skips a part of the video without the cursor", () => {
    const p = planPipeline("in.mp4", "out.mp4", [{ op: "trim", start: 0, end: 4 }, { op: "cursor" }], src, {}, "standard", { cursor: { 1: assets[3] } });
    expect(p.summary.at(-1)).toMatch(/no cursor movement/);
    expect(p.files).toEqual([]);
    expect(() => planPipeline("in.mp4", "out.mp4", [{ op: "cursor" }], src)).toThrow(/missing cursor plan/);
  });
});

describe("capture without the OS cursor", () => {
  it("gdigrab gets draw_mouse 0 as an input option", () => {
    const a = buildCaptureArgs({ kind: "full" }, { output: "o.mp4", drawMouse: false });
    expect(a.indexOf("-draw_mouse")).toBeGreaterThan(-1);
    expect(a.indexOf("-draw_mouse")).toBeLessThan(a.indexOf("-i"));
    expect(buildCaptureArgs({ kind: "full" }, { output: "o.mp4" })).not.toContain("-draw_mouse");
  });
  it("wgc turns off capture_cursor", () => {
    expect(buildWgcGrabArgs(42, 15, false).join(" ")).toMatch(/gfxcapture=hwnd=42:max_framerate=15:capture_cursor=0,/);
    expect(buildWgcGrabArgs(42, 15).join(" ")).not.toMatch(/capture_cursor/);
  });
});
