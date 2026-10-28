import { describe, it, expect } from "vitest";
import { buildTranscribeArgs, mergePunctuation, parseSrt, normalizeCues } from "../utils/captions.js";
import { cueWords, findQuote, mapTime, mergeCuts, planTranscriptCuts, retimeCues } from "../utils/transcriptCut.js";

// Word-level whisper output, as ffmpeg 8.1's whisper filter wrote it with
// max_len=1 for Windows TTS speech: punctuation gets its own (often
// zero-length) cue.
const WORD_SRT = `0
00:00:01,500 --> 00:00:02,000
demo

1
00:00:02,000 --> 00:00:02,000
.

2
00:00:02,000 --> 00:00:03,000
Um

3
00:00:03,000 --> 00:00:03,000
.

4
00:00:03,271 --> 00:00:03,331
Today

5
00:00:03,331 --> 00:00:03,391
we

6
00:00:06,083 --> 00:00:06,153
uh

7
00:00:06,153 --> 00:00:06,693
,

8
00:00:06,693 --> 00:00:06,773
then
`;
const words = () => normalizeCues(mergePunctuation(parseSrt(WORD_SRT)));

const SENTENCES = [
  { start: 0, end: 2, text: "Hello and welcome." },
  { start: 2, end: 6, text: "So, um, today we open the settings page." },
  { start: 6, end: 7, text: "Uh." },
  { start: 7, end: 10, text: "Then we click save." },
];

describe("transcribe words (#173)", () => {
  it("asks whisper for one word per cue", () => {
    const af = (w: boolean) => {
      const a = buildTranscribeArgs("in.mp4", "m.bin", "o.srt", "en", w);
      return a[a.indexOf("-af") + 1];
    };
    expect(af(true)).toMatch(/:use_gpu=false:max_len=1$/);
    expect(af(false)).not.toMatch(/max_len/);
  });

  it("folds punctuation-only cues into the word before", () => {
    expect(words()).toEqual([
      { start: 1.5, end: 2, text: "demo." },
      { start: 2, end: 3, text: "Um." },
      { start: 3.271, end: 3.331, text: "Today" },
      { start: 3.331, end: 3.391, text: "we" },
      { start: 6.083, end: 6.153, text: "uh," },
      { start: 6.693, end: 6.773, text: "then" },
    ]);
  });
});

describe("cut_by_transcript (#173)", () => {
  it("spreads a cue's time over its words by character position", () => {
    const w = cueWords([{ start: 0, end: 10, text: "aaaa bbbb" }]);
    expect(w.map((x) => [x.norm, x.start, x.end, x.first, x.last])).toEqual([
      ["aaaa", 0, (4 / 9) * 10, true, false],
      ["bbbb", (5 / 9) * 10, 10, false, true],
    ]);
  });

  it("finds a quote across cues, ignoring case, punctuation and spacing", () => {
    const w = cueWords(words());
    expect(findQuote(w, "DEMO  um today")).toEqual([[0, 2]]);
    expect(findQuote(w, "settings")).toEqual([]);
  });

  it("cuts word-level quotes exactly, and whole cues by number", () => {
    const plan = planTranscriptCuts(words(), { remove: ["um, today", 6] });
    expect(plan.cuts).toEqual([
      { start: 2, end: 3.331, text: "Um. Today", exact: true },
      { start: 6.693, end: 6.773, text: "then", exact: true },
    ]);
  });

  it("estimates a quote inside a sentence cue and says so", () => {
    const [cut] = planTranscriptCuts(SENTENCES, { remove: ["today we open"] }).cuts;
    expect(cut?.exact).toBe(false);
    expect(cut!.start).toBeGreaterThan(2);
    expect(cut!.end).toBeLessThan(6);
    expect(cut?.text).toBe("today we open");
    // A whole sentence is exact.
    expect(planTranscriptCuts(SENTENCES, { remove: ["hello and welcome"] }).cuts[0]).toEqual({
      start: 0, end: 2, text: "Hello and welcome.", exact: true,
    });
  });

  it("cuts fillers that are their own cue and skips ones inside a sentence", () => {
    expect(planTranscriptCuts(SENTENCES, { fillers: true })).toEqual({
      cuts: [{ start: 6, end: 7, text: "Uh.", exact: true }],
      skippedFillers: 1,
    });
    // Word-level fillers take the pause around them, up to FILLER_REACH a side.
    expect(planTranscriptCuts(words(), { fillers: true }).cuts.map((c) => [c.start, c.end])).toEqual([
      [2, 3.271],
      [5.583, 6.653],
    ]);
  });

  it("rejects unknown cues, missing quotes and ambiguous quotes", () => {
    expect(() => planTranscriptCuts(SENTENCES, { remove: [5] })).toThrow(/No cue 5/);
    expect(() => planTranscriptCuts(SENTENCES, { remove: ["goodbye"] })).toThrow(/not found/);
    expect(() => planTranscriptCuts(SENTENCES, { remove: ["we"] })).toThrow(/occurs 2 times/);
    expect(() => planTranscriptCuts(SENTENCES, { remove: ["..."] })).toThrow(/no words/);
  });

  it("merges overlapping and touching cuts", () => {
    const c = (start: number, end: number) => ({ start, end, text: `${start}`, exact: true });
    expect(mergeCuts([c(5, 6), c(1, 2), c(2.005, 3), c(1.5, 1.8)]).map((x) => [x.start, x.end])).toEqual([
      [1, 3],
      [5, 6],
    ]);
  });

  it("maps source times onto the cut timeline", () => {
    const cuts = [{ start: 2, end: 3 }, { start: 6, end: 7 }];
    expect([0, 2, 2.5, 3, 5, 6.5, 8].map((t) => mapTime(t, cuts))).toEqual([0, 2, 2, 2, 4, 5, 6]);
  });

  it("re-times the transcript: cut cues go, cut words leave their cue, the rest shift back", () => {
    const plan = planTranscriptCuts(SENTENCES, { remove: [1, "today we open"], fillers: true });
    const out = retimeCues(SENTENCES, plan.cuts);
    expect(out.map((c) => c.text)).toEqual(["So, um, the settings page.", "Then we click save."]);
    expect(out[0]?.start).toBe(0);
    const cutLen = plan.cuts.reduce((s, c) => s + c.end - c.start, 0);
    expect(out[1]?.start).toBeCloseTo(7 - cutLen, 3);
    expect(out[1]?.end).toBeCloseTo(10 - cutLen, 3);
  });
});
