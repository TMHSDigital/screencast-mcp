/**
 * The pure parts of start_recording (#307): the argument checks that need no
 * desktop, the consent prompt, the session record, and the result. The tool
 * handler resolves the target and devices, spawns, and wires sidecars; these
 * turn its findings into text and records, so they are unit-tested without
 * ffmpeg or Windows.
 */
import { ScreencastError } from "./errors.js";
import { HOTKEYS, type CaptureFrame, type KeyMode } from "./events.js";
import { DEFAULT_WEBCAM_SIZE, webcamOutputPath, type Corner } from "./pause.js";
import { windowMatchReport, type WindowBounds } from "./windows.js";
import type { ReplayBuffer } from "./replay.js";
import type { SessionRecord } from "./sessions.js";

export type CaptureBackend = "gdigrab" | "wgc" | "ddagrab";

/** The options whose combinations are checked before anything starts. */
export interface StartChoices {
  backend: CaptureBackend;
  systemAudio: boolean;
  replay: boolean;
  webcam: boolean;
  logs: boolean;
  perf: boolean;
}

/** Reject combinations that cannot work, before any resource is taken. Pure
 * apart from the facts passed in. */
export function checkStartChoices(c: StartChoices, facts: { windowHwnd: boolean; wgcAvailable: boolean }): void {
  if (c.backend === "wgc") {
    if (!facts.windowHwnd) throw new ScreencastError('backend "wgc" records one window: use a window: target.');
    if (c.systemAudio) throw new ScreencastError('Audio is not supported with backend "wgc" yet; use gdigrab.');
    if (!facts.wgcAvailable) throw new ScreencastError('backend "wgc" needs FFmpeg 8 or newer (the gfxcapture filter). Use gdigrab, or update ffmpeg.');
    if (c.replay) throw new ScreencastError('replayBufferSec is not supported with backend "wgc" yet; use gdigrab or ddagrab.');
  }
  if (c.webcam && (c.backend === "wgc" || c.replay)) {
    throw new ScreencastError("webcam works with backend gdigrab or ddagrab, without replayBufferSec.");
  }
  if ((c.logs || c.perf) && c.replay) throw new ScreencastError("logs and perf are not supported with replayBufferSec yet.");
}

/** What the person is asked to approve (#222): target, length, audio, camera,
 * what is logged, and where it goes. Pure. */
export function consentPrompt(o: {
  target: string;
  replayBufferSec?: number;
  maxDurationSec: number;
  audioDevice?: string;
  webcamDevice?: string;
  events: boolean;
  focus?: "app" | "title";
  elements?: boolean;
  hotkeys?: boolean;
  output: string;
}): string {
  return (
    (o.replayBufferSec ? `Keep a rolling ${o.replayBufferSec} s replay buffer of ` : "Record ") +
    `${o.target} ` +
    (o.maxDurationSec > 0 ? `for up to ${o.maxDurationSec} s` : "with no time limit") +
    (o.audioDevice ? `, with system audio (${o.audioDevice})` : ", without audio") +
    (o.webcamDevice ? `, with the webcam (${o.webcamDevice})` : "") +
    (o.events ? ", logging mouse clicks and typing" : "") +
    (o.focus ? (o.focus === "title" ? " and which window is in front, with its title" : " and which app is in front") : "") +
    (o.elements ? ", naming the on-screen controls you click" : "") +
    (o.hotkeys ? `, with hotkeys (${HOTKEYS.marker} marks, ${HOTKEYS.stop} stops)` : "") +
    (o.replayBufferSec ? ", kept only until save_replay or stop_recording { save: true } writes it out?" : `, saved to ${o.output}?`)
  );
}

export interface RecordFacts {
  id: string;
  target: string;
  output: string;
  fps: number;
  quality: SessionRecord["quality"];
  pid: number | null;
  spawnedAt: number;
  startMs: number;
  maxDurationSec: number;
  window?: WindowBounds;
  backend: CaptureBackend;
  encoder: string;
  events?: { jsonl: string; raw: string; keys: KeyMode; frame: CaptureFrame | null };
  replay?: ReplayBuffer;
  /** ffmpeg capture settings, kept so pause/resume can start a new segment. */
  capture?: { target: unknown; opts: unknown; webcam?: unknown };
  webcam?: { device: string; rawPath: string; startMs?: number; corner?: Corner; size?: number; shape?: "rect" | "circle" };
  /** The capturing process's image name, for the pid-reuse guard. */
  processImage: string;
  identity: Pick<SessionRecord, "serverPid" | "serverStartedAt" | "serverImage">;
  now?: Date;
}

/** The session record start_recording writes. Pure. */
export function buildSessionRecord(f: RecordFacts): SessionRecord {
  const replayEvents = f.replay && f.events?.frame ? { events: { raw: f.events.raw, keys: f.events.keys, startMs: f.startMs, frame: f.events.frame } } : {};
  return {
    id: f.id,
    target: f.target,
    outputPath: f.output,
    fps: f.fps,
    quality: f.quality,
    pid: f.pid,
    pidSpawnedAt: f.spawnedAt,
    ...f.identity,
    status: "recording",
    startedAt: (f.now ?? new Date()).toISOString(),
    videoStartMs: f.startMs,
    ...(f.maxDurationSec > 0 ? { maxDurationSec: f.maxDurationSec } : {}),
    ...(f.window ? { matchedWindow: f.window.matchedTitle } : {}),
    ...(f.events && !f.replay ? { events: { path: f.events.jsonl, keys: f.events.keys } } : {}),
    ...(f.replay ? { replay: { ...f.replay, ...replayEvents } } : {}),
    backend: f.backend,
    ...(f.encoder !== "x264" ? { encoder: f.encoder as SessionRecord["encoder"] } : {}),
    // ffmpeg captures can pause into segments (#200).
    ...(f.capture && f.backend !== "wgc" && !f.replay
      ? {
          capture: f.capture as SessionRecord["capture"],
          segments: {
            parts: [],
            current: {
              path: f.output,
              startMs: f.startMs,
              ...(f.webcam ? { webcamPath: f.webcam.rawPath, ...(f.webcam.startMs !== undefined ? { webcamStartMs: f.webcam.startMs } : {}) } : {}),
            },
          },
        }
      : {}),
    ...(f.webcam
      ? {
          webcam: {
            device: f.webcam.device,
            path: webcamOutputPath(f.output),
            corner: f.webcam.corner ?? "bottom_right",
            size: f.webcam.size ?? DEFAULT_WEBCAM_SIZE,
            shape: f.webcam.shape ?? "rect",
          },
        }
      : {}),
    processImage: f.processImage,
  };
}

/** start_recording's result for a started session. Pure. */
export function startResult(o: {
  record: SessionRecord;
  audioDevice?: string;
  maxDurationSec: number;
  encoder: string;
  encoderNote?: string;
  gpuFrames?: boolean;
  webcamDevice?: string;
  window?: WindowBounds;
  events?: { jsonl: string; keys: KeyMode };
  logs?: { path: string; missing: boolean };
  hotkeys?: { taken: Array<keyof typeof HOTKEYS> };
  replay?: { bufferSec: number; segmentSec: number; dir: string; events: boolean };
}): Record<string, unknown> {
  const r = o.record;
  return {
    sessionId: r.id,
    status: "recording",
    backend: r.backend,
    outputPath: r.outputPath,
    pid: r.pid,
    fps: r.fps,
    quality: r.quality,
    audioDevice: o.audioDevice ?? null,
    maxDurationSec: o.maxDurationSec > 0 ? o.maxDurationSec : null,
    encoder: o.encoder,
    ...(o.encoderNote ? { encoderNote: o.encoderNote } : {}),
    ...(o.gpuFrames !== undefined ? { gpuFrames: o.gpuFrames } : {}),
    ...(o.webcamDevice ? { webcam: { device: o.webcamDevice, path: webcamOutputPath(r.outputPath) } } : {}),
    ...(o.window ? windowMatchReport(o.window) : {}),
    ...(o.events && !o.replay ? { eventsPath: o.events.jsonl, keys: o.events.keys } : {}),
    ...(o.logs
      ? { logsPath: o.logs.path, ...(o.logs.missing ? { logsNote: "A log file does not exist yet; it is read from its start once it appears." } : {}) }
      : {}),
    ...(o.hotkeys
      ? {
          hotkeys: {
            ...HOTKEYS,
            ...(o.hotkeys.taken.length
              ? { unavailable: o.hotkeys.taken, warning: `Another app holds ${o.hotkeys.taken.map((a) => HOTKEYS[a]).join(" and ")}.` }
              : {}),
          },
        }
      : {}),
    ...(o.replay ? { replay: { bufferSec: o.replay.bufferSec, segmentSec: o.replay.segmentSec, dir: o.replay.dir, events: o.replay.events } } : {}),
    note:
      (o.replay
        ? `Replay buffer running: save_replay keeps the last seconds (up to ${o.replay.bufferSec}s) without stopping it; ` +
          "stop_recording discards the buffer unless save: true (then it writes outputPath)."
        : "Call stop_recording with this sessionId to finalize the file" +
          (r.backend === "wgc" ? "." : " (pause_recording/resume_recording leave stretches out).")) +
      (o.maxDurationSec > 0 ? ` It stops on its own after ${o.maxDurationSec}s (maxDurationSec).` : ""),
  };
}
