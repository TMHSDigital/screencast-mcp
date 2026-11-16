/** start_recording's pure parts (#307): option checks, the consent prompt,
 * the session record per backend, and the result. */
import { describe, it, expect } from "vitest";
import { buildSessionRecord, checkStartChoices, consentPrompt, startResult, type RecordFacts } from "../utils/startPlan.js";

const base = { backend: "gdigrab" as const, systemAudio: false, replay: false, webcam: false, logs: false, perf: false };
const facts = { windowHwnd: true, wgcAvailable: true };

describe("checkStartChoices (#307)", () => {
  it("accepts what works and names what does not", () => {
    expect(() => checkStartChoices(base, facts)).not.toThrow();
    expect(() => checkStartChoices({ ...base, backend: "wgc" }, { ...facts, windowHwnd: false })).toThrow(/one window/);
    expect(() => checkStartChoices({ ...base, backend: "wgc", systemAudio: true }, facts)).toThrow(/Audio is not supported/);
    expect(() => checkStartChoices({ ...base, backend: "wgc" }, { ...facts, wgcAvailable: false })).toThrow(/FFmpeg 8/);
    expect(() => checkStartChoices({ ...base, backend: "wgc", replay: true }, facts)).toThrow(/replayBufferSec/);
    expect(() => checkStartChoices({ ...base, replay: true, webcam: true }, facts)).toThrow(/webcam works with/);
    expect(() => checkStartChoices({ ...base, replay: true, logs: true }, facts)).toThrow(/logs and perf/);
    expect(() => checkStartChoices({ ...base, backend: "ddagrab", webcam: true }, facts)).not.toThrow();
  });
});

describe("consentPrompt (#307)", () => {
  it("says what is captured, logged, and kept", () => {
    expect(consentPrompt({ target: "region:0,0,640,480", maxDurationSec: 60, events: true, output: "C:/r.mp4" })).toBe(
      "Record region:0,0,640,480 for up to 60 s, without audio, logging mouse clicks and typing, saved to C:/r.mp4?",
    );
    const replay = consentPrompt({
      target: 'window "App"',
      replayBufferSec: 30,
      maxDurationSec: 0,
      audioDevice: "Stereo Mix",
      webcamDevice: "Cam",
      events: true,
      focus: "title",
      elements: true,
      hotkeys: true,
      output: "x",
    });
    expect(replay).toMatch(/^Keep a rolling 30 s replay buffer of window "App" with no time limit, with system audio \(Stereo Mix\), with the webcam \(Cam\)/);
    expect(replay).toMatch(/with its title, naming the on-screen controls you click, with hotkeys \(Ctrl\+Alt\+Shift\+M marks/);
    expect(replay).toMatch(/kept only until save_replay/);
  });
});

const facts0: RecordFacts = {
  id: "rec-1",
  target: "full",
  output: "C:/rec/r.mp4",
  fps: 15,
  quality: "standard",
  pid: 42,
  spawnedAt: 1000,
  startMs: 1100,
  maxDurationSec: 3600,
  backend: "gdigrab",
  encoder: "x264",
  capture: { target: { kind: "full" }, opts: { fps: 15 } },
  processImage: "ffmpeg.exe",
  identity: { serverPid: 7, serverStartedAt: "s", serverImage: "node.exe" },
  now: new Date("2026-11-16T00:00:00Z"),
};

describe("buildSessionRecord (#307)", () => {
  it("records an ffmpeg capture with segments for pause/resume", () => {
    const r = buildSessionRecord({ ...facts0, events: { jsonl: "r.events.jsonl", raw: "r.events.raw", keys: "masked", frame: { x: 0, y: 0, w: 10, h: 10 } } });
    expect(r).toMatchObject({
      id: "rec-1",
      status: "recording",
      startedAt: "2026-11-16T00:00:00.000Z",
      videoStartMs: 1100,
      maxDurationSec: 3600,
      events: { path: "r.events.jsonl", keys: "masked" },
      segments: { parts: [], current: { path: "C:/rec/r.mp4", startMs: 1100 } },
      serverPid: 7,
    });
    expect(r.encoder).toBeUndefined();
    expect(r.replay).toBeUndefined();
  });

  it("keeps wgc and replay sessions out of segments, and puts replay events in the buffer", () => {
    const wgc = buildSessionRecord({ ...facts0, backend: "wgc", encoder: "nvenc", processImage: "node.exe" });
    expect(wgc.segments).toBeUndefined();
    expect(wgc.capture).toBeUndefined();
    expect(wgc.encoder).toBe("nvenc");
    const replay = { dir: "C:/replay/buf", bufferSec: 30, segmentSec: 2, wrap: 17 };
    const r = buildSessionRecord({ ...facts0, maxDurationSec: 0, replay, events: { jsonl: "", raw: "C:/replay/buf/events.raw", keys: "shortcuts", frame: { x: 0, y: 0, w: 10, h: 10 } } });
    expect(r.segments).toBeUndefined();
    expect(r.events).toBeUndefined();
    expect(r.maxDurationSec).toBeUndefined();
    expect(r.replay).toMatchObject({ dir: "C:/replay/buf", events: { raw: "C:/replay/buf/events.raw", keys: "shortcuts", startMs: 1100 } });
  });

  it("records the webcam with its part and placement", () => {
    const r = buildSessionRecord({ ...facts0, webcam: { device: "Cam", rawPath: "C:/rec/r.mp4.parts/cam0.mp4", startMs: 1150, corner: "top_left" } });
    expect(r.segments?.current).toMatchObject({ webcamPath: "C:/rec/r.mp4.parts/cam0.mp4", webcamStartMs: 1150 });
    expect(r.webcam).toMatchObject({ device: "Cam", corner: "top_left", shape: "rect" });
  });
});

describe("startResult (#307)", () => {
  it("reports the session, optional parts, and the next step", () => {
    const record = buildSessionRecord(facts0);
    const out = startResult({ record, maxDurationSec: 3600, encoder: "x264", hotkeys: { taken: ["stop"] }, logs: { path: "r.logs.jsonl", missing: true } });
    expect(out).toMatchObject({ sessionId: "rec-1", status: "recording", backend: "gdigrab", audioDevice: null, maxDurationSec: 3600, logsPath: "r.logs.jsonl" });
    expect(String(out.logsNote)).toMatch(/does not exist yet/);
    expect(out.hotkeys).toMatchObject({ unavailable: ["stop"], warning: "Another app holds Ctrl+Alt+Shift+S." });
    expect(String(out.note)).toMatch(/stop_recording .* It stops on its own after 3600s/);
    const replay = startResult({ record, maxDurationSec: 0, encoder: "x264", replay: { bufferSec: 30, segmentSec: 2, dir: "d", events: false } });
    expect(String(replay.note)).toMatch(/^Replay buffer running/);
  });
});
