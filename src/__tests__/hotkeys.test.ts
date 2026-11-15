/**
 * Recording hotkeys (#337): the helper flag and the stdout lines the server
 * reacts to. Registration itself needs a desktop; see the capture smoke.
 */
import { describe, it, expect } from "vitest";
import { HOTKEYS, buildHookScript, parseHotkeyLine } from "../utils/events.js";

describe("recording hotkeys (#337)", () => {
  it("registers them only when asked", () => {
    expect(buildHookScript("p", "masked", 1)).toContain("[ScEvents]::Hotkeys=$false");
    const s = buildHookScript("p", "masked", 1, { hotkeys: true });
    expect(s).toContain("[ScEvents]::Hotkeys=$true");
    // Ctrl+Alt+Shift with no auto-repeat, on M and S.
    expect(s).toContain("RegisterHotKey(IntPtr.Zero,1,0x4007,0x4D)");
    expect(s).toContain("RegisterHotKey(IntPtr.Zero,2,0x4007,0x53)");
    expect(HOTKEYS).toEqual({ marker: "Ctrl+Alt+Shift+M", stop: "Ctrl+Alt+Shift+S" });
  });

  it("reads presses and chords another app holds", () => {
    expect(parseHotkeyLine("hotkey marker")).toEqual({ pressed: "marker" });
    expect(parseHotkeyLine("hotkey stop\r")).toEqual({ pressed: "stop" });
    expect(parseHotkeyLine("hotkey-taken stop")).toEqual({ taken: "stop" });
    expect(parseHotkeyLine("ready")).toBeNull();
    expect(parseHotkeyLine("hotkey pause")).toBeNull();
  });
});
