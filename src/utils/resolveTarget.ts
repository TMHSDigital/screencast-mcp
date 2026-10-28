/**
 * Shared capture-target resolution for screenshot and start_recording.
 *
 * This is the one place that turns a raw target spec into the concrete
 * (target, monitors) pair the gdigrab argument builders consume, so both the
 * still and the recording paths get identical behaviour:
 *   - monitor:<i> -> its pixel bounds (queried live)
 *   - window:<title> -> the on-screen RECTANGLE the window occupies, captured
 *     via the proven region path (NOT gdigrab title=, which grabs a blank
 *     surface for GPU-composited windows). The rect is resolved once, here.
 *   - region -> validated against the live desktop, then passed through.
 *   - full -> passed through, with the live monitor list so callers can size
 *     the virtual desktop (#180).
 */
import { parseTarget, validateRegionOnDesktop, type Target } from "./targets.js";
import { getMonitors, type Monitor } from "./monitors.js";
import { resolveWindowBounds, type WindowBounds } from "./windows.js";

export interface ResolvedTarget {
  target: Target;
  monitors: Monitor[];
  /** Present only when the raw spec was a window: surfaced for the result. */
  window?: WindowBounds;
}

export interface ResolveOptions {
  /** For window: targets, refuse the substring fallback (#89). */
  exactTitle?: boolean;
  /** The capture backend: "wgc" may pick a cloaked window, gdigrab may not (#227). */
  backend?: "gdigrab" | "wgc" | "ddagrab";
}

/** Resolve a raw target spec into builder-ready (target, monitors). */
export async function resolveCaptureTarget(
  spec: string,
  opts: ResolveOptions = {},
): Promise<ResolvedTarget> {
  const parsed = parseTarget(spec);
  if (parsed.kind === "window") {
    const w = await resolveWindowBounds(parsed.title, {
      exactOnly: opts.exactTitle,
      allowCloaked: opts.backend === "wgc",
    });
    return {
      target: { kind: "region", x: w.x, y: w.y, w: w.width, h: w.height },
      monitors: [],
      window: w,
    };
  }
  if (parsed.kind === "monitor") {
    return { target: parsed, monitors: await getMonitors() };
  }
  if (parsed.kind === "region") {
    // A window resolves to a region already clamped to the desktop; a raw
    // region does not, so validate it against the live desktop bounds before
    // gdigrab fails cryptically on an off-desktop rectangle.
    validateRegionOnDesktop(parsed, await getMonitors());
    return { target: parsed, monitors: [] };
  }
  return { target: parsed, monitors: await getMonitors() };
}
