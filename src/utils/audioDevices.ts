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
    if (isAudio) names.push(quoted[1]);
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

/** Run ffmpeg's device list and return the audio device names. ffmpeg exits
 * non-zero for the dummy input by design, so the exit code is ignored and the
 * names are read from stderr. */
export async function listDshowAudioDevices(): Promise<string[]> {
  const { ffmpeg } = requireFfmpeg();
  const res = await runCapture(
    ffmpeg,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    30_000,
  );
  return parseDshowAudioDevices(res.stderr);
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
