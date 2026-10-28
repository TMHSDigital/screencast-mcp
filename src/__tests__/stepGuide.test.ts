/**
 * step_guide (#172): the shared step builder, captions from OCR, marker
 * sections, the screenshot filter, and the Markdown/HTML writers. Pure.
 */
import { describe, it, expect } from "vitest";
import type { InputEvent } from "../utils/events.js";
import type { OcrLine } from "../utils/ocr.js";
import { inputSteps, reconstructSteps } from "../utils/steps.js";
import { reconstructSteps as fromBugReport } from "../utils/bugReport.js";
import {
  assignSections,
  buildGuideHtml,
  buildGuideMarkdown,
  buildStepFrameArgs,
  buildStepShotArgs,
  caption,
  guideSteps,
  labelAt,
  shotFilter,
  shotTime,
  SHOT_LEAD_SEC,
  type GuideData,
} from "../utils/stepGuide.js";

const at = (t: number, type: InputEvent["type"], extra: Partial<InputEvent> = {}): InputEvent => ({
  t,
  type,
  x: 100,
  y: 50,
  inFrame: true,
  ...extra,
});

const events: InputEvent[] = [
  at(0.5, "move"),
  at(1, "down", { button: "left", x: 120, y: 80 }),
  at(1.1, "up", { button: "left", x: 120, y: 80 }),
  at(2, "down", { button: "right", x: 300, y: 200 }),
  at(3, "typing", { durationSec: 1.5 }),
  at(5, "key", { keys: "Ctrl+S" }),
  at(6, "gap", { durationSec: 4, reason: "input_not_seen" }),
  at(11, "down", { button: "left", inFrame: false, x: -5, y: 10 }),
  at(12, "wheel", { delta: -1, axis: "vertical" }),
  at(12.3, "wheel", { delta: -2, axis: "vertical" }),
];

function line(text: string, x: number, y: number, width: number, height = 20): OcrLine {
  const words = text.split(" ").map((w, i, all) => ({
    text: w,
    x: x + (i * width) / all.length,
    y,
    width: width / all.length,
    height,
  }));
  return { text, x, y, width, height, words };
}

describe("shared step builder (steps.ts)", () => {
  it("keeps bug_report's step shape (no event details) and re-export", () => {
    const repro = reconstructSteps(events);
    expect(fromBugReport).toBe(reconstructSteps);
    for (const s of repro) {
      expect(Object.keys(s).every((k) => ["t", "action", "text", "x", "y"].includes(k)), JSON.stringify(s)).toBe(true);
    }
    expect(repro.map((s) => s.text)).toEqual([
      "Click at (120, 80)",
      "Right click at (300, 200)",
      "Type for 1.5 s (keys are not logged)",
      "Press Ctrl+S",
      "Input may be missing for 4 s (input went to an elevated window or the lock screen, or the hook was removed)",
      "Click outside the recorded area",
      "Scroll down 3 notches",
    ]);
  });

  it("carries the details a caption needs", () => {
    const steps = inputSteps(events);
    expect(steps[1]).toMatchObject({ action: "click", button: "right", inFrame: true });
    expect(steps[3]).toMatchObject({ action: "shortcut", keys: "Ctrl+S" });
    expect(steps[5]).toMatchObject({ action: "click", inFrame: false });
  });
});

describe("shotTime", () => {
  it("takes the frame just before the step, inside the video", () => {
    expect(shotTime(5, 10, 30)).toBeCloseTo(5 - SHOT_LEAD_SEC);
    expect(shotTime(0.02, 10, 30)).toBe(0);
    expect(shotTime(50, 10, 10)).toBe(9.9);
  });
});

describe("labelAt", () => {
  const lines = [line("Save", 100, 70, 60), line("Cancel", 200, 70, 60), line("File Edit View Selection Terminal Window Help", 0, 0, 700)];
  it("names the line under or near the click", () => {
    expect(labelAt(lines, 120, 80)).toBe("Save");
    expect(labelAt(lines, 170, 80)).toBe("Save"); // 10 px past its edge
    expect(labelAt(lines, 600, 600)).toBeNull();
  });
  it("gives just the word under the click on a long line", () => {
    expect(labelAt(lines, 10, 5)).toBe("File");
  });
});

describe("guideSteps", () => {
  const steps = inputSteps(events);
  it("numbers steps, makes gaps notes, and never shows typed text", () => {
    const g = guideSteps(steps, { durationSec: 20, fps: 30 });
    expect(g.map((s) => s.n)).toEqual([1, 2, 3, 4, 0, 5, 6]);
    expect(g.map(caption)).toEqual([
      "Click the marked spot",
      "Right-click the marked spot",
      "Type text",
      "Press Ctrl+S",
      expect.stringMatching(/^Input may be missing/),
      "Click outside the recorded area",
      "Scroll down 3 notches",
    ]);
    expect(g[4]!.shotT).toBeUndefined();
    expect(g[0]).toMatchObject({ x: 120, y: 80, shotT: 0.9 });
    expect(g[5]!.x).toBeUndefined(); // nothing to ring outside the frame
  });

  it("captions clicks from OCR labels, masking secrets", () => {
    const labels = steps.map(() => null as string | null);
    labels[0] = "Save";
    labels[1] = "token: ghp_Abc123Def456Ghi789";
    labels[6] = "Results";
    const g = guideSteps(steps, { durationSec: 20, fps: 30, labels });
    expect(g[0]).toMatchObject({ text: "Click", label: "Save" });
    expect(g[1]!.label).toBe("[REDACTED]");
    expect(caption(g[6]!)).toBe("Scroll down 3 notches over Results");
  });
});

describe("assignSections", () => {
  it("puts each step under the latest marker at or before it", () => {
    const g = guideSteps(inputSteps(events), { durationSec: 20, fps: 30 });
    const s = assignSections(g, [
      { t: 0.2, label: "Unused" },
      { t: 0.8, label: "Open" },
      { t: 5, label: "Save it" },
    ]);
    expect(s.map((x) => x.section)).toEqual(["Open", "Open", "Open", "Save it", "Save it", "Save it", "Save it"]);
    expect(assignSections(g, [])[0]!.section).toBeUndefined();
  });
});

describe("shotFilter and args", () => {
  it("boxes secrets, rings the click, and scales down", () => {
    const f = shotFilter({ width: 1920, height: 1080 }, { click: { x: 500, y: 300 }, boxes: [{ x: 10, y: 20, width: 30, height: 40 }] });
    expect(f).toContain("drawbox=x=10:y=20:w=30:h=40:color=black:t=fill");
    expect(f).toMatch(/color=c=#FF4545:s=98x98/);
    expect(f).toContain("overlay=x=451:y=251");
    expect(f).toContain("scale=w='min(iw,1280)'");
    expect(f.endsWith("[out]")).toBe(true);
  });
  it("skips the ring without a click point", () => {
    const f = shotFilter({ width: 640, height: 360 }, {});
    expect(f).not.toContain("geq");
    expect(f.startsWith("[0:v]format=rgba")).toBe(true);
  });
  it("grabs and renders one frame", () => {
    expect(buildStepFrameArgs("in.mp4", 1.5, "f.png")).toEqual(["-y", "-v", "error", "-ss", "1.5", "-i", "in.mp4", "-frames:v", "1", "f.png"]);
    expect(buildStepShotArgs("f.png", "[0:v]null[out]", "o.png")).toContain("-filter_complex");
  });
});

describe("guide writers", () => {
  const steps = assignSections(
    guideSteps(inputSteps(events), { durationSec: 20, fps: 30, labels: ["Save <b>*now*</b>", null, null, null, null, null, null] }),
    [{ t: 4, label: "Save & close" }],
  ).map((s) => (s.n > 0 ? { ...s, image: `step-0${s.n}.png` } : s));
  const data: GuideData = {
    title: "How to save",
    createdAt: "2026-01-01T00:00:00.000Z",
    recording: { durationSec: 20, width: 640, height: 360 },
    steps,
    ocr: "read",
    redactions: 2,
  };

  it("writes Markdown with headings, numbered steps, images, and escaped labels", () => {
    const md = buildGuideMarkdown(data);
    expect(md).toContain("# How to save");
    expect(md).toContain("6 steps from a 0:20.0 recording.");
    expect(md).toContain("1. Click **Save \\<b\\>\\*now\\*\\</b\\>** <sub>0:01.0</sub>");
    expect(md).toContain("   ![Step 1](images/step-01.png)");
    expect(md).toContain("## Save & close");
    expect(md.indexOf("## Save & close")).toBeLessThan(md.indexOf("4. Press **Ctrl+S**"));
    expect(md).toContain("> _Input may be missing");
    expect(md).toContain("2 regions boxed out");
    expect(md).toContain("Typed text is never logged");
  });

  it("writes one self-contained HTML page with escaped text", () => {
    const html = buildGuideHtml(data, (f) => `data:image/png;base64,${f}`);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>How to save</title>");
    expect(html).toContain("<strong>Save &lt;b&gt;*now*&lt;/b&gt;</strong>");
    expect(html).not.toContain("<b>*now*");
    expect(html).toContain('src="data:image/png;base64,step-01.png"');
    expect(html).toContain("<h2>Save &amp; close</h2>");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).not.toMatch(/<(script|link)\b/);
  });

  it("explains an empty guide and an unscanned one", () => {
    const empty = { ...data, steps: [], stepsNote: "No clicks.", ocr: "off" as const, redactions: 0 };
    expect(buildGuideMarkdown(empty)).toContain("_No clicks._");
    expect(buildGuideMarkdown(empty)).toContain("not scanned for secrets");
    expect(buildGuideHtml(empty, (f) => f)).toContain("No clicks.");
  });
});
