import { describe, it, expect } from "vitest";
import {
  parseOcrPass,
  mergePasses,
  normalizeForMatch,
  findMatches,
  regexRanges,
  MAX_QUERY_LENGTH,
  redactionRects,
  passScales,
  type OcrLine,
} from "../utils/ocr.js";

const word = (text: string, x: number, y = 0, width = text.length * 10, height = 12) => ({ text, x, y, width, height });
function line(words: ReturnType<typeof word>[]): OcrLine {
  const x0 = Math.min(...words.map((w) => w.x));
  const x1 = Math.max(...words.map((w) => w.x + w.width));
  return { text: words.map((w) => w.text).join(" "), words, x: x0, y: words[0].y, width: x1 - x0, height: 12 };
}

describe("OCR helpers (#117)", () => {
  it("parses a pass and divides out the upscale", () => {
    const lines = parseOcrPass({ lines: [{ text: "Deploy now", words: [{ text: "Deploy", x: 20, y: 40, width: 120, height: 24 }, { text: "now", x: 150, y: 40, width: 60, height: 24 }] }] }, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0].words[0]).toEqual({ text: "Deploy", x: 10, y: 20, width: 60, height: 12 });
    expect(lines[0]).toMatchObject({ text: "Deploy now", x: 10, y: 20, width: 95, height: 12 });
  });

  it("accepts PowerShell's single-object (non-array) words and empty passes", () => {
    const lines = parseOcrPass({ lines: [{ text: "OK", words: { text: "OK", x: 0, y: 0, width: 10, height: 10 } }] }, 1);
    expect(lines[0].words).toHaveLength(1);
    expect(parseOcrPass({}, 1)).toEqual([]);
  });

  it("explains a missing OCR language, and surfaces other failures", () => {
    expect(() => parseOcrPass({ error: "No OCR recognizer language is installed." }, 1)).toThrow(/Windows OCR is unavailable/);
    expect(() => parseOcrPass({ error: "boom" }, 1)).toThrow(/OCR failed: boom/);
  });

  it("merges passes: adds lines only the later pass found, keeps the longer reading of a shared line", () => {
    const shared2x = line([word("Settings", 10, 0)]);
    const shared4x = line([word("Settings", 10, 0), word(">", 100, 0)]);
    const only4x = line([word("OPENAI-APl-KEY=sk", 10, 30)]);
    const merged = mergePasses([[shared2x], [shared4x, only4x]]);
    expect(merged.map((l) => l.text)).toEqual(["Settings >", "OPENAI-APl-KEY=sk"]);
  });

  it("normalizes the engine's usual confusions", () => {
    expect(normalizeForMatch("OPENAI_API_KEY")).toBe(normalizeForMatch("OPENAI-APl-KEY"));
    expect(normalizeForMatch("t0ken")).toBe(normalizeForMatch("TOKEN"));
  });

  it("finds a plain query through misreads, boxed around the words it spans", () => {
    const lines = [line([word("export", 0), word("OPENAI-APl-KEY=sk-proj-1", 70)])];
    const m = findMatches(lines, "openai_api_key");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ text: "OPENAI-APl-KEY=sk-proj-1", x: 70 });
  });

  it("finds a phrase across words and every occurrence in a line", () => {
    const lines = [line([word("Save", 0), word("and", 50), word("close", 90), word("Save", 150)])];
    expect(findMatches(lines, "and close").map((m) => [m.text, m.x])).toEqual([["and close", 50]]);
    expect(findMatches(lines, "save").map((m) => m.x)).toEqual([0, 150]);
  });

  it("supports regex queries and rejects invalid ones", () => {
    const lines = [line([word("ghp_abc", 0), word("and", 80), word("sk-xyz", 120)])];
    expect(findMatches(lines, "sk-|ghp_", true).map((m) => m.text)).toEqual(["ghp_abc", "sk-xyz"]);
    expect(() => findMatches(lines, "(", true)).toThrow(/Invalid regex/);
  });

  it("matches the documented secret pattern through _ / - misreads (#236)", () => {
    const lines = [line([word("token:", 0), word("ghp-AbC123xyz", 60), word("sk_live", 200)])];
    const hits = findMatches(lines, "sk-|ghp_|api.?key", true);
    expect(hits.map((m) => m.text)).toEqual(["ghp-AbC123xyz", "sk_live"]);
    // A match found in several variants is reported once.
    expect(findMatches([line([word("sk-abc", 0)])], "sk-", true)).toHaveLength(1);
  });

  it("stops a catastrophic regex within its time budget and caps the query length (#185)", () => {
    const started = Date.now();
    expect(() => regexRanges(["a".repeat(40) + "!"], "(a+)+$", 200)).toThrow(/took longer than 0\.2 s/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(() => findMatches([line([word("x", 0)])], "x".repeat(MAX_QUERY_LENGTH + 1))).toThrow(/at most 500/);
    expect(regexRanges(["ghp-1 x", "none"], "ghp_")).toEqual([[[0, 4]], []]);
  });

  it("pads redaction rectangles and clamps them to the frame", () => {
    expect(redactionRects([{ x: 2, y: 5, width: 50, height: 10 }], { width: 54, height: 100 })).toEqual([
      { x: 0, y: 1, width: 54, height: 18 },
    ]);
  });

  it("caps upscales to the engine's 10,000 px limit", () => {
    expect(passScales(1920, 1080)).toEqual([2, 4]);
    expect(passScales(3840, 1080)).toEqual([2, 2.6]);
    expect(passScales(9000, 500)).toEqual([1.11]);
  });
});
