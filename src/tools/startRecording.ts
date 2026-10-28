import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, wgcAvailable } from "../utils/ffmpeg.js";
import { fileURLToPath } from "node:url";
import {
  buildCaptureArgs,
  captureFrame,
  DEFAULT_FPS,
  DEFAULT_QUALITY,
  DEFAULT_MAX_RECORDING_SEC,
  MAX_RECORDING_CAP_SEC,
  resolveMaxDuration,
  captureKeyframeArgs,
  type Quality,
} from "../utils/targets.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { windowMatchReport } from "../utils/windows.js";
import { resolveLoopbackDevice, resolveVideoDevice } from "../utils/audioDevices.js";
import { confirmCapture, describeTarget } from "../utils/consent.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { getStore } from "../context.js";
import { killPid, serverIdentity, type SessionRecord } from "../utils/sessions.js";
import { mkdirSync, rmSync } from "node:fs";
import {
  buildDdaInputArgs,
  ddagrabWorks,
  encoderArgs,
  getDxgiOutputs,
  planDdaSource,
  resolveEncoder,
} from "../utils/gpu.js";
import {
  attachExitHandler,
  captureStartMs,
  settleCapture,
  tailLines,
  watchStderr,
  type CaptureWatch,
} from "../utils/recorder.js";
import {
  DEFAULT_WEBCAM_SIZE,
  eventClock,
  partsDir,
  sessionEnded,
  webcamOutputPath,
  webcamPartPath,
} from "../utils/pause.js";
import { basename, join } from "node:path";
import {
  MAX_REPLAY_SEC,
  MIN_REPLAY_SEC,
  discardReplay,
  planReplayBuffer,
  prepareReplayDir,
  segmentOutputArgs,
} from "../utils/replay.js";
import {
  DEFAULT_KEY_MODE,
  eventPaths,
  parseCaptureStart,
  prepareEventPaths,
  startEventLogger,
  stopEventLogger,
  summarizeEvents,
  trackFinalizer,
  writeEventsFile,
  type KeyMode,
} from "../utils/events.js";

const inputSchema = {
  target: z
    .string()
    .describe(
      "full | monitor:<i> (0 = primary) | window:<title> (or window:exe=<app.exe> / window:hwnd=<n>) | " +
        "region:<x>,<y>,<w>,<h>. With gdigrab a window's rectangle is resolved once at start (visible, " +
        "on top); it does not follow the window.",
    ),
  exactTitle: z
    .boolean()
    .optional()
    .describe(
      "window: targets match the whole title only, never a substring (default false).",
    ),
  fps: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe(`Frames per second (default ${DEFAULT_FPS}).`),
  quality: z
    .enum(["draft", "standard", "high"])
    .optional()
    .describe(`Encoder preset (default ${DEFAULT_QUALITY}).`),
  audio: z
    .object({
      source: z
        .enum(["system", "none"])
        .describe("system = what the machine plays (needs a loopback device); none = video only."),
      device: z
        .string()
        .optional()
        .describe("dshow loopback device (from list_audio_devices); auto-detected if omitted."),
    })
    .optional()
    .describe("Audio (default none). No microphone capture."),
  output: z
    .string()
    .optional()
    .describe("Output .mp4 path (default under SCREENCAST_HOME/recordings)."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
  maxDurationSec: z
    .number()
    .int()
    .min(0)
    .max(MAX_RECORDING_CAP_SEC)
    .optional()
    .describe(
      `Auto-stop after this many seconds (default ${DEFAULT_MAX_RECORDING_SEC} or ` +
        "SCREENCAST_MAX_RECORDING_SEC; max 7 days; 0 = no cap).",
    ),
  events: z
    .boolean()
    .optional()
    .describe(
      "Also log clicks, scroll, cursor, and typing (video-timed, video pixels) for read_events " +
        "(default false; ~1 s slower start).",
    ),
  keys: z
    .enum(["masked", "shortcuts"])
    .optional()
    .describe(
      "With events: masked (default) logs typing only as 0.5 s-grid bursts, never keys; shortcuts " +
        "also names Ctrl/Alt/Win chords. Typed text is never logged.",
    ),
  cursor: z
    .enum(["os", "events"])
    .optional()
    .describe('events: leave the OS cursor out and log it (implies events) for the cursor tool to redraw.'),
  backend: z
    .enum(["gdigrab", "wgc", "ddagrab"])
    .optional()
    .describe(
      "gdigrab (default): the screen rectangle. wgc (window: targets, FFmpeg 8+): the window's own " +
        "surface, even when covered or moved; client area only, no audio. ddagrab: one display on the GPU, low CPU.",
    ),
  encoder: z
    .enum(["auto", "x264", "nvenc", "qsv", "amf"])
    .optional()
    .describe("auto = first working GPU encoder, else x264 (default with ddagrab; else x264)."),
  webcam: z
    .object({
      device: z.string().optional().describe("list_video_devices name (default: first)."),
      corner: z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]).optional(),
      size: z.number().min(0.1).max(0.5).optional().describe("Share of width (0.25)."),
      shape: z.enum(["rect", "circle"]).optional(),
    })
    .optional()
    .describe("Also record a camera to <output>.webcam.mp4, aligned for overlay."),
  replayBufferSec: z
    .number()
    .int()
    .min(MIN_REPLAY_SEC)
    .max(MAX_REPLAY_SEC)
    .optional()
    .describe("Instant replay: keep only the last N s (bounded disk) for save_replay. gdigrab only."),
};

/** The camera's first-frame epoch from its banner (input 1, or 2 after audio). */
function webcamStart(watch: CaptureWatch, audio: boolean): { webcamStartMs?: number } {
  const ms = parseCaptureStart(watch.head(), audio ? 2 : 1);
  return ms !== null ? { webcamStartMs: ms } : {};
}

export function register(server: McpServer): void {
  server.registerTool(
    "start_recording",
    {
      title: "Start Recording",
      description:
        "Start a background screen recording. Returns a session id; finalize it with stop_recording. " +
        "Never auto-starts.",
      inputSchema,
      outputSchema: looseOutput({
        sessionId: z.string(),
        status: z.string(),
        backend: z.string(),
        outputPath: z.string(),
      }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        // A cursor left out of the video is redrawn from the event log (#170).
        const hideCursor = args.cursor === "events";
        if (hideCursor) args.events = true;
        const { target, monitors, window } = await resolveCaptureTarget(args.target, {
          exactTitle: args.exactTitle,
          backend: args.backend,
        });
        const backend = args.backend ?? "gdigrab";
        if (backend === "wgc") {
          if (!window?.hwnd) throw new ScreencastError('backend "wgc" records one window: use a window: target.');
          if (args.audio?.source === "system") throw new ScreencastError('Audio is not supported with backend "wgc" yet; use gdigrab.');
          if (!wgcAvailable()) {
            throw new ScreencastError('backend "wgc" needs FFmpeg 8 or newer (the gfxcapture filter). Use gdigrab, or update ffmpeg.');
          }
        }
        // Instant replay (#197): a segment ring instead of one mp4.
        if (args.replayBufferSec !== undefined && backend === "wgc") {
          throw new ScreencastError('replayBufferSec is not supported with backend "wgc" yet; use gdigrab.');
        }
        const replay = args.replayBufferSec !== undefined ? planReplayBuffer(args.replayBufferSec) : null;
        const fps = args.fps ?? DEFAULT_FPS;
        const quality: Quality = (args.quality as Quality) ?? DEFAULT_QUALITY;
        const maxDurationSec = resolveMaxDuration(args.maxDurationSec);
        const output = resolveOutput(
          args.output,
          subdir("recordings"),
          `rec-${stamp()}-${rand()}.mp4`,
          args.overwrite,
        );

        // Resolve a loopback device up front so a missing one fails before the
        // ffmpeg child is spawned, with a clear install hint.
        const audio =
          args.audio?.source === "system"
            ? { device: await resolveLoopbackDevice(args.audio.device) }
            : undefined;
        // A webcam records beside the screen into its own file (#200).
        if (args.webcam && (backend === "wgc" || replay)) {
          throw new ScreencastError("webcam works with backend gdigrab or ddagrab, without replayBufferSec.");
        }
        const webcamDevice = args.webcam ? await resolveVideoDevice(args.webcam.device) : undefined;
        // ddagrab captures one display, picked by its DXGI output (#199).
        const dda = backend === "ddagrab" ? planDdaSource(captureFrame(target, monitors), await getDxgiOutputs()) : null;
        await confirmCapture(
          server,
          (replay ? `Keep a rolling ${replay.bufferSec} s replay buffer of ` : "Record ") +
            `${describeTarget(args.target, window)} ` +
            (maxDurationSec > 0 ? `for up to ${maxDurationSec} s` : "with no time limit") +
            (audio ? `, with system audio (${audio.device})` : ", without audio") +
            (webcamDevice ? `, with the webcam (${webcamDevice})` : "") +
            (args.events ? ", logging mouse clicks and typing" : "") +
            (replay ? ", kept only until save_replay or stop_recording { save: true } writes it out?" : `, saved to ${output}?`),
          extra.signal,
        );

        // GPU encode (#199): auto probes once per process, else libx264.
        const pick = await resolveEncoder(
          args.encoder ?? (backend === "ddagrab" ? "auto" : "x264"),
          backend === "ddagrab" ? "ddagrab" : "gdigrab",
          ffmpeg,
        );
        if (dda && !pick.gpuFrames && !(await ddagrabWorks(ffmpeg))) {
          throw new ScreencastError(
            "Desktop Duplication (ddagrab) does not capture on this machine (a remote session, or no D3D11 GPU).",
            'Use backend "gdigrab".',
          );
        }
        const hw = pick.encoder !== "x264";
        const captureOpts = {
          fps,
          quality,
          monitors,
          audio,
          drawMouse: !hideCursor,
          ...(dda ? { videoInput: buildDdaInputArgs(dda, fps, { download: !pick.gpuFrames, drawMouse: !hideCursor }) } : {}),
          ...(hw ? { videoCodec: encoderArgs(pick.encoder, quality, { gpuFrames: pick.gpuFrames }) } : {}),
        };
        const webcam = webcamDevice
          ? { device: webcamDevice, ...(hw ? { codec: encoderArgs(pick.encoder, quality) } : {}) }
          : undefined;
        const webcamRaw = webcam ? webcamPartPath(output, 0) : undefined;
        if (webcamRaw) mkdirSync(partsDir(output), { recursive: true });
        const captureArgs = buildCaptureArgs(target, {
          ...captureOpts,
          output,
          maxDurationSec,
          ...(webcam && webcamRaw ? { webcam: { ...webcam, output: webcamRaw } } : {}),
        });
        const ffArgs = replay ? segmentOutputArgs(captureArgs, replay) : captureArgs;
        if (replay) prepareReplayDir(replay);
        // The event logger starts first so the first frames have events (#118).
        // A replay session's raw log lives in its buffer; save_replay slices it.
        const keyMode: KeyMode = args.keys ?? DEFAULT_KEY_MODE;
        const evPaths = args.events ? (replay ? { raw: join(replay.dir, "events.raw"), jsonl: "" } : eventPaths(output)) : null;
        if (evPaths && !replay) prepareEventPaths(evPaths, args.overwrite);
        // wgc frames the client area; its size is known once the recorder starts.
        let frame = args.events
          ? captureFrame(target, monitors)
          : null;
        const logger = evPaths ? await startEventLogger(evPaths.raw, keyMode) : null;

        const spawnedAt = Date.now();
        const child =
          backend === "wgc"
            ? spawn(
                process.execPath,
                [
                  fileURLToPath(new URL("../wgcRecorder.js", import.meta.url)),
                  JSON.stringify({ ffmpeg, hwnd: window!.hwnd, fps, encode: [...encoderArgs(pick.encoder, quality), ...captureKeyframeArgs(fps)], output, maxDurationSec, cursor: !hideCursor }),
                ],
                { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
              )
            : spawn(ffmpeg, ffArgs, {
                stdio: ["pipe", "ignore", "pipe"],
                windowsHide: true,
              });

        // Detect an immediate failure (bad window title, busy device, etc.).
        // The head keeps the input banner, whose start: time aligns events.
        // Warnings and dropped frames go to the client as log messages (#222).
        const id = `rec-${stamp()}-${rand(6)}`;
        const watch = watchStderr(child, id);
        const settled = await settleCapture(child, watch, backend);

        if (settled === "exited") {
          if (logger) await stopEventLogger(logger);
          if (evPaths) rmSync(evPaths.raw, { force: true });
          if (replay) discardReplay(replay);
          if (webcamRaw) rmSync(partsDir(output), { recursive: true, force: true });
          throw new ScreencastError(
            `Recording failed to start (${backend === "wgc" ? "window capture" : "ffmpeg"} exited immediately):\n${tailLines(watch)}`,
          );
        }
        // The video clock's zero, for add_marker (#174) and the event log.
        const startMs = captureStartMs(watch, backend, spawnedAt);
        if (backend === "wgc" && frame && window?.client) {
          const m = /wgc: (\d+)x(\d+)/.exec(watch.head());
          frame = { x: window.client.x, y: window.client.y, w: m ? Number(m[1]) : frame.w, h: m ? Number(m[2]) : frame.h };
        }

        const record: SessionRecord = {
          id,
          target: args.target,
          outputPath: output,
          fps,
          quality,
          pid: child.pid ?? null,
          ...serverIdentity(),
          status: "recording",
          startedAt: new Date().toISOString(),
          videoStartMs: startMs,
          ...(maxDurationSec > 0 ? { maxDurationSec } : {}),
          ...(window ? { matchedWindow: window.matchedTitle } : {}),
          ...(evPaths && !replay ? { events: { path: evPaths.jsonl, keys: keyMode } } : {}),
          ...(replay
            ? {
                replay: {
                  ...replay,
                  ...(evPaths && frame
                    ? { events: { raw: evPaths.raw, keys: keyMode, startMs, frame } }
                    : {}),
                },
              }
            : {}),
          backend,
          ...(pick.encoder !== "x264" ? { encoder: pick.encoder } : {}),
          // ffmpeg captures can pause into segments (#200).
          ...(backend !== "wgc" && !replay
            ? {
                capture: { target, opts: captureOpts, ...(webcam ? { webcam } : {}) },
                segments: {
                  parts: [],
                  current: {
                    path: output,
                    startMs,
                    ...(webcamRaw ? { webcamPath: webcamRaw, ...webcamStart(watch, !!audio) } : {}),
                  },
                },
              }
            : {}),
          ...(webcamDevice
            ? {
                webcam: {
                  device: webcamDevice,
                  path: webcamOutputPath(output),
                  corner: args.webcam?.corner ?? "bottom_right",
                  size: args.webcam?.size ?? DEFAULT_WEBCAM_SIZE,
                  shape: args.webcam?.shape ?? "rect",
                },
              }
            : {}),
          processImage: backend === "wgc" ? basename(process.execPath).toLowerCase() : "ffmpeg.exe",
        };
        const store = getStore();
        // Register the child for shutdown first; if the registry write fails,
        // stop the capture rather than leave one nothing can reach (#207).
        store.attachChild(id, child);
        try {
          store.create(record);
        } catch (err) {
          store.detachChild(id);
          if (child.pid !== undefined) killPid(child.pid);
          if (logger) await stopEventLogger(logger);
          if (evPaths) rmSync(evPaths.raw, { force: true });
          if (replay) discardReplay(replay);
          if (webcamRaw) rmSync(partsDir(output), { recursive: true, force: true });
          throw new ScreencastError(
            `Recording stopped: the session registry could not be written (${(err as Error).message}).`,
          );
        }
        if (logger && replay) {
          // The raw log stays in the buffer for save_replay to slice (#197).
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          trackFinalizer(id, exited.then(() => stopEventLogger(logger)));
        } else if (logger && evPaths && frame) {
          // The log converts when the capture ends, not at a pause; paused
          // stretches are cut out of its clock (#200).
          trackFinalizer(
            id,
            sessionEnded(id).then(async () => {
              await stopEventLogger(logger);
              try {
                const clock = eventClock(store.get(id)?.segments, startMs, Date.now());
                const events = writeEventsFile(evPaths, { ...clock, frame });
                store.tryUpdate(id, {
                  events: { path: evPaths.jsonl, keys: keyMode, count: events.length, summary: summarizeEvents(events) },
                });
              } catch (err) {
                store.tryUpdate(id, {
                  events: { path: evPaths.jsonl, keys: keyMode, error: (err as Error).message },
                });
              }
            }).catch((err: unknown) => {
              process.stderr.write(`Event log for ${id} failed: ${err instanceof Error ? err.message : String(err)}\n`);
            }),
          );
        }
        // Keep the on-disk record consistent if the child dies on its own: a
        // crash is "failed" with the stderr tail, a clean exit the cap or the
        // window closing (#240).
        attachExitHandler(store, id, child, { backend, maxDurationSec, spawnedAt, watch });

        return okResponse({
          sessionId: id,
          status: "recording",
          backend,
          outputPath: output,
          pid: record.pid,
          fps,
          quality,
          audioDevice: audio?.device ?? null,
          maxDurationSec: maxDurationSec > 0 ? maxDurationSec : null,
          encoder: pick.encoder,
          ...(pick.note ? { encoderNote: pick.note } : {}),
          ...(dda ? { gpuFrames: pick.gpuFrames } : {}),
          ...(webcamDevice ? { webcam: { device: webcamDevice, path: webcamOutputPath(output) } } : {}),
          ...(window ? windowMatchReport(window) : {}),
          ...(evPaths && !replay ? { eventsPath: evPaths.jsonl, keys: keyMode } : {}),
          ...(replay
            ? { replay: { bufferSec: replay.bufferSec, segmentSec: replay.segmentSec, dir: replay.dir, events: !!evPaths } }
            : {}),
          note:
            (replay
              ? `Replay buffer running: save_replay keeps the last seconds (up to ${replay.bufferSec}s) without stopping it; ` +
                "stop_recording discards the buffer unless save: true (then it writes outputPath)."
              : "Call stop_recording with this sessionId to finalize the file" +
                (backend === "wgc" ? "." : " (pause_recording/resume_recording leave stretches out).")) +
            (maxDurationSec > 0
              ? ` It stops on its own after ${maxDurationSec}s (maxDurationSec).`
              : ""),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
