/**
 * DirectShow audio device discovery for system-audio capture.
 *
 * gdigrab is video-only, so capturing what is playing on the machine needs a
 * separate dshow audio input. Windows has no native loopback device, so system
 * audio requires a virtual-audio device (Stereo Mix, or a driver such as
 * screen-capture-recorder's virtual-audio-capturer or VB-CABLE). This module
 * enumerates the dshow audio devices ffmpeg can see and picks a loopback one.
 *
 * Microphone capture is intentionally not supported.
 *
 * The parsing and selection helpers are pure (string in, names out) so they are
 * unit-tested without ffmpeg or Windows present.
 */
import { ScreencastError } from "./errors.js";
import { requireFfmpeg, runCapture } from "./ffmpeg.js";

/** Names that identify a system-audio loopback device, matched case-insensitively
 * as a substring. */
export const LOOPBACK_HINTS = [
  "virtual-audio-capturer",
  "stereo mix",
  "what u hear",
  "wave out mix",
  "cable output",
  "voicemeeter output",
];

export const NO_LOOPBACK_HINT =
  "System audio capture needs a virtual-audio loopback device, which Windows " +
  "does not provide natively. Enable 'Stereo Mix' in Sound settings, or install " +
  "a loopback driver (for example screen-capture-recorder's " +
  "virtual-audio-capturer, or VB-CABLE). Then pass its name as `device`, or run " +
  "list_audio_devices to see what is available. Microphone capture is not supported.";

/**
 * Parse the stderr of `ffmpeg -list_devices true -f dshow -i dummy` into the
 * list of audio device names. Handles both the sectioned layout (a "DirectShow
 * audio devices" header) and the inline "(audio)" tag used by newer ffmpeg.
 */
export function parseDshowAudioDevices(stderr: string): string[] {
  return parseDshowDevices(stderr, "audio");
}

/** The video (camera) devices from the same listing, for webcam capture (#200). */
export function parseDshowVideoDevices(stderr: string): string[] {
  return parseDshowDevices(stderr, "video");
}

function parseDshowDevices(stderr: string, kind: "audio" | "video"): string[] {
  const names: string[] = [];
  let section: "audio" | "video" | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) {
      section = "audio";
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      section = "video";
      continue;
    }
    // The "Alternative name" lines also carry a quoted string; skip them.
    if (/Alternative name/i.test(line)) continue;
    const quoted = line.match(/"([^"]+)"/);
    if (!quoted) continue;
    const inlineAudio = /\(audio\)/i.test(line);
    const inlineVideo = /\(video\)/i.test(line);
    const isAudio = inlineAudio || (!inlineVideo && section === "audio");
    const isVideo = inlineVideo || (!inlineAudio && section === "video");
    if ((kind === "audio" ? isAudio : isVideo) && quoted[1]) names.push(quoted[1]);
  }
  return [...new Set(names)];
}

/**
 * Choose a loopback device. With an explicit name, return it only if ffmpeg
 * actually lists it (so a typo fails loudly). Otherwise return the first device
 * whose name matches a known loopback hint, or null when none qualifies.
 */
export function pickLoopbackDevice(
  devices: string[],
  explicit?: string,
): string | null {
  if (explicit && explicit.trim().length > 0) {
    return devices.includes(explicit) ? explicit : null;
  }
  const lower = (s: string) => s.toLowerCase();
  return (
    devices.find((d) => LOOPBACK_HINTS.some((h) => lower(d).includes(h))) ?? null
  );
}

/**
 * Device enumeration must not block a recording start for long. The dshow
 * `-list_devices` probe hangs on some setups (a misbehaving audio driver, no
 * audio hardware), so it is capped well below the normal ffmpeg job timeout.
 */
export const ENUM_TIMEOUT_MS = 12_000;

const ENUM_FAILED_HINT =
  "Enumerating DirectShow audio devices timed out or failed - usually a " +
  "misbehaving audio driver, or no audio device present. Record without system " +
  "audio, or fix the device, then retry. " + NO_LOOPBACK_HINT;

// A successful enumeration is cached for the process lifetime so an audio
// recording does not re-pay the cost (or risk the hang) on every start. The
// list_audio_devices tool forces a refresh, so a device enabled mid-session is
// still discoverable.
let cachedDevices: string[] | null = null;
let cachedVideo: string[] | null = null;

/** Run ffmpeg's device list and return the audio device names. ffmpeg exits
 * non-zero for the dummy input by design, so the exit code is ignored and the
 * names are read from stderr. A timeout or spawn failure becomes a clear,
 * actionable error rather than the raw "ffmpeg timed out" text. */
export async function listDshowAudioDevices(forceRefresh = false): Promise<string[]> {
  if (!forceRefresh && cachedDevices) return cachedDevices;
  await enumerateDshow();
  return cachedDevices ?? [];
}

/** The dshow video (camera) device names (#200), cached like the audio list. */
export async function listDshowVideoDevices(forceRefresh = false): Promise<string[]> {
  if (!forceRefresh && cachedVideo) return cachedVideo;
  await enumerateDshow();
  return cachedVideo ?? [];
}

/** Pick the camera: an explicit name must be listed; else the first one. */
export async function resolveVideoDevice(explicit?: string): Promise<string> {
  const devices = await listDshowVideoDevices();
  if (explicit && explicit.trim().length > 0) {
    if (devices.includes(explicit)) return explicit;
    throw new ScreencastError(
      `Video device "${explicit}" not found. Available dshow video devices: ${devices.join(", ") || "none"}.`,
    );
  }
  const first = devices[0];
  if (!first) throw new ScreencastError("No webcam (dshow video device) found.", "Connect a camera, then run list_video_devices.");
  return first;
}

async function enumerateDshow(): Promise<void> {
  const { ffmpeg } = requireFfmpeg();
  let res;
  try {
    res = await runCapture(
      ffmpeg,
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      ENUM_TIMEOUT_MS,
      { closeStdin: true },
    );
  } catch (err) {
    // runCapture rejects on timeout (and on spawn error); ffmpeg's by-design
    // non-zero exit for the dummy input resolves instead, so reaching here is a
    // genuine failure, not the expected exit code.
    throw new ScreencastError(
      `Could not enumerate audio devices (${(err as Error).message}).`,
      ENUM_FAILED_HINT,
    );
  }
  cachedDevices = parseDshowAudioDevices(res.stderr);
  cachedVideo = parseDshowVideoDevices(res.stderr);
}

/** Drop the cached device list (test seam; also lets a caller force a re-probe). */
export function clearAudioDeviceCache(): void {
  cachedDevices = null;
  cachedVideo = null;
}

/** Resolve the loopback device to use, throwing a clear, actionable error when
 * an explicit name is not present or no loopback device exists. */
export async function resolveLoopbackDevice(explicit?: string): Promise<string> {
  const devices = await listDshowAudioDevices();
  const picked = pickLoopbackDevice(devices, explicit);
  if (picked) return picked;
  if (explicit && explicit.trim().length > 0) {
    const available = devices.length > 0 ? devices.join(", ") : "none";
    throw new ScreencastError(
      `Audio device "${explicit}" not found. Available dshow audio devices: ${available}.`,
      NO_LOOPBACK_HINT,
    );
  }
  throw new ScreencastError("No system-audio loopback device found.", NO_LOOPBACK_HINT);
}
