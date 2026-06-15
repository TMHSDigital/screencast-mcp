import { describe, it, expect } from "vitest";
import { parseMonitors } from "../utils/monitors.js";

describe("parseMonitors", () => {
  it("orders the primary monitor first and assigns indexes", () => {
    // PowerShell may return screens in any order; the secondary comes first here.
    const raw = [
      { X: 2560, Y: 0, Width: 1920, Height: 1440, Primary: false },
      { X: 0, Y: 0, Width: 2560, Height: 1440, Primary: true },
    ];
    const mons = parseMonitors(raw);
    expect(mons[0]).toMatchObject({ index: 0, x: 0, width: 2560, primary: true });
    expect(mons[1]).toMatchObject({ index: 1, x: 2560, width: 1920, primary: false });
  });

  it("handles a single (object, not array) screen", () => {
    const mons = parseMonitors({ X: 0, Y: 0, Width: 1920, Height: 1080, Primary: true });
    expect(mons).toHaveLength(1);
    expect(mons[0].index).toBe(0);
  });

  it("returns an empty list for nullish input", () => {
    expect(parseMonitors(null)).toEqual([]);
    expect(parseMonitors(undefined)).toEqual([]);
  });

  it("orders non-primary monitors left-to-right", () => {
    const raw = [
      { X: 1920, Y: 0, Width: 1920, Height: 1080, Primary: false },
      { X: 0, Y: 0, Width: 1920, Height: 1080, Primary: false },
      { X: 3840, Y: 0, Width: 1920, Height: 1080, Primary: true },
    ];
    const mons = parseMonitors(raw);
    expect(mons.map((m) => m.x)).toEqual([3840, 0, 1920]);
    expect(mons[0].primary).toBe(true);
  });
});
