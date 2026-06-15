/**
 * Capture target parsing and gdigrab argument construction.
 *
 * Target grammar (a single string so an agent never has to juggle quoting):
 *   full                 - the whole virtual desktop
 *   monitor:<index>      - one display; 0 is primary (see monitors.ts)
 *   window:<title>       - a window by exact title (everything after the colon)
 *   region:<x>,<y>,<w>,<h> - an absolute pixel rectangle on the virtual desktop
 *
 * Everything here is pure (the monitor list is passed in), so the offset math
 * that makes monitor:1 grab the second display is unit-tested without Windows.
 */
import { ScreencastError } from "./errors.js";
import type { Monitor } from "./monitors.js";

export type Quality = "draft" | "standard" | "high";

export type Target =
  | { kind: "full" }
  | { kind: "monitor"; index: number }
  | { kind: "window"; title: string }
  | { kind: "region"; x: number; y: number; w: number; h: number };

export const QUALITY_PRESETS: Record<Quality, { preset: string; crf: number }> =
  {
    draft: { preset: "ultrafast", crf: 28 },
    standard: { preset: "veryfast", crf: 23 },
    high: { preset: "medium", crf: 18 },
  };

export const DEFAULT_FPS = 30;
export const DEFAULT_QUALITY: Quality = "standard";

// Phase 2 seam: audio capture (dshow / WASAPI loopback) attaches here. gdigrab
// is video-only, so Phase 1 records no audio. Keep this returning [] until the
// audio device-selection surface lands - do NOT half-wire it.
export function buildAudioInputArgs(): string[] {
  return [];
}

function parseIntStrict(value: string, label: string): number {
  if (!/^-?\d+$/.test(value.trim())) {
    throw new ScreencastError(`${label} must be an integer, got "${value}".`);
  }
  return parseInt(value, 10);
}

/** Parse a target spec string into a structured Target. */
export function parseTarget(spec: string): Target {
  const raw = spec.trim();
  if (raw === "" || raw.toLowerCase() === "full") return { kind: "full" };

  const colon = raw.indexOf(":");
  if (colon === -1) {
    throw new ScreencastError(
      `Unrecognized target "${spec}". Use full | monitor:<index> | ` +
        `window:<title> | region:<x>,<y>,<w>,<h>.`,
    );
  }
  const kind = raw.slice(0, colon).toLowerCase();
  const rest = raw.slice(colon + 1);

  if (kind === "monitor") {
    const index = parseIntStrict(rest, "monitor index");
    if (index < 0) throw new ScreencastError("monitor index must be >= 0.");
    return { kind: "monitor", index };
  }
  if (kind === "window") {
    const title = rest.trim();
    if (title === "") throw new ScreencastError("window title must not be empty.");
    return { kind: "window", title };
  }
  if (kind === "region") {
    const parts = rest.split(",").map((p) => p.trim());
    if (parts.length !== 4) {
      throw new ScreencastError(
        `region must be x,y,w,h (4 integers), got "${rest}".`,
      );
    }
    const [x, y, w, h] = [
      parseIntStrict(parts[0], "region x"),
      parseIntStrict(parts[1], "region y"),
      parseIntStrict(parts[2], "region w"),
      parseIntStrict(parts[3], "region h"),
    ];
    if (w <= 0 || h <= 0) {
      throw new ScreencastError("region width and height must be positive.");
    }
    return { kind: "region", x, y, w, h };
  }
  throw new ScreencastError(
    `Unknown target kind "${kind}". Use full | monitor | window | region.`,
  );
}

/** Resolve a monitor index to its pixel bounds using the supplied monitor list. */
export function resolveMonitor(index: number, monitors: Monitor[]): Monitor {
  const m = monitors.find((mon) => mon.index === index);
  if (!m) {
    const available = monitors.map((mon) => mon.index).join(", ") || "none";
    throw new ScreencastError(
      `monitor:${index} not found. Available monitor indexes: ${available}.`,
    );
  }
  return m;
}

/** Encoder args for a quality preset (libx264, web-safe pixel format). */
export function resolveQuality(quality: Quality): string[] {
  const q = QUALITY_PRESETS[quality];
  if (!q) throw new ScreencastError(`Unknown quality preset "${quality}".`);
  return ["-c:v", "libx264", "-preset", q.preset, "-crf", String(q.crf),
    "-pix_fmt", "yuv420p"];
}

/** The gdigrab input args (offset/size/input) for a target. */
export function targetInputArgs(target: Target, monitors: Monitor[]): string[] {
  switch (target.kind) {
    case "full":
      return ["-i", "desktop"];
    case "window":
      return ["-i", `title=${target.title}`];
    case "region":
      return [
        "-offset_x", String(target.x),
        "-offset_y", String(target.y),
        "-video_size", `${target.w}x${target.h}`,
        "-i", "desktop",
      ];
    case "monitor": {
      const m = resolveMonitor(target.index, monitors);
      return [
        "-offset_x", String(m.x),
        "-offset_y", String(m.y),
        "-video_size", `${m.width}x${m.height}`,
        "-i", "desktop",
      ];
    }
  }
}

export interface CaptureOptions {
  fps?: number;
  quality?: Quality;
  output: string;
  monitors?: Monitor[];
}

function validateFps(fps: number): number {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    throw new ScreencastError("fps must be an integer between 1 and 120.");
  }
  return fps;
}

/** Build the full ffmpeg argument vector for a recording (gdigrab -> mp4). */
export function buildCaptureArgs(target: Target, opts: CaptureOptions): string[] {
  const fps = validateFps(opts.fps ?? DEFAULT_FPS);
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const monitors = opts.monitors ?? [];
  return [
    "-y",
    "-f", "gdigrab",
    "-framerate", String(fps),
    ...targetInputArgs(target, monitors),
    ...buildAudioInputArgs(),
    ...resolveQuality(quality),
    // Fragmented mp4: keeps the file playable even if the process is killed
    // before the trailing moov atom would normally be written.
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    opts.output,
  ];
}

/** Build ffmpeg args for a single-frame screenshot (gdigrab -> png). */
export function buildScreenshotArgs(
  target: Target,
  output: string,
  monitors: Monitor[] = [],
): string[] {
  return [
    "-y",
    "-f", "gdigrab",
    "-framerate", "1",
    ...targetInputArgs(target, monitors),
    "-frames:v", "1",
    output,
  ];
}
