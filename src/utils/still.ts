/**
 * Take one still of a resolved capture target, with the backend the caller
 * chose (#113). gdigrab (default) grabs what is on screen in about 0.2 s. The
 * opt-in "wgc" backend uses Windows Graphics Capture to grab a window's own
 * surface, even when other windows cover it, but takes 1-2 s and needs FFmpeg 8
 * with gfxcapture, so it is reserved for window targets that need it.
 */
import { ScreencastError } from "./errors.js";
import { runFfmpeg, wgcAvailable } from "./ffmpeg.js";
import { buildScreenshotArgs, buildWgcScreenshotArgs } from "./targets.js";
import type { ResolvedTarget } from "./resolveTarget.js";

export type StillBackend = "gdigrab" | "wgc";

/** Seconds a WGC still may take before giving up (they normally take 1-2 s). */
const WGC_TIMEOUT_MS = 20_000;

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
  await runFfmpeg(buildWgcScreenshotArgs(hwnd, output), WGC_TIMEOUT_MS);
}
