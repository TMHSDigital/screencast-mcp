/**
 * Take one still of a resolved capture target, with the backend the caller
 * chose (#113). gdigrab (default) grabs what is on screen in about 0.2 s. The
 * opt-in "wgc" backend uses Windows Graphics Capture to grab a window's own
 * surface, even when other windows cover it, but takes 1-2 s and needs FFmpeg 8
 * with gfxcapture, so it is reserved for window targets that need it.
 *
 * WGC delivers a frame only when the window repaints, and a covered or idle
 * window may not repaint at all, so the still runs the recorder's tiny
 * repaint nudge while it waits (#228).
 */
import { spawn } from "node:child_process";
import { ScreencastError } from "./errors.js";
import { nudgeScript } from "./wgc.js";
import { runFfmpeg, wgcAvailable } from "./ffmpeg.js";
import { buildScreenshotArgs, buildWgcScreenshotArgs } from "./targets.js";
import type { ResolvedTarget } from "./resolveTarget.js";

export type StillBackend = "gdigrab" | "wgc";

/** How long a WGC still may take before giving up (they normally take 1-2 s,
 * including the nudge's PowerShell start). */
export const WGC_STILL_TIMEOUT_MS = 15_000;

export async function captureStill(
  resolved: ResolvedTarget,
  output: string,
  backend: StillBackend = "gdigrab",
): Promise<void> {
  if (backend === "gdigrab") {
    await runFfmpeg(buildScreenshotArgs(resolved.target, output, resolved.monitors), 60_000);
    return;
  }
  const hwnd = resolved.window?.hwnd;
  if (hwnd === undefined) {
    throw new ScreencastError("backend 'wgc' captures a single window: use a window:<title> target.");
  }
  if (!wgcAvailable()) {
    throw new ScreencastError(
      "backend 'wgc' needs FFmpeg 8 or newer with the gfxcapture filter (Windows Graphics Capture).",
      "Check with `ffmpeg -h filter=gfxcapture`. Recent Windows builds (e.g. `winget install Gyan.FFmpeg`) include it. " +
        "Or use the default backend, which captures what is visible on screen.",
    );
  }
  const nudge = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", nudgeScript(hwnd, 100, process.pid)], {
    stdio: "ignore",
    windowsHide: true,
  });
  nudge.on("error", () => {
    /* no nudge: a window that repaints by itself still works */
  });
  try {
    await runFfmpeg(buildWgcScreenshotArgs(hwnd, output), WGC_STILL_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof ScreencastError && /timed out/.test(err.message)) {
      throw new ScreencastError(
        `Windows Graphics Capture got no frame from the window in ${WGC_STILL_TIMEOUT_MS / 1000} s.`,
        "The window may be hung or protected from capture. Try the default backend with the window in front.",
      );
    }
    throw err;
  } finally {
    nudge.kill();
  }
}
