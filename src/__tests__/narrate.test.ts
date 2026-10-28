/**
 * narrate (#175): line resolution, placement warnings, the WAV header parser,
 * the SRT cues, and the mix builder. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  buildNarrateArgs,
  narrationCues,
  parseVoices,
  placementWarnings,
  resolveLines,
  wavDurationSec,
  MAX_LINES,
  type Placement,
} from "../utils/narrate.js";

const filter = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;

/** A minimal PCM WAV header (+ silence) for `sec` seconds at rate/channels. */
function wav(sec: number, rate = 16_000, channels = 1, opts: { extraChunk?: boolean; dataSize?: number } = {}): Buffer {
  const byteRate = rate * channels * 2;
  const dataBytes = Math.round(sec * byteRate);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);
  const extra = opts.extraChunk ? Buffer.concat([Buffer.from("LIST", "ascii"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0", "ascii")]) : Buffer.alloc(0);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write("data", 0, "ascii");
  dataHdr.writeUInt32LE(opts.dataSize ?? dataBytes, 4);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, extra, dataHdr, Buffer.alloc(dataBytes)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe("resolveLines", () => {
  const markers = [{ t: 4.5, label: "Bug appears" }, { t: 12, label: "Fix" }];

  it("uses t, or the matching marker's time (case-insensitive), sorted by start", () => {
    const got = resolveLines(
      [{ marker: "fix", text: "Now the fix." }, { t: 0, text: "  Welcome   to the demo. " }, { marker: "BUG APPEARS", text: "Here it breaks." }],
      markers,
    );
    expect(got).toEqual([
      { t: 0, text: "Welcome to the demo." },
      { t: 4.5, text: "Here it breaks." },
      { t: 12, text: "Now the fix." },
    ]);
  });

  it("names the markers when one is missing", () => {
    expect(() => resolveLines([{ marker: "nope", text: "x" }], markers)).toThrow(/no marker labelled "nope"/);
    try {
      resolveLines([{ marker: "nope", text: "x" }], markers);
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/"Bug appears", "Fix"/);
    }
  });

  it("rejects empty, timeless, double-timed, and oversized lines", () => {
    expect(() => resolveLines([], markers)).toThrow(/empty/);
    expect(() => resolveLines([{ text: "x" }], markers)).toThrow(/needs t/);
    expect(() => resolveLines([{ t: 1, marker: "Fix", text: "x" }], markers)).toThrow(/both/);
    expect(() => resolveLines([{ t: 1, text: "   " }], markers)).toThrow(/no text/);
    expect(() => resolveLines([{ t: -1, text: "x" }], markers)).toThrow(/non-negative/);
    expect(() => resolveLines([{ t: 1, text: "x".repeat(1001) }], markers)).toThrow(/at most 1000/);
    expect(() => resolveLines(Array.from({ length: MAX_LINES + 1 }, (_, i) => ({ t: i, text: "x" })), markers)).toThrow(/At most/);
  });
});

describe("placementWarnings", () => {
  const p = (t: number, durationSec: number, text = `line ${t}`): Placement => ({ t, durationSec, text });

  it("is quiet when every line fits", () => {
    expect(placementWarnings([p(0, 2), p(3, 2)], 10)).toEqual([]);
  });

  it("warns when a line runs into the next one", () => {
    const w = placementWarnings([p(0, 4.2), p(3, 1)], 10);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/at 0s .* runs 1\.2s past the next line \(3s\)/);
  });

  it("warns when a line runs past the end or starts after it", () => {
    expect(placementWarnings([p(8, 3)], 10)[0]).toMatch(/1s past the end/);
    expect(placementWarnings([p(11, 1)], 10)[0]).toMatch(/starts after the video ends/);
  });

  it("tolerates a 50 ms touch", () => {
    expect(placementWarnings([p(0, 3.03), p(3, 1)], 10)).toEqual([]);
  });
});

describe("narrationCues", () => {
  it("clips cues to the next line and the end of the video", () => {
    const cues = narrationCues(
      [{ t: 0, durationSec: 4, text: "a" }, { t: 3, durationSec: 1, text: "b" }, { t: 9, durationSec: 3, text: "c" }, { t: 12, durationSec: 1, text: "d" }],
      10,
    );
    expect(cues).toEqual([
      { start: 0, end: 3, text: "a" },
      { start: 3, end: 4, text: "b" },
      { start: 9, end: 10, text: "c" },
    ]);
  });
});

describe("wavDurationSec", () => {
  it("reads data size / byte rate", () => {
    expect(wavDurationSec(wav(2.5))).toBeCloseTo(2.5, 3);
    expect(wavDurationSec(wav(1, 22_050, 2))).toBeCloseTo(1, 3);
  });
  it("skips chunks before data, and copes with an unset data size", () => {
    expect(wavDurationSec(wav(1.25, 16_000, 1, { extraChunk: true }))).toBeCloseTo(1.25, 3);
    expect(wavDurationSec(wav(0.5, 16_000, 1, { dataSize: 0xffffffff }))).toBeCloseTo(0.5, 3);
  });
  it("rejects what is not a WAV", () => {
    expect(() => wavDurationSec(Buffer.from("not a wav file at all"))).toThrow(/WAV/);
  });
});

describe("parseVoices", () => {
  it("accepts one voice or many", () => {
    expect(parseVoices({ voices: { name: "Microsoft Zira", language: "en-US", gender: "Female" } })).toEqual([
      { name: "Microsoft Zira", language: "en-US", gender: "Female" },
    ]);
    expect(parseVoices({ voices: [{ name: "A" }, { name: "B" }] }).map((v) => v.name)).toEqual(["A", "B"]);
    expect(parseVoices({})).toEqual([]);
  });
});

describe("buildNarrateArgs", () => {
  const placed: Placement[] = [{ t: 1, durationSec: 2, text: "a" }, { t: 5.25, durationSec: 1, text: "b" }];
  const wavs = ["l0.wav", "l1.wav"];

  it("delays each line, sums them unnormalized, pads to the video, and ducks the original", () => {
    const args = buildNarrateArgs("in.mp4", wavs, "out.mp4", placed, 10, { hasAudio: true });
    expect(args.slice(0, 7)).toEqual(["-y", "-i", "in.mp4", "-i", "l0.wav", "-i", "l1.wav"]);
    const f = filter(args);
    expect(f).toContain("[1:a]aresample=48000,aformat=channel_layouts=mono,adelay=1000[l0]");
    expect(f).toContain("[2:a]aresample=48000,aformat=channel_layouts=mono,adelay=5250[l1]");
    expect(f).toContain("[l0][l1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end=10,pan=stereo|c0=c0|c1=c0[voice]");
    expect(f).toContain("[0:a]aresample=48000,aformat=channel_layouts=stereo[orig]");
    expect(f).toContain("[orig][key]sidechaincompress=");
    expect(f).toContain("[bed][vo]amix=inputs=2");
    expect(args).toEqual(expect.arrayContaining(["-map", "0:v?", "-c:v", "copy", "-map", "[aout]", "-t", "10"]));
    expect(args.at(-1)).toBe("out.mp4");
    expect(args).toContain("+faststart");
  });

  it("mixes without ducking when duck is false", () => {
    const f = filter(buildNarrateArgs("in.mp4", wavs, "out.mp4", placed, 10, { hasAudio: true, duck: false }));
    expect(f).not.toContain("sidechaincompress");
    expect(f).toContain("[orig][voice]amix=inputs=2");
  });

  it("uses the voice bus as the only audio for a silent video, and skips amix for one line", () => {
    const f = filter(buildNarrateArgs("in.mp4", ["l0.wav"], "out.mkv", [placed[0]!], 8, { hasAudio: false }));
    expect(f).toBe("[1:a]aresample=48000,aformat=channel_layouts=mono,adelay=1000[l0];[l0]apad,atrim=end=8,pan=stereo|c0=c0|c1=c0[aout]");
  });

  it("keeps a mono original mono (no 3 dB upmix loss)", () => {
    const f = filter(buildNarrateArgs("in.mp4", wavs, "out.mp4", placed, 10, { hasAudio: true, channels: 1 }));
    expect(f).not.toContain("pan=");
    expect(f).toContain("[0:a]aresample=48000,aformat=channel_layouts=mono[orig]");
  });

  it("writes audio only for an audio output path", () => {
    const args = buildNarrateArgs("in.mp4", wavs, "out.wav", placed, 10, { hasAudio: true });
    expect(args).not.toContain("0:v?");
    expect(args).toEqual(expect.arrayContaining(["-c:a", "pcm_s16le"]));
  });

  it("rejects an unknown duration and mismatched inputs", () => {
    expect(() => buildNarrateArgs("in.mp4", wavs, "out.mp4", placed, 0, { hasAudio: true })).toThrow(/duration/);
    expect(() => buildNarrateArgs("in.mp4", ["l0.wav"], "out.mp4", placed, 10, { hasAudio: true })).toThrow(/WAV/);
  });
});
