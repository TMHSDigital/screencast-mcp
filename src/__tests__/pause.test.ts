import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  buildWebcamAlignArgs,
  clockSpans,
  endSession,
  eventClock,
  partPath,
  partsDir,
  pauseBlocker,
  recordedSec,
  remainingCapSec,
  resumeBlocker,
  sessionEnded,
  webcamOutputPath,
  webcamPartPath,
  webcamPlacement,
  type SegmentState,
} from "../utils/pause.js";
import { convertEvents, parseCaptureStart, videoTimeSec } from "../utils/events.js";
import { buildCaptureArgs, buildWebcamInputArgs } from "../utils/targets.js";
import { classifyOrphan, isForeignLiveRecording, isLive, pruneRecords, type SessionRecord } from "../utils/sessions.js";
import { parseDshowAudioDevices, parseDshowVideoDevices } from "../utils/audioDevices.js";
import { buildOverlayArgs } from "../utils/media.js";

const base: SessionRecord = {
  id: "rec-1",
  target: "region:0,0,640,480",
  outputPath: "C:/rec/a.mp4",
  fps: 30,
  quality: "standard",
  pid: 1,
  status: "recording",
  startedAt: "2026-01-01T00:00:00.000Z",
  backend: "gdigrab",
  capture: { target: { kind: "region", x: 0, y: 0, w: 640, h: 480 }, opts: { fps: 30 } },
  segments: { parts: [], current: { path: "C:/rec/a.mp4", startMs: 1000 } },
};

describe("segment paths (#200)", () => {
  it("writes the first segment at the output, later ones beside it", () => {
    expect(partPath("C:/rec/a.mp4", 0)).toBe("C:/rec/a.mp4");
    expect(partPath("C:/rec/a.mp4", 2)).toBe(join("C:/rec/a.mp4.parts", "part-002.mp4"));
    expect(partsDir("C:/rec/a.mp4")).toBe("C:/rec/a.mp4.parts");
    expect(webcamPartPath("C:/rec/a.mp4", 0)).toBe(join("C:/rec/a.mp4.parts", "webcam-000.mp4"));
    expect(webcamOutputPath("C:/rec/a.mp4")).toBe(join("C:/rec", "a.webcam.mp4"));
  });
});

describe("the video clock across pauses (#200)", () => {
  // Recorded 0-4 s of wall time 1000..5000, paused 5000..9000, resumed at 9000.
  const state: SegmentState = {
    parts: [{ path: "a", startMs: 1000, durationSec: 4 }],
    current: { path: "b", startMs: 9000 },
  };

  it("places each segment after the ones before it", () => {
    expect(clockSpans(state)).toEqual([
      { startMs: 1000, offsetSec: 0, durationSec: 4 },
      { startMs: 9000, offsetSec: 4 },
    ]);
    expect(recordedSec(state.parts)).toBe(4);
  });

  it("maps epoch times to video time and drops the paused stretch", () => {
    const spans = clockSpans(state);
    expect(videoTimeSec(3000, spans)).toBe(2);
    expect(videoTimeSec(7000, spans)).toBeNull();
    expect(videoTimeSec(10_500, spans)).toBe(5.5);
    expect(videoTimeSec(500, spans)).toBe(-0.5);
  });

  it("converts the event log with the pause cut out", () => {
    const raw = ["3000,move,10,10", "7000,move,20,20", "7000,down,20,20,left", "10500,move,30,30"].join("\n");
    const clock = eventClock(state, 0, 12_000);
    expect(clock).toMatchObject({ startMs: 1000, endSec: 7 });
    const events = convertEvents(raw, { ...clock, frame: { x: 0, y: 0, w: 640, h: 480 } });
    expect(events.map((e) => [e.t, e.type])).toEqual([[2, "move"], [5.5, "move"]]);
  });

  it("keeps the old clock for a recording that never paused", () => {
    expect(eventClock(undefined, 1000, 3000)).toEqual({ startMs: 1000, endSec: 2 });
  });

  it("leaves what the cap allows for the next segment", () => {
    expect(remainingCapSec(0, 100)).toBe(0);
    expect(remainingCapSec(60, 20.4)).toBe(39);
    expect(() => remainingCapSec(60, 59.5)).toThrow(/maxDurationSec/);
  });
});

describe("pause/resume state machine (#200)", () => {
  it("pauses only an ffmpeg capture this server runs", () => {
    expect(pauseBlocker(base, true)).toBeNull();
    expect(pauseBlocker(base, false)).toMatch(/another server/);
    expect(pauseBlocker({ ...base, status: "paused" }, true)).toMatch(/already paused/);
    expect(pauseBlocker({ ...base, status: "stopped" }, true)).toMatch(/stopped/);
    expect(pauseBlocker({ ...base, backend: "wgc" }, true)).toMatch(/wgc/);
    expect(pauseBlocker({ ...base, capture: undefined }, true)).toMatch(/before pause/);
  });

  it("resumes only a session this server paused", () => {
    const paused: SessionRecord = { ...base, status: "paused", segments: { parts: [] } };
    expect(resumeBlocker(paused, true)).toBeNull();
    expect(resumeBlocker(paused, false)).toMatch(/another server/);
    expect(resumeBlocker(base, true)).toMatch(/already recording/);
    expect(resumeBlocker({ ...paused, status: "failed" }, true)).toMatch(/failed/);
  });

  it("treats paused as live in the registry", () => {
    const paused: SessionRecord = { ...base, status: "paused", pid: null };
    expect(isLive("paused")).toBe(true);
    expect(classifyOrphan(paused, false)).toEqual({ status: "stopped", reaped: false });
    expect(isForeignLiveRecording({ ...paused, serverPid: 99 }, 1, true)).toBe(true);
    const old = Array.from({ length: 120 }, (_, i): SessionRecord => ({ ...base, id: `s${i}`, status: "stopped" }));
    expect(pruneRecords([...old, paused]).some((r) => r.status === "paused")).toBe(true);
  });

  it("resolves sessionEnded once the capture really ends", async () => {
    const ended = sessionEnded("rec-x");
    let done = false;
    void ended.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    endSession("rec-x");
    await ended;
    expect(done).toBe(true);
    await sessionEnded("rec-x"); // a late waiter still resolves
  });
});

describe("webcam capture (#200)", () => {
  it("lists dshow cameras apart from audio devices", () => {
    const stderr = [
      '[in#0 @ 0] "Logi C270 HD WebCam" (video)',
      '[in#0 @ 0]   Alternative name "@device_pnp_x"',
      '[in#0 @ 0] "Microphone (Logi C270 HD WebCam)" (audio)',
      "[dshow @ 0] DirectShow video devices",
      '[dshow @ 0]  "Old Cam"',
      "[dshow @ 0] DirectShow audio devices",
      '[dshow @ 0]  "Stereo Mix"',
    ].join("\n");
    expect(parseDshowVideoDevices(stderr)).toEqual(["Logi C270 HD WebCam", "Old Cam"]);
    expect(parseDshowAudioDevices(stderr)).toEqual(["Microphone (Logi C270 HD WebCam)", "Stereo Mix"]);
  });

  it("records the camera as a mapped second output with wall-clock timestamps", () => {
    expect(buildWebcamInputArgs("Cam")).toEqual(["-f", "dshow", "-use_wallclock_as_timestamps", "1", "-rtbufsize", "256M", "-i", "video=Cam"]);
    const args = buildCaptureArgs(
      { kind: "region", x: 0, y: 0, w: 640, h: 480 },
      { output: "a.mp4", audio: { device: "Stereo Mix" }, webcam: { device: "Cam", output: "w.mp4" }, maxDurationSec: 10 },
    );
    const s = args.join(" ");
    expect(s).toContain("-map 0:v -map 1:a");
    expect(s).toMatch(/-t 10 a\.mp4 -map 2:v -c:v libx264 .* -t 10 w\.mp4$/);
  });

  it("reads each input's banner start", () => {
    const head = "Input #0, gdigrab, from 'desktop':\n  Duration: N/A, start: 1793161578.440033\nInput #1, dshow, from 'video=Cam':\n  Duration: N/A, start: 1793161579.386154\n";
    expect(parseCaptureStart(head)).toBe(1793161578440);
    expect(parseCaptureStart(head, 1)).toBe(1793161579386);
    expect(parseCaptureStart(head, 2)).toBeNull();
  });

  it("pads a late camera, trims an early one, and holds each part to its segment", () => {
    const args = buildWebcamAlignArgs(
      [
        { path: "w0.mp4", leadSec: 0.95, durationSec: 4 },
        { path: "w1.mp4", leadSec: -0.2, durationSec: 3.5 },
      ],
      "cam.mp4",
      ["-c:v", "libx264"],
    );
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:v]tpad=start_duration=0.95:start_mode=clone,tpad=stop_duration=4:stop_mode=clone,trim=duration=4");
    expect(graph).toContain("[1:v]trim=start=0.2,setpts=PTS-STARTPTS,tpad=stop_duration=3.5");
    expect(graph).toContain("[w0][w1]concat=n=2:v=1:a=0[v]");
    expect(args.at(-1)).toBe("cam.mp4");
  });

  it("suggests an even-sized corner placement", () => {
    expect(webcamPlacement({ width: 1920, height: 1080 }, { width: 640, height: 480 }, "bottom_right", 0.25)).toEqual({
      x: 1920 - 480 - 38,
      y: 1080 - 360 - 38,
      width: 480,
      height: 360,
    });
    expect(webcamPlacement({ width: 1920, height: 1080 }, { width: 1, height: 1 }, "top_left", 0.2)).toEqual({ x: 38, y: 38, width: 384, height: 384 });
  });

  it("overlay masks a circle on request", () => {
    const args = buildOverlayArgs("a.mp4", "w.mp4", "o.mp4", { x: 0, y: 0, scale: { height: 200 }, shape: "circle" });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toMatch(/scale=-1:200,crop='min\(iw,ih\)'.*hypot\(X-W\/2,Y-H\/2\)/);
  });
});
