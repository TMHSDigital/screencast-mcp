/**
 * Pipeline polish ops and recipes (#244): cut_idle, audio, burn_subtitles,
 * zoom follow:"clicks", the timeline helpers that re-time everything through
 * a cut, and recipe expansion.
 */
import { describe, it, expect } from "vitest";
import { planPipeline, probeArgs, type PipelineStep } from "../utils/pipeline.js";
import { cutShift, mapTime, mapWindow, mapSpans, retimeCues, retimeAss } from "../utils/timeline.js";
import { retimeMarkers, type TimeOp } from "../utils/chapters.js";
import { retimeBadges } from "../utils/keystrokes.js";
import { applyOverrides, recipeSteps, PR_DEMO_MAX_BYTES } from "../utils/recipes.js";
import { buildLoudnessMeasureArgs, loudnessTarget } from "../utils/audio.js";

const SRC = { width: 320, height: 240, fps: 30, durationSec: 20, hasAudio: true };
const fc = (args: string[]) => args[args.indexOf("-filter_complex") + 1] ?? "";

describe("timeline helpers", () => {
  const cut: TimeOp = { op: "cut", spans: [{ start: 2, end: 5 }, { start: 10, end: 12 }] };
  it("closes up removed spans; a time inside one lands where it was", () => {
    expect(cutShift(1, cut.op === "cut" ? cut.spans : [])).toBe(0);
    expect(mapTime(1, [cut])).toBe(1);
    expect(mapTime(3, [cut])).toBe(2);
    expect(mapTime(8, [cut])).toBe(5);
    expect(mapTime(15, [cut])).toBe(10);
  });
  it("composes with trims and speed changes, in order", () => {
    const ops: TimeOp[] = [{ op: "trim", start: 1, end: 19 }, cut, { op: "speed", factor: 2 }];
    expect(mapTime(0.5, ops)).toBeNull();
    expect(mapTime(9, ops)).toBe(2.5); // 9 -> 8 -> 5 (3 s cut before) -> 2.5
    expect(mapWindow(2.5, 4, [cut])).toBeNull(); // wholly inside a cut
    expect(mapSpans([{ start: 4, end: 9 }], [cut])).toEqual([{ start: 2, end: 6 }]);
  });
  it("re-times markers, badges, SRT cues and ASS dialogue through a cut", () => {
    expect(retimeMarkers([{ t: 3, label: "a" }, { t: 13, label: "b" }], [cut]).map((m) => m.t)).toEqual([2, 8]);
    expect(retimeBadges([{ from: 6, to: 7, label: "Ctrl+S", kind: "shortcut" }] as never, [cut])).toMatchObject([{ from: 3, to: 4 }]);
    expect(retimeCues([{ start: 6, end: 8, text: "hi" }, { start: 3, end: 4, text: "gone" }], [cut])).toEqual([{ start: 3, end: 5, text: "hi" }]);
    const ass = "[Events]\nDialogue: 0,0:00:06.00,0:00:08.00,Default,,0,0,0,,hi\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,gone";
    expect(retimeAss(ass, [cut])).toBe("[Events]\nDialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,hi");
  });
});

describe("pipeline cut_idle (#244)", () => {
  it("cuts the scanned idle stretches, shortens the timeline and records a cut timeOp", () => {
    const plan = planPipeline("in.mp4", "out.mp4", [{ op: "cut_idle" }], SRC, {}, "standard", {
      idle: [{ start: 4, end: 9 }, { start: 15, end: 16 }], // the second is under minIdleSec
    });
    expect(fc(plan.args)).toContain("select='not(between(t,4.4,8.6))'");
    expect(fc(plan.args)).toContain("setpts='(T-(clip(T-4.4,0,4.2)))/TB'");
    expect(fc(plan.args)).toContain("[0:a]asetnsamples=n=256:p=0,aselect=");
    expect(plan.durationSec).toBe(15.8);
    expect(plan.timeOps).toEqual([{ op: "cut", spans: [{ start: 4.4, end: 8.6 }] }]);
  });
  it("maps idle found on the source through an earlier trim and speed change", () => {
    const steps: PipelineStep[] = [{ op: "trim", start: 2, end: 20 }, { op: "speed", factor: 2 }, { op: "cut_idle", minIdleSec: 1, keepSec: 0 }];
    const plan = planPipeline("in.mp4", "out.mp4", steps, SRC, {}, "standard", { idle: [{ start: 6, end: 10 }] });
    expect(plan.timeOps.at(-1)).toEqual({ op: "cut", spans: [{ start: 2, end: 4 }] });
    expect(plan.durationSec).toBe(7);
  });
  it("re-times keystroke badges after the cut", () => {
    const steps: PipelineStep[] = [{ op: "cut_idle", keepSec: 0 }, { op: "keystroke_overlay" }];
    const badges = [{ from: 10, to: 11, label: "Ctrl+S", kind: "shortcut" }] as never;
    const plan = planPipeline("in.mp4", "out.mp4", steps, SRC, {}, "standard", {
      idle: [{ start: 2, end: 6 }],
      keystrokes: { 1: { badges, fontFile: "f.ttf", textFiles: { "Ctrl+S": "t.txt" } } },
    });
    expect(fc(plan.args)).toMatch(/between\(t,6,7\)/);
  });
  it("allows one cut_idle, and notes when nothing is idle", () => {
    expect(() => planPipeline("in.mp4", "o.mp4", [{ op: "cut_idle" }, { op: "cut_idle" }], SRC, {}, "standard", { idle: [] })).toThrow(/at most one/);
    const plan = planPipeline("in.mp4", "o.mp4", [{ op: "cut_idle" }], SRC, {}, "standard", { idle: [] });
    expect(plan.summary[0]).toMatch(/nothing cut/);
    expect(plan.durationSec).toBe(20);
  });
});

describe("pipeline audio and burn_subtitles (#244)", () => {
  it("asks for probes in step order, then plans with their results", () => {
    const steps: PipelineStep[] = [{ op: "speed", factor: 2 }, { op: "audio", denoise: "light", normalize: "podcast" }];
    const first = planPipeline("in.mp4", "o.mp4", steps, SRC);
    expect(first.pending.map((p) => p.kind)).toEqual(["noisefloor", "loudness"]);
    expect(first.pending[0]?.audio).toEqual(["atempo=2"]);
    const loud = { input_i: -30, input_tp: -10, input_lra: 5, input_thresh: -40, target_offset: 0.2 };
    const done = planPipeline("in.mp4", "o.mp4", steps, SRC, {}, "standard", { audio: { 1: { floorDb: -60, loudness: loud } } });
    expect(done.pending).toEqual([]);
    expect(fc(done.args)).toContain("afftdn=nr=6:nf=-55,loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-30");
    expect(fc(done.args)).toContain("linear=true,aresample=48000[aout]");
  });
  it("filters audio even when no step touches the picture, and skips a silent source", () => {
    const plan = planPipeline("in.mp4", "o.mp4", [{ op: "audio", normalize: "youtube" }], SRC);
    expect(fc(plan.args)).toMatch(/^\[0:a\]loudnorm=I=-14/);
    expect(plan.args).toContain("0:v");
    expect(plan.args).toContain("[aout]");
    const mute = planPipeline("in.mp4", "o.mp4", [{ op: "audio", normalize: "youtube" }], { ...SRC, hasAudio: false });
    expect(mute.summary[0]).toMatch(/no audio; skipped/);
    const silent = planPipeline("in.mp4", "o.mp4", [{ op: "audio", normalize: "youtube" }], SRC, {}, "standard", { audio: { 0: { silent: true } } });
    expect(silent.pending).toEqual([]);
    expect(silent.args).not.toContain("-filter_complex");
  });
  it("builds probe args that hear the audio as it reaches the step", () => {
    const steps: PipelineStep[] = [{ op: "trim", start: 3, end: 9 }, { op: "cut_idle" }, { op: "audio", normalize: "youtube" }];
    const plan = planPipeline("in.mp4", "o.mp4", steps, SRC, {}, "standard", { idle: [{ start: 4, end: 8 }] });
    const p = plan.pending[0]!;
    const args = probeArgs(buildLoudnessMeasureArgs("in.mp4", loudnessTarget("youtube")), p);
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-i") + 2)).toEqual(["-ss", "3", "-t", "6", "-i", "in.mp4"]);
    expect(args[args.indexOf("-af") + 1]).toMatch(/^asetnsamples=n=256:p=0,aselect=.*,asetpts=N\/SR\/TB,loudnorm=I=-14/);
  });
  it("burns subtitles from a prepared file, keeps .ass styling, and skips an empty transcript", () => {
    const plan = planPipeline("in.mp4", "o.mp4", [{ op: "burn_subtitles", transcribe: true, style: "social" }], SRC);
    expect(plan.pending[0]?.kind).toBe("transcribe");
    const done = planPipeline("in.mp4", "o.mp4", [{ op: "burn_subtitles", subtitles: "a.ass" }], SRC, {}, "standard", {
      subtitles: { 0: "s0.ass" },
      fontsDir: "fonts",
    });
    expect(fc(done.args)).toContain("subtitles=filename=s0.ass:fontsdir=fonts[p0]");
    const empty = planPipeline("in.mp4", "o.mp4", [{ op: "burn_subtitles", transcribe: true }], SRC, {}, "standard", { subtitles: { 0: "" } });
    expect(empty.summary[0]).toMatch(/skipped/);
    expect(() => planPipeline("in.mp4", "o.mp4", [{ op: "burn_subtitles" }], SRC)).toThrow(/subtitles \(a path\) or transcribe/);
    expect(() => planPipeline("in.mp4", "o.mp4", [{ op: "burn_subtitles", transcribe: true }], { ...SRC, hasAudio: false })).toThrow(/needs audio/);
  });
});

describe("pipeline zoom follow clicks (#244)", () => {
  const clicks = { 2: [{ t: 10, x: 200, y: 100 }, { t: 1, x: 5, y: 5 }] };
  it("moves logged clicks through earlier crops, scales and cuts before planning", () => {
    const steps: PipelineStep[] = [{ op: "crop", x: 100, y: 50, width: 200, height: 150 }, { op: "cut_idle", keepSec: 0 }, { op: "zoom", follow: "clicks" }];
    const plan = planPipeline("in.mp4", "o.mp4", steps, SRC, {}, "standard", { idle: [{ start: 3, end: 7 }], clicks });
    // (200,100) -> (100,50) in the crop; t 10 -> 6 after the 4 s cut; the click at (5,5) is cropped away.
    expect(plan.summary.at(-1)).toBe("zoom 2 keyframe(s) from 1 click(s)");
    expect(fc(plan.args)).toMatch(/zoompan/);
  });
  it("refuses clicks after a reframe, and skips when no click falls in the video", () => {
    expect(() =>
      planPipeline("in.mp4", "o.mp4", [{ op: "reframe", aspect: "1:1" }, { op: "scale", width: 100 }, { op: "zoom", follow: "clicks" }], SRC, {}, "standard", { clicks }),
    ).toThrow(/before reframe/);
    const plan = planPipeline("in.mp4", "o.mp4", [{ op: "trim", start: 15, end: 20 }, { op: "scale", width: 160 }, { op: "zoom", follow: "clicks" }], SRC, {}, "standard", { clicks });
    expect(plan.summary.at(-1)).toMatch(/no clicks.*skipped/);
    expect(() => planPipeline("in.mp4", "o.mp4", [{ op: "zoom" }], SRC)).toThrow(/needs keyframes/);
  });
});

describe("recipes (#244)", () => {
  const full = { hasAudio: true, hasClicks: true, transcribeBlocker: null };
  it("expands each recipe to pipeline steps", () => {
    expect(recipeSteps("pr_demo", full).steps).toEqual([
      { op: "cut_idle" },
      { op: "zoom", follow: "clicks" },
      { op: "export_gif", maxBytes: PR_DEMO_MAX_BYTES },
    ]);
    expect(recipeSteps("tutorial", full).steps.map((s) => s.op)).toEqual(["cut_idle", "zoom", "audio", "burn_subtitles", "export_preset"]);
    expect(recipeSteps("social_reel", full).steps.map((s) => s.op)).toEqual(["cut_idle", "zoom", "audio", "reframe", "burn_subtitles", "export_preset"]);
  });
  it("leaves out what the input cannot support, with a note", () => {
    const r = recipeSteps("tutorial", { hasAudio: true, hasClicks: false, transcribeBlocker: "no whisper model." });
    expect(r.steps.map((s) => s.op)).toEqual(["cut_idle", "audio", "export_preset"]);
    expect(r.notes.join(" ")).toMatch(/zoom left out.*captions left out: no whisper model/);
    expect(recipeSteps("tutorial", { hasAudio: false, hasClicks: true, transcribeBlocker: null }).steps.map((s) => s.op)).toEqual(["cut_idle", "zoom", "export_preset"]);
  });
  it("lets caller steps replace same-op steps and the export, putting a trim first and the rest before the export", () => {
    const base = recipeSteps("tutorial", full).steps;
    const out = applyOverrides(base, [
      { op: "cut_idle", minIdleSec: 4 },
      { op: "trim", start: 1, end: 9 },
      { op: "export_gif", maxBytes: 5_000_000 },
    ]);
    expect(out[0]).toEqual({ op: "trim", start: 1, end: 9 });
    expect(out[1]).toEqual({ op: "cut_idle", minIdleSec: 4 });
    expect(out.at(-1)).toEqual({ op: "export_gif", maxBytes: 5_000_000 });
    expect(applyOverrides(base, [{ op: "scale", width: 640 }]).at(-2)).toEqual({ op: "scale", width: 640 });
    expect(out).toHaveLength(base.length + 1);
  });
});
