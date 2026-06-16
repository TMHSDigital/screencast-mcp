import { describe, it, expect } from "vitest";
import {
  parseDshowAudioDevices,
  pickLoopbackDevice,
  LOOPBACK_HINTS,
} from "../utils/audioDevices.js";

// The sectioned layout: a "DirectShow audio devices" header, then quoted names
// each followed by an "Alternative name" line.
const SECTIONED = [
  `[dshow @ 0x1] DirectShow video devices (some may be both video and audio)`,
  `[dshow @ 0x1]  "Integrated Camera"`,
  `[dshow @ 0x1]     Alternative name "@device_pnp_\\\\?\\usb#vid"`,
  `[dshow @ 0x1] DirectShow audio devices`,
  `[dshow @ 0x1]  "Microphone (Realtek(R) Audio)"`,
  `[dshow @ 0x1]     Alternative name "@device_cm_{guid}"`,
  `[dshow @ 0x1]  "Stereo Mix (Realtek(R) Audio)"`,
  `[dshow @ 0x1]     Alternative name "@device_cm_{guid2}"`,
].join("\n");

// The inline layout used by newer ffmpeg: an "(audio)" / "(video)" tag per line.
const INLINE = [
  `[dshow @ 0x1] "Integrated Camera" (video)`,
  `[dshow @ 0x1]   Alternative name "@device_pnp_camera"`,
  `[dshow @ 0x1] "virtual-audio-capturer" (audio)`,
  `[dshow @ 0x1]   Alternative name "@device_sw_{guid}"`,
].join("\n");

describe("parseDshowAudioDevices", () => {
  it("reads audio names from the sectioned layout and skips video + alt names", () => {
    expect(parseDshowAudioDevices(SECTIONED)).toEqual([
      "Microphone (Realtek(R) Audio)",
      "Stereo Mix (Realtek(R) Audio)",
    ]);
  });
  it("reads audio names from the inline-tagged layout", () => {
    expect(parseDshowAudioDevices(INLINE)).toEqual(["virtual-audio-capturer"]);
  });
  it("returns an empty list when there are no audio devices", () => {
    expect(parseDshowAudioDevices("no devices here")).toEqual([]);
  });
});

describe("pickLoopbackDevice", () => {
  const devices = ["Microphone (Realtek)", "Stereo Mix (Realtek)", "virtual-audio-capturer"];

  it("auto-picks the first device matching a loopback hint", () => {
    expect(pickLoopbackDevice(devices)).toBe("Stereo Mix (Realtek)");
  });
  it("returns an explicit device only when it is actually listed", () => {
    expect(pickLoopbackDevice(devices, "virtual-audio-capturer")).toBe("virtual-audio-capturer");
    expect(pickLoopbackDevice(devices, "Nonexistent Device")).toBeNull();
  });
  it("returns null when no device matches a loopback hint", () => {
    expect(pickLoopbackDevice(["Microphone (Realtek)"])).toBeNull();
  });
  it("does not treat a plain microphone as loopback", () => {
    expect(LOOPBACK_HINTS.some((h) => "microphone (realtek)".includes(h))).toBe(false);
  });
});
