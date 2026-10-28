import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWhisperModel,
  buildTranscribeArgs,
  parseSrt,
  normalizeCues,
  formatSrt,
  buildBurnSubtitlesArgs,
  WHISPER_MODEL_ENV,
} from "../utils/captions.js";

// What whisper.cpp actually wrote in testing: 0-based and overlapping.
const WHISPER_SRT = `0
00:00:00,000 --> 00:00:03,040
Open the Settings page. Then click the same

1
00:00:02,971 --> 00:00:04,651
button to finish the deployment.
`;

describe("captions (#120)", () => {
  it("parses SRT (CRLF, 0-based, multi-line text)", () => {
    const cues = parseSrt(WHISPER_SRT.replace(/\n/g, "\r\n") + "\r\n2\r\n00:01:00.500 --> 00:01:02,000\r\nline one\r\nline two\r\n");
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 0, end: 3.04, text: "Open the Settings page. Then click the same" });
    expect(cues[2]).toEqual({ start: 60.5, end: 62, text: "line one\nline two" });
  });

  it("renumbers from 1 and removes overlaps", () => {
    const srt = formatSrt(normalizeCues(parseSrt(WHISPER_SRT)));
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:02,971\nOpen the Settings page. Then click the same\n\n" +
        "2\n00:00:02,971 --> 00:00:04,651\nbutton to finish the deployment.\n",
    );
  });

  it("drops cues that end up empty and sorts out-of-order ones", () => {
    const cues = normalizeCues([
      { start: 5, end: 6, text: "b" },
      { start: 1, end: 2, text: "a" },
      { start: 5, end: 7, text: "c" },
    ]);
    expect(cues.map((c) => c.text)).toEqual(["a", "c"]);
  });

  it("formats hours and milliseconds", () => {
    expect(formatSrt([{ start: 3725.5, end: 3726.25, text: "x" }])).toContain("01:02:05,500 --> 01:02:06,250");
  });

  it("finds the model from the argument or the env var, and explains a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-whisper-"));
    try {
      const model = join(dir, "ggml-tiny.en.bin");
      writeFileSync(model, "x");
      expect(resolveWhisperModel(model, {})).toBe(model);
      expect(resolveWhisperModel(undefined, { [WHISPER_MODEL_ENV]: model })).toBe(model);
      expect(() => resolveWhisperModel(undefined, {})).toThrow(/No whisper model/);
      expect(() => resolveWhisperModel(join(dir, "nope.bin"), {})).toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds the whisper transcription filter with escaped paths", () => {
    const a = buildTranscribeArgs("in.mp4", "C:\\m\\ggml.bin", "C:\\t\\o.srt", "en");
    expect(a[a.indexOf("-af") + 1]).toBe(
      "aresample=16000,whisper=model=C\\\\:/m/ggml.bin:language=en:format=srt:destination=C\\\\:/t/o.srt:use_gpu=false",
    );
    expect(() => buildTranscribeArgs("in.mp4", "m", "o", "english; rm")).toThrow(/language/);
  });

  it("burns subtitles with the bundled fonts and a style", () => {
    const a = buildBurnSubtitlesArgs("in.mp4", "C:\\s\\a.srt", "o.mp4", "C:\\fonts", "social");
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf.startsWith("subtitles=filename=C\\\\:/s/a.srt:fontsdir=C\\\\:/fonts:force_style='FontName=Inter,Bold=1")).toBe(true);
    expect(vf).toContain("BorderStyle=3");
    expect(() => buildBurnSubtitlesArgs("i", "s", "o", "f", "neon" as never)).toThrow(/Unknown caption style/);
    // A null style keeps an .ass file's own styling (#189).
    const ass = buildBurnSubtitlesArgs("in.mp4", "a.ass", "o.mp4", "f", null);
    expect(ass[ass.indexOf("-vf") + 1]).not.toContain("force_style");
  });
});
