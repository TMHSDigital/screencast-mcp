/**
 * UI elements under clicks (#333): attaching the helper's `elem` lines to
 * their presses, step and guide wording, index text, and the helper only
 * loading UI Automation when asked. Pure.
 */
import { describe, it, expect } from "vitest";
import { buildHookScript, convertEvents } from "../utils/events.js";
import { elementPhrase, inputSteps, reconstructSteps, roleWords } from "../utils/steps.js";
import { guideSteps } from "../utils/stepGuide.js";
import { eventTexts } from "../utils/recordingIndex.js";

const frame = { x: 0, y: 0, w: 800, h: 600 };

describe("UI elements under clicks (#333)", () => {
  const raw = [
    "1100.0,down,100,200,left",
    "1100.0,elem,100,200,Button|notepad.exe|1|Save",
    "1120.0,up,100,200,left",
    "1500.0,down,300,40,left",
    "1500.0,elem,300,40,MenuItem|notepad.exe||Format | Font, more",
    "2000.0,down,50,50,right", // no element line: coordinates
    "2500.0,down,60,60,left",
    "2500.0,elem,60,60,Edit|app.exe|pwd|", // password field: no name
    "2600.0,elem,999,999,Button|x.exe||Orphan", // matches no press
  ].join("\n");
  const events = convertEvents(raw, { startMs: 1000, frame });
  const downs = events.filter((e) => e.type === "down");

  it("attaches each element line to the press with the same time and position", () => {
    expect(downs[0]?.element).toEqual({ role: "Button", name: "Save", app: "notepad.exe", automationId: "1" });
    expect(downs[1]?.element).toEqual({ role: "MenuItem", name: "Format | Font, more", app: "notepad.exe" });
    expect(downs[2]?.element).toBeUndefined();
    expect(downs[3]?.element).toEqual({ role: "Edit", app: "app.exe", automationId: "pwd" });
    expect(events.some((e) => (e.type as string) === "elem")).toBe(false);
  });

  it("names elements in steps, falling back to coordinates", () => {
    expect(roleWords("MenuItem")).toBe("menu item");
    expect(elementPhrase({ role: "Edit", app: "app.exe" })).toBe("an edit in app.exe");
    expect(elementPhrase({ role: "Button" })).toBe("a button");
    expect(reconstructSteps(events).map((s) => s.text)).toEqual([
      'Click the "Save" button in notepad.exe',
      'Click the "Format | Font, more" menu item in notepad.exe',
      "Right click at (50, 50)",
      "Click at (60, 60)",
    ]);
  });

  it("uses the element name as the guide label over OCR, masked", () => {
    const steps = inputSteps(events);
    const guide = guideSteps(steps, { durationSec: 5, fps: 30, labels: ["ocr label", "ocr 2", null, "ocr 4"] });
    expect(guide[0]).toMatchObject({ text: "Click", label: "Save" });
    expect(guide[3]).toMatchObject({ text: "Click", label: "ocr 4" });
  });

  it("indexes the element's role, name and app", () => {
    expect(eventTexts(downs.slice(0, 1))[0]?.text).toBe("click left at 100,200 button Save notepad.exe");
  });

  it("loads UI Automation only when elements are asked for", () => {
    expect(buildHookScript("p", "masked", 1)).not.toContain("UIAutomationClient");
    const s = buildHookScript("p", "masked", 1, { elements: true });
    expect(s).toContain("UIAutomationClient");
    expect(s).toContain("cur.IsPassword?\"\":");
    expect(s.indexOf("[ScEvents]::Describer=")).toBeLessThan(s.indexOf("[ScEvents]::Run("));
  });
});
