/** #228: a WGC still runs the repaint nudge while it waits for a frame. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScreencastError } from "../utils/errors.js";

const kill = vi.fn();
const spawn = vi.fn(() => ({ on: vi.fn(), kill }));
const runFfmpeg = vi.fn(async (_args: string[], _timeout?: number) => {});
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("../utils/ffmpeg.js", () => ({ runFfmpeg, wgcAvailable: () => true }));

const { captureStill } = await import("../utils/still.js");

const resolved = {
  target: { kind: "region" as const, x: 0, y: 0, w: 640, h: 480 },
  monitors: [],
  window: { x: 0, y: 0, width: 640, height: 480, matchedTitle: "Steam", matchCount: 1, matchKind: "exact" as const, candidates: ["Steam"], hwnd: 4242 },
};

describe("WGC still nudge (#228)", () => {
  beforeEach(() => {
    kill.mockClear();
    spawn.mockClear();
    runFfmpeg.mockReset();
  });

  it("repaints the window while grabbing, then stops the nudge", async () => {
    runFfmpeg.mockResolvedValue(undefined);
    await captureStill(resolved, "out.png", "wgc");
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe("powershell");
    expect(args.at(-1)).toContain("RedrawWindow([IntPtr]4242");
    expect(args.at(-1)).toContain(`Get-Process -Id ${process.pid}`);
    expect(runFfmpeg.mock.calls[0][0].join(" ")).toContain("gfxcapture=hwnd=4242");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("turns a timeout into a clear error and still stops the nudge", async () => {
    runFfmpeg.mockRejectedValue(new ScreencastError("ffmpeg timed out after 15s."));
    await expect(captureStill(resolved, "out.png", "wgc")).rejects.toThrow(/got no frame from the window/);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("does not nudge for the default backend", async () => {
    runFfmpeg.mockResolvedValue(undefined);
    await captureStill(resolved, "out.png");
    expect(spawn).not.toHaveBeenCalled();
  });
});
