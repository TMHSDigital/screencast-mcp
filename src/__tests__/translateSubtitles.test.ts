/** Multi-language subtitles (#339): translations keep each cue's timing, and
 * the mux tags and orders tracks. Pure. */
import { describe, it, expect } from "vitest";
import { applyTranslations, translatedSrtPath, type Cue } from "../utils/captions.js";
import { buildChaptersMuxArgs, MAX_SUBTITLE_TRACKS } from "../utils/chapters.js";

const cues: Cue[] = [
  { start: 0, end: 1.5, text: "Hello" },
  { start: 2, end: 4, text: "Click Save\nto finish" },
];

describe("translate_subtitles (#339)", () => {
  it("keeps every cue's timing and its line breaks", () => {
    const out = applyTranslations(cues, ["Hola", "Haz clic en Guardar\npara terminar"]);
    expect(out).toEqual([
      { start: 0, end: 1.5, text: "Hola" },
      { start: 2, end: 4, text: "Haz clic en Guardar\npara terminar" },
    ]);
    // A blank line inside a translation would end the SRT cue early.
    expect(applyTranslations([cues[0]!], ["a\n\nb"])[0]?.text).toBe("a\nb");
  });

  it("rejects a count mismatch or an empty translation", () => {
    expect(() => applyTranslations(cues, ["Hola"])).toThrow(/1 translations for 2 cues/);
    expect(() => applyTranslations(cues, ["Hola", "  "])).toThrow(/Translation 2 is empty/);
  });

  it("names the output after the language", () => {
    expect(translatedSrtPath("C:/x/talk.srt", "spa")).toBe("C:/x/talk.spa.srt");
    expect(translatedSrtPath("talk.eng.SRT", "deu")).toBe("talk.eng.deu.srt");
  });

  it("muxes several tracks with language, title and default", () => {
    const args = buildChaptersMuxArgs("in.mp4", "m.txt", "out.mp4", {
      container: ".mp4",
      subtitles: [{ file: "a.srt", language: "eng", title: "English", default: true }, { file: "b.srt", language: "spa" }],
    });
    const s = args.join(" ");
    expect(s).toContain("-i a.srt -i b.srt -map 0:v -map 0:a? -map 2:s:0 -map 3:s:0");
    expect(s).toContain("-metadata:s:s:0 language=eng -metadata:s:s:0 title=English -disposition:s:0 default");
    expect(s).toContain("-metadata:s:s:1 language=spa -disposition:s:1 0");
    const many = Array.from({ length: MAX_SUBTITLE_TRACKS + 1 }, (_, i) => ({ file: `${i}.srt` }));
    expect(() => buildChaptersMuxArgs("in.mp4", "m", "o.mp4", { container: ".mp4", subtitles: many })).toThrow(/At most/);
  });
});
