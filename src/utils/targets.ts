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
import { stillOutput } from "./paths.js";

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

export interface AudioCaptureOptions {
  /** A resolved dshow loopback device name (see utils/audioDevices.ts). */
  device: string;
}

// gdigrab is video-only, so system audio comes from a separate dshow input.
// Device resolution (enumeration + loopback selection) lives in
// utils/audioDevices.ts; this stays pure and just takes the resolved name.
export function buildAudioInputArgs(audio?: AudioCaptureOptions): string[] {
  if (!audio || audio.device.trim().length === 0) return [];
  // No surrounding quotes: passed as a single argv element, ffmpeg reads the
  // whole value (spaces included) as the device spec.
  return ["-f", "dshow", "-i", `audio=${audio.device}`];
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
    const [px = "", py = "", pw = "", ph = ""] = parts;
    const [x, y, w, h] = [
      parseIntStrict(px, "region x"),
      parseIntStrict(py, "region y"),
      parseIntStrict(pw, "region w"),
      parseIntStrict(ph, "region h"),
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

/** The virtual desktop = the bounding box of every monitor. gdigrab captures
 * this rectangle, so a region must fit inside it. Returns a zero-size box when
 * no monitors are supplied (the caller then skips bounds validation). */
export function virtualDesktopBounds(
  monitors: Monitor[],
): { x: number; y: number; w: number; h: number } {
  if (monitors.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...monitors.map((m) => m.x));
  const minY = Math.min(...monitors.map((m) => m.y));
  const maxX = Math.max(...monitors.map((m) => m.x + m.width));
  const maxY = Math.max(...monitors.map((m) => m.y + m.height));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Reject a region rectangle that is not fully inside the virtual desktop.
 * gdigrab passes the offset/size straight through, so an off-desktop rectangle
 * (a negative offset before the leftmost monitor, or one running past the
 * right/bottom edge) otherwise fails with a cryptic libav error. Negative
 * offsets are legitimate when a monitor sits left of / above the primary, so
 * the rectangle is checked against the real desktop origin, not a blanket >= 0.
 * With no monitor geometry the check is skipped (cannot validate).
 */
export function validateRegionOnDesktop(
  region: { x: number; y: number; w: number; h: number },
  monitors: Monitor[],
): void {
  if (monitors.length === 0) return;
  const v = virtualDesktopBounds(monitors);
  const within =
    region.x >= v.x &&
    region.y >= v.y &&
    region.x + region.w <= v.x + v.w &&
    region.y + region.h <= v.y + v.h;
  if (!within) {
    throw new ScreencastError(
      `region ${region.x},${region.y},${region.w},${region.h} is outside the ` +
        `virtual desktop (origin ${v.x},${v.y}, size ${v.w}x${v.h}). gdigrab ` +
        `captures the desktop, so the rectangle must fit inside it. Adjust the ` +
        `offset/size, or use monitor:<index> to capture a whole display.`,
    );
  }
}

/** Encoder args for a quality preset (libx264, web-safe pixel format). */
export function resolveQuality(quality: Quality): string[] {
  const q = QUALITY_PRESETS[quality];
  if (!q) throw new ScreencastError(`Unknown quality preset "${quality}".`);
  return ["-c:v", "libx264", "-preset", q.preset, "-crf", String(q.crf),
    "-pix_fmt", "yuv420p"];
}

/** Largest even integer <= n. libx264 + yuv420p requires even W/H. */
function evenDown(n: number): number {
  return n - (n % 2);
}

export interface InputArgsOptions {
  /**
   * Round the capture width/height down to even. Required for the recording
   * path (libx264 + yuv420p rejects odd dimensions); the screenshot path (PNG)
   * leaves dimensions untouched so it can grab an exact odd-sized rectangle.
   */
  evenSize?: boolean;
}

/** The gdigrab input args (offset/size/input) for a target. */
export function targetInputArgs(
  target: Target,
  monitors: Monitor[],
  opts: InputArgsOptions = {},
): string[] {
  switch (target.kind) {
    case "full": {
      // An odd-sized virtual desktop (offset monitors) fails libx264 + yuv420p,
      // so the recording path grabs it as an even-sized region instead (#226).
      const v = virtualDesktopBounds(monitors);
      if (opts.evenSize && monitors.length > 0 && (v.w % 2 !== 0 || v.h % 2 !== 0)) {
        return [
          "-offset_x", String(v.x),
          "-offset_y", String(v.y),
          "-video_size", `${evenDown(v.w)}x${evenDown(v.h)}`,
          "-i", "desktop",
        ];
      }
      return ["-i", "desktop"];
    }
    case "window":
      // A window target must be resolved to its on-screen rectangle first (see
      // resolveCaptureTarget). gdigrab `title=` grabs a blank surface for
      // GPU-composited windows, so it is never used.
      throw new ScreencastError(
        "Internal: a window target must be resolved to a region before " +
          "building capture args. Call resolveCaptureTarget().",
      );
    case "region": {
      let { w, h } = target;
      if (opts.evenSize) {
        w = evenDown(w);
        h = evenDown(h);
        if (w <= 0 || h <= 0) {
          throw new ScreencastError(
            `region ${target.w}x${target.h} is too small to record: width and ` +
              `height must each be at least 2px (the video encoder needs even ` +
              `dimensions). Use a larger region, or take a screenshot instead.`,
          );
        }
      }
      return [
        "-offset_x", String(target.x),
        "-offset_y", String(target.y),
        "-video_size", `${w}x${h}`,
        "-i", "desktop",
      ];
    }
    case "monitor": {
      const m = resolveMonitor(target.index, monitors);
      const w = opts.evenSize ? evenDown(m.width) : m.width;
      const h = opts.evenSize ? evenDown(m.height) : m.height;
      return [
        "-offset_x", String(m.x),
        "-offset_y", String(m.y),
        "-video_size", `${w}x${h}`,
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
  audio?: AudioCaptureOptions;
  /** Stop capturing after this many seconds (ffmpeg -t). 0 / absent = no cap. */
  maxDurationSec?: number;
  /** False leaves the OS cursor out of gdigrab's frames (#170); the cursor tool redraws it. */
  drawMouse?: boolean;
  /** The video input args in place of gdigrab's (ddagrab, #199). */
  videoInput?: string[];
  /** Video encoder args in place of libx264's (a hardware encoder, #199). */
  videoCodec?: string[];
  /** Also record a dshow camera to a second file (#200). */
  webcam?: WebcamCaptureOptions;
}

export interface WebcamCaptureOptions {
  /** dshow video device name (see list_video_devices). */
  device: string;
  output: string;
  /** Encoder args for the camera (system-memory frames). */
  codec?: string[];
}

/** A dshow camera input. Wall-clock timestamps make its banner start time
 * comparable with gdigrab's, which is how the two files are lined up. Pure. */
export function buildWebcamInputArgs(device: string): string[] {
  if (device.trim().length === 0) throw new ScreencastError("webcam device must not be empty.");
  return ["-f", "dshow", "-use_wallclock_as_timestamps", "1", "-rtbufsize", "256M", "-i", `video=${device}`];
}

/** Default recording cap when start_recording is given none (#82): one hour. */
export const DEFAULT_MAX_RECORDING_SEC = 3600;

/**
 * Resolve the effective recording cap: an explicit per-call value, else
 * SCREENCAST_MAX_RECORDING_SEC, else DEFAULT_MAX_RECORDING_SEC. 0 means no cap.
 * Pure (env is passed in) so the precedence is unit-tested.
 */
export function resolveMaxDuration(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (explicit !== undefined) return validateMaxDuration(explicit);
  const raw = env.SCREENCAST_MAX_RECORDING_SEC;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX_RECORDING_CAP_SEC) {
      throw new ScreencastError(
        `SCREENCAST_MAX_RECORDING_SEC must be an integer from 0 (no cap) to ${MAX_RECORDING_CAP_SEC} (7 days), got "${raw}".`,
      );
    }
    return n;
  }
  return DEFAULT_MAX_RECORDING_SEC;
}

/** The largest accepted cap: 7 days. Use 0 for no cap at all (#184). */
export const MAX_RECORDING_CAP_SEC = 7 * 24 * 3600;

function validateMaxDuration(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > MAX_RECORDING_CAP_SEC) {
    throw new ScreencastError(
      `maxDurationSec must be an integer from 0 (no cap) to ${MAX_RECORDING_CAP_SEC} (7 days).`,
    );
  }
  return n;
}

function validateFps(fps: number): number {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    throw new ScreencastError("fps must be an integer between 1 and 120.");
  }
  return fps;
}

/** A keyframe every 2 s of capture. x264's default (250 frames) is 25 s at 10
 * fps, so a stream-copy cut snaps far from the cut point and hides that much
 * content behind an edit list (#203). */
export function captureKeyframeArgs(fps: number): string[] {
  return ["-g", String(Math.max(1, Math.round(fps * 2)))];
}

/** Fragmented mp4: keeps the file playable even if the process is killed
 * before the trailing moov atom would normally be written. */
const FRAGMENTED_MP4 = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"];

/** Build the full ffmpeg argument vector for a recording (gdigrab -> mp4). */
export function buildCaptureArgs(target: Target, opts: CaptureOptions): string[] {
  const fps = validateFps(opts.fps ?? DEFAULT_FPS);
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const monitors = opts.monitors ?? [];
  const cap = validateMaxDuration(opts.maxDurationSec ?? 0);
  // Output-side -t: ffmpeg stops and finalizes the file cleanly at the cap.
  const capArgs = cap > 0 ? ["-t", String(cap)] : [];
  const cam = opts.webcam;
  // A second output needs explicit maps, or ffmpeg would pick the "best"
  // (largest) video for both files.
  const camInput = opts.audio ? 2 : 1;
  return [
    "-y",
    ...(opts.videoInput ?? [
      "-f", "gdigrab",
      "-framerate", String(fps),
      ...(opts.drawMouse === false ? ["-draw_mouse", "0"] : []),
      ...targetInputArgs(target, monitors, { evenSize: true }),
    ]),
    ...buildAudioInputArgs(opts.audio),
    ...(cam ? buildWebcamInputArgs(cam.device) : []),
    ...(cam ? ["-map", "0:v", ...(opts.audio ? ["-map", "1:a"] : [])] : []),
    // Without monitor geometry `full` cannot be sized up front, so crop it to
    // even dimensions in the filter graph instead (#226).
    ...(!opts.videoInput && target.kind === "full" && monitors.length === 0
      ? ["-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2"]
      : []),
    ...(opts.videoCodec ?? resolveQuality(quality)),
    ...captureKeyframeArgs(fps),
    ...(opts.audio ? ["-c:a", "aac", "-b:a", "160k"] : []),
    ...FRAGMENTED_MP4,
    ...capArgs,
    opts.output,
    ...(cam
      ? [
          "-map", `${camInput}:v`,
          ...(cam.codec ?? resolveQuality(quality)),
          ...captureKeyframeArgs(fps),
          ...FRAGMENTED_MP4,
          ...capArgs,
          cam.output,
        ]
      : []),
  ];
}

/** gdigrab rate for a still. gdigrab paces grabs at the input rate, so at 1
 * fps ffmpeg waits about two frame intervals (~2 s) before writing a single
 * frame; at 30 fps the same still takes ~0.2 s and is pixel-identical (#88). */
export const SCREENSHOT_GRAB_FPS = 30;

/** A still of one window's own surface through Windows Graphics Capture
 * (FFmpeg 8's gfxcapture), selected by handle (#113). Unlike gdigrab, it
 * captures the window even when other windows cover it. */
export function buildWgcScreenshotArgs(hwnd: number, output: string): string[] {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new ScreencastError("Invalid window handle.");
  return [
    "-y", "-v", "error",
    "-filter_complex", `gfxcapture=hwnd=${hwnd}:max_framerate=30,hwdownload,format=bgra`,
    "-frames:v", "1",
    ...stillOutput(output),
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
    "-framerate", String(SCREENSHOT_GRAB_FPS),
    ...targetInputArgs(target, monitors),
    "-frames:v", "1",
    ...stillOutput(output),
  ];
}

/** Where the recorded video sits on the desktop, and its size: the offset that
 * maps desktop coordinates (input events, #118) to video pixels. `full` needs
 * the monitor list for the virtual desktop's origin, which can be negative. */
export function captureFrame(
  target: Target,
  monitors: Monitor[],
): { x: number; y: number; w: number; h: number } {
  switch (target.kind) {
    case "region":
      return { x: target.x, y: target.y, w: evenDown(target.w), h: evenDown(target.h) };
    case "monitor": {
      const m = resolveMonitor(target.index, monitors);
      return { x: m.x, y: m.y, w: evenDown(m.width), h: evenDown(m.height) };
    }
    case "full": {
      const v = virtualDesktopBounds(monitors);
      return { x: v.x, y: v.y, w: evenDown(v.w), h: evenDown(v.h) };
    }
    case "window":
      throw new ScreencastError("Internal: resolve a window target to a region first.");
  }
}
