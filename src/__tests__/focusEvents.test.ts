/**
 * Foreground-window focus events (#323): parsing the helper's lines, the app
 * in front at the first frame, commas in titles, the helper flag, and the
 * steps and index text built from them. Pure.
 */
import { describe, it, expect } from "vitest";
import { buildHookScript, convertEvents, summarizeEvents } from "../utils/events.js";
import { inputSteps } from "../utils/steps.js";
import { eventTexts } from "../utils/recordingIndex.js";

const frame = { x: 0, y: 0, w: 640, h: 360 };

describe("focus events (#323)", () => {
  const raw = [
    "900.0,focus,10,10,explorer.exe", // before the first frame
    "950.0,focus,10,10,code.exe|main.ts - project", // the one in front at t = 0
    "1500.0,down,20,20,left",
    "2000.0,focus,20,20,notepad.exe|notes, draft 2.txt - Notepad",
    "2500.0,focus,20,20,",
  ].join("\n");
  const events = convertEvents(raw, { startMs: 1000, frame, endSec: 10 });
  const focus = events.filter((e) => e.type === "focus");

  it("keeps the app in front at the first frame, at t = 0", () => {
    expect(focus[0]).toMatchObject({ t: 0, app: "code.exe", title: "main.ts - project", inFrame: false });
  });

  it("keeps commas in titles and reads a line with no data as an unknown app", () => {
    expect(focus[1]).toMatchObject({ t: 1, app: "notepad.exe", title: "notes, draft 2.txt - Notepad" });
    expect(focus[2]).toMatchObject({ t: 1.5, app: "unknown" });
    expect(focus[2]?.title).toBeUndefined();
    expect(summarizeEvents(events)).toMatchObject({ appSwitches: 3, clicks: 1 });
  });

  it("does not add a start focus when a switch lands exactly on t = 0", () => {
    const at0 = convertEvents("900.0,focus,0,0,a.exe\n1000.0,focus,0,0,b.exe", { startMs: 1000, frame });
    expect(at0.filter((e) => e.type === "focus").map((e) => e.app)).toEqual(["b.exe"]);
  });

  it("becomes switch steps and index text", () => {
    const steps = inputSteps(events).filter((s) => s.action === "switch");
    expect(steps.map((s) => s.text)).toEqual([
      'Switch to "main.ts - project" (code.exe)',
      'Switch to "notes, draft 2.txt - Notepad" (notepad.exe)',
      "Switch to unknown",
    ]);
    expect(eventTexts(focus).map((t) => t.text)).toContain("switch to notepad.exe notes, draft 2.txt - Notepad");
  });

  it("passes the focus mode to the helper, off by default", () => {
    expect(buildHookScript("p", "masked", 1)).toContain("[ScEvents]::Focus=0");
    expect(buildHookScript("p", "masked", 1, 0, "app")).toContain("[ScEvents]::Focus=1");
    expect(buildHookScript("p", "masked", 1, 0, "title")).toContain("[ScEvents]::Focus=2");
  });
});
