/**
 * #180: `full` resolves with the live monitor list, so callers that size the
 * target (wait_for_change, event framing) get the virtual desktop geometry.
 */
import { describe, it, expect, vi } from "vitest";
import type { Monitor } from "../utils/monitors.js";

const MONITORS: Monitor[] = [
  { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true },
  { index: 1, x: 1920, y: 301, width: 1920, height: 1080, primary: false },
];
vi.mock("../utils/monitors.js", () => ({ getMonitors: async () => MONITORS }));

const { resolveCaptureTarget } = await import("../utils/resolveTarget.js");
const { targetSize } = await import("../utils/diff.js");

describe("resolveCaptureTarget full (#180)", () => {
  it("returns the live monitor list", async () => {
    const r = await resolveCaptureTarget("full");
    expect(r.target).toEqual({ kind: "full" });
    expect(r.monitors).toEqual(MONITORS);
  });

  it("gives wait_for_change a sized area instead of 'No monitors found'", async () => {
    const { target, monitors } = await resolveCaptureTarget("full");
    expect(targetSize(target, monitors)).toEqual({ x: 0, y: 0, width: 3840, height: 1381 });
  });
});
