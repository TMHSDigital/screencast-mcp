import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildSessionRecord, checkStartChoices, consentPrompt, startResult, type CaptureBackend } from "../utils/startPlan.js";
import type { WindowBounds } from "../utils/windows.js";
import { errorMessage, errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { probeDuration, requireFfmpeg, wgcAvailable } from "../utils/ffmpeg.js";
import { stopSession } from "../utils/lifecycle.js";
import { addSessionMarker } from "../utils/sessionMarker.js";
import { wgcRecorderScript } from "../utils/packageRoot.js";
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
import { resolveLoopbackDevice, resolveVideoDevice } from "../utils/audioDevices.js";
import { confirmCapture, describeTarget } from "../utils/consent.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { beginStart, getStore } from "../context.js";
import { killPid, serverIdentity, type SessionRecord, type SessionStore } from "../utils/sessions.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureStill } from "../utils/still.js";
import { readFrames } from "../utils/ocrScan.js";
import { findMatches } from "../utils/ocr.js";
import { armStart, describeConditions, waitForConditions, ARM_POLL_MS, DEFAULT_ARM_TIMEOUT_SEC, MAX_ARM_TIMEOUT_SEC } from "../utils/triggers.js";
import { LogTailer, MAX_LOG_SOURCES, convertLogLines, formatLogsJsonl, logsPath } from "../utils/logTail.js";
import { PerfSampler, convertPerfSamples, formatPerfJsonl, perfPath, summarizePerf } from "../utils/perf.js";
import {
  buildDdaInputArgs,
  ddagrabWorks,
  encoderArgs,
  getDxgiOutputs,
  planDdaSource,
  resolveEncoder,
  startWithEncoderFallback,
  type EncoderPick,
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
  eventClock,
  partsDir,
  sessionEnded,
  webcamPartPath,
} from "../utils/pause.js";
import { basename, dirname, join } from "node:path";
import { diskCheck, freeBytesFor } from "../utils/storage.js";
import {
  MAX_REPLAY_SEC,
  MIN_REPLAY_SEC,
  discardReplay,
  planReplayBuffer,
  prepareReplayDir,
  replayEventRotateSec,
  resetReplaySegments,
  segmentOutputArgs,
} from "../utils/replay.js";
import {
  DEFAULT_KEY_MODE,
  eventPaths,
  hotkeysTaken,
  parseCaptureStart,
  prepareEventPaths,
  startEventLogger,
  stopEventLogger,
  summarizeEvents,
  trackFinalizer,
  writeEventsFile,
  type CaptureFrame,
  type HotkeyAction,
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
  focus: z
    .enum(["app", "title"])
    .optional()
    .describe("Log app switches (implies events); title adds window titles."),
  logs: z
    .array(z.object({ path: z.string().min(1), label: z.string().min(1).max(40).optional() }))
    .min(1)
    .max(MAX_LOG_SOURCES)
    .optional()
    .describe("Log files to follow onto the video clock."),
  perf: z.boolean().optional().describe("Sample CPU/memory (and a window's app) to <rec>.perf.jsonl."),
  hotkeys: z.boolean().optional().describe("Ctrl+Alt+Shift+M adds a marker, +S stops (implies events)."),
  elements: z.boolean().optional().describe('Name the UI element each click hits, e.g. "Save" button (implies events).'),
  cursor: z
    .enum(["os", "events"])
    .optional()
    .describe('events: leave the OS cursor out and log it (implies events) for the cursor tool to redraw.'),
  backend: z
    .enum(["gdigrab", "wgc", "ddagrab"])
    .optional()
    .describe(
      "gdigrab (default): the screen rectangle. wgc (window: targets, FFmpeg 8+): the window's own " +
        "surface, even when covered or moved; client area only. ddagrab: one display on the GPU, low CPU.",
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
    .describe("Instant replay: keep only the last N s (bounded disk) for save_replay. gdigrab or ddagrab, not wgc."),
  startWhen: z
    .object({
      window: z.string().min(1).optional().describe('A window: target that must exist, e.g. "window:Error".'),
      text: z.string().min(1).max(200).optional().describe("Text that must be on target (OCR)."),
      timeoutSec: z.number().positive().max(MAX_ARM_TIMEOUT_SEC).optional().describe(`Default ${DEFAULT_ARM_TIMEOUT_SEC}.`),
    })
    .optional()
    .describe("Arm: start once these hold (stop_recording disarms)."),
  stopWhen: z.object({ text: z.string().min(1).max(200) }).optional().describe("Stop once this text shows (OCR)."),
};

/** True when `text` is on the target now (one OCR read). */
async function textOnTarget(target: string, exactTitle: boolean | undefined, text: string): Promise<boolean> {
  const resolved = await resolveCaptureTarget(target, { exactTitle });
  const work = mkdtempSync(join(tmpdir(), "screencast-trigger-"));
  try {
    const shot = join(work, "t.png");
    await captureStill(resolved, shot);
    const [frame] = await readFrames([shot], work);
    return !!frame && findMatches(frame.lines, text).length > 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** True when the window: target exists now. */
async function windowExists(target: string): Promise<boolean> {
  try {
    await resolveCaptureTarget(target.startsWith("window:") ? target : `window:${target}`);
    return true;
  } catch {
    return false;
  }
}

/** Calls an armed recording's start already approved, at arm time (#336). */
const approvedAtArm = new WeakSet<object>();

/** The capture's frame size, for the encoder's limits (#253); undefined when
 * it is not known up front. */
function frameSize(target: Parameters<typeof captureFrame>[0], monitors: Parameters<typeof captureFrame>[1]): { width: number; height: number } | undefined {
  try {
    const f = captureFrame(target, monitors);
    return { width: f.w, height: f.h };
  } catch {
    return undefined;
  }
}

/** The camera's first-frame epoch from its banner (input 1, or 2 after audio). */
function webcamStart(watch: CaptureWatch, audio: boolean): { webcamStartMs?: number } {
  const ms = parseCaptureStart(watch.head(), audio ? 2 : 1);
  return ms !== null ? { webcamStartMs: ms } : {};
}

type StartArgs = z.infer<z.ZodObject<typeof inputSchema>>;
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * What a start has taken so far (#307): the event logger, its raw log, the
 * replay ring, the webcam parts, and the capture process. On any failure
 * before the session is registered, release() gives all of it back in one
 * place; once the session exists, handOff() leaves them to its finalizers.
 */
class StartResources {
  output?: string;
  webcamRaw?: string;
  replay?: ReturnType<typeof planReplayBuffer>;
  evPaths?: { raw: string; jsonl: string } | null;
  logger?: ChildProcess | null;
  child?: ChildProcess;
  private owned = true;

  handOff(): void {
    this.owned = false;
  }

  async release(): Promise<void> {
    if (!this.owned) return;
    this.owned = false;
    if (this.child?.pid !== undefined && this.child.exitCode == null) killPid(this.child.pid);
    if (this.logger) await stopEventLogger(this.logger);
    if (this.evPaths) rmSync(this.evPaths.raw, { force: true });
    if (this.replay) discardReplay(this.replay);
    if (this.webcamRaw && this.output) rmSync(partsDir(this.output), { recursive: true, force: true });
  }
}

/** Everything one capture attempt needs, for an encoder pick. */
interface CapturePlan {
  id: string;
  ffmpeg: string;
  backend: CaptureBackend;
  target: Parameters<typeof buildCaptureArgs>[0];
  monitors: Parameters<typeof captureFrame>[1];
  window?: WindowBounds;
  fps: number;
  quality: Quality;
  audio?: { device: string };
  hideCursor: boolean;
  dda: ReturnType<typeof planDdaSource> | null;
  webcamDevice?: string;
  webcamRaw?: string;
  output: string;
  maxDurationSec: number;
  replay: ReturnType<typeof planReplayBuffer> | null;
}

/** Spawn the capture with an encoder and wait until it is running or has
 * exited (a bad window, a busy device). */
async function launchCapture(c: CapturePlan, p: EncoderPick) {
  const hw = p.encoder !== "x264";
  const captureOpts = {
    fps: c.fps,
    quality: c.quality,
    monitors: c.monitors,
    audio: c.audio,
    drawMouse: !c.hideCursor,
    ...(c.dda ? { videoInput: buildDdaInputArgs(c.dda, c.fps, { download: !p.gpuFrames, drawMouse: !c.hideCursor }) } : {}),
    ...(hw ? { videoCodec: encoderArgs(p.encoder, c.quality, { gpuFrames: p.gpuFrames }) } : {}),
  };
  const webcam = c.webcamDevice ? { device: c.webcamDevice, ...(hw ? { codec: encoderArgs(p.encoder, c.quality) } : {}) } : undefined;
  const captureArgs = buildCaptureArgs(c.target, {
    ...captureOpts,
    output: c.output,
    maxDurationSec: c.maxDurationSec,
    ...(webcam && c.webcamRaw ? { webcam: { ...webcam, output: c.webcamRaw } } : {}),
  });
  const ffArgs = c.replay ? segmentOutputArgs(captureArgs, c.replay) : captureArgs;
  const spawnedAt = Date.now();
  const child =
    c.backend === "wgc"
      ? spawn(
          process.execPath,
          [
            wgcRecorderScript(),
            JSON.stringify({ ffmpeg: c.ffmpeg, hwnd: c.window!.hwnd, fps: c.fps, encode: [...encoderArgs(p.encoder, c.quality), ...captureKeyframeArgs(c.fps)], output: c.output, maxDurationSec: c.maxDurationSec, cursor: !c.hideCursor, ...(c.audio ? { audioDevice: c.audio.device } : {}) }),
          ],
          { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
        )
      : spawn(c.ffmpeg, ffArgs, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  // The head keeps the input banner, whose start: time aligns events.
  // Warnings and dropped frames go to the client as log messages (#222).
  const watch = watchStderr(child, c.id);
  const settled = await settleCapture(child, watch, c.backend);
  return { captureOpts, webcam, child, watch, spawnedAt, settled };
}

/** The event log converts when the capture ends, not at a pause; paused
 * stretches are cut out of its clock (#200). A replay session's raw log stays
 * in its buffer for save_replay to slice (#197). */
function trackEventLog(
  store: SessionStore,
  id: string,
  o: { logger: ChildProcess; evPaths: { raw: string; jsonl: string }; keyMode: KeyMode; startMs: number; frame: CaptureFrame | null; replay: unknown; child: ChildProcess },
): void {
  if (o.replay) {
    const exited = new Promise<void>((resolve) => o.child.once("exit", () => resolve()));
    trackFinalizer(id, exited.then(() => stopEventLogger(o.logger)));
    return;
  }
  const frame = o.frame;
  if (!frame) return;
  trackFinalizer(
    id,
    sessionEnded(id)
      .then(async () => {
        await stopEventLogger(o.logger);
        try {
          const clock = eventClock(store.get(id)?.segments, o.startMs, Date.now());
          const events = writeEventsFile(o.evPaths, { ...clock, frame });
          store.tryUpdate(id, { events: { path: o.evPaths.jsonl, keys: o.keyMode, count: events.length, summary: summarizeEvents(events) } });
        } catch (err) {
          store.tryUpdate(id, { events: { path: o.evPaths.jsonl, keys: o.keyMode, error: errorMessage(err) } });
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(`Event log for ${id} failed: ${errorMessage(err)}\n`);
      }),
  );
}

/** Performance track (#335): from now until the session ends. */
function trackPerf(store: SessionStore, id: string, o: { output: string; startMs: number; window?: WindowBounds }): void {
  const sampler = new PerfSampler(o.window?.pid);
  sampler.start();
  const path = perfPath(o.output);
  store.tryUpdate(id, { perf: { path } });
  trackFinalizer(
    id,
    sessionEnded(id).then(async () => {
      try {
        const samples = convertPerfSamples(sampler.stop(), eventClock(store.get(id)?.segments, o.startMs, Date.now()));
        writeFileSync(path, formatPerfJsonl(samples));
        const proc = o.window?.pid !== undefined ? { pid: o.window.pid, ...(o.window.exe ? { exe: o.window.exe } : {}) } : undefined;
        store.tryUpdate(id, { perf: { path, summary: summarizePerf(samples, proc) } });
      } catch (err) {
        sampler.stop();
        store.tryUpdate(id, { perf: { path, error: errorMessage(err) } });
      }
    }),
  );
}

/** App logs (#334): follow from the marks until the session ends. */
function trackLogs(store: SessionStore, id: string, o: { tailer: LogTailer; logs: Array<{ path: string; label?: string }>; output: string; startMs: number }): void {
  o.tailer.follow();
  const path = logsPath(o.output);
  const sources = o.logs.map((l) => l.label ?? basename(l.path));
  store.tryUpdate(id, { logs: { path, sources } });
  trackFinalizer(
    id,
    sessionEnded(id).then(async () => {
      try {
        const lines = convertLogLines(await o.tailer.stop(), eventClock(store.get(id)?.segments, o.startMs, Date.now()));
        writeFileSync(path, formatLogsJsonl(lines));
        store.tryUpdate(id, { logs: { path, sources, count: lines.length, errors: lines.filter((l) => l.level === "error").length } });
      } catch (err) {
        store.tryUpdate(id, { logs: { path, sources, error: errorMessage(err) } });
      }
    }),
  );
}

/** Stop a session the way stop_recording does, from a hotkey or a trigger. */
function stopFromWatcher(store: SessionStore, id: string, why: string): void {
  const cur = store.get(id);
  if (!cur || (cur.status !== "recording" && cur.status !== "paused")) return;
  const { ffprobe } = requireFfmpeg();
  stopSession(store, cur, { reason: "stopped", probe: (path) => probeDuration(path, { ffprobe }) }).catch((err: unknown) =>
    process.stderr.write(`${why} stop for ${id} failed: ${errorMessage(err)}\n`),
  );
}

/** Hotkeys (#337): M adds a marker, S stops. */
function hotkeyHandler(store: SessionStore, id: string): (action: HotkeyAction) => void {
  return (action) => {
    const cur = store.get(id);
    if (!cur || (cur.status !== "recording" && cur.status !== "paused")) return;
    if (action === "stop") return stopFromWatcher(store, id, "Hotkey");
    try {
      addSessionMarker(store, id, "hotkey");
    } catch (err) {
      process.stderr.write(`Hotkey marker for ${id} failed: ${errorMessage(err)}\n`);
    }
  };
}

/** stopWhen (#336): stop once the text is on target; ends with the session. */
function watchStopWhen(store: SessionStore, id: string, o: { target: string; exactTitle?: boolean; text: string }): void {
  const done = new AbortController();
  void sessionEnded(id).then(() => done.abort());
  void waitForConditions({
    checks: [() => textOnTarget(o.target, o.exactTitle, o.text)],
    timeoutMs: Number.POSITIVE_INFINITY,
    intervalMs: ARM_POLL_MS,
    signal: done.signal,
  }).then((outcome) => {
    if (outcome === "met") stopFromWatcher(store, id, "stopWhen");
  });
}

/** Triggered recording (#336): arm now, and start later with the same args
 * through the tool's own handler. Consent is asked here, describing the
 * trigger, and not again when it fires. */
async function armRecording(server: McpServer, tool: RegisteredTool, args: StartArgs, extra: Extra): Promise<CallToolResult> {
  try {
    const when = args.startWhen!;
    if (!when.window && !when.text) throw new ScreencastError("startWhen needs window and/or text.");
    const timeoutSec = when.timeoutSec ?? DEFAULT_ARM_TIMEOUT_SEC;
    const conditions = { ...(when.window ? { window: when.window } : {}), ...(when.text ? { text: when.text } : {}) };
    await resolveCaptureTarget(args.target, { exactTitle: args.exactTitle, backend: args.backend });
    await confirmCapture(
      server,
      `When ${describeConditions(conditions)} (within ${timeoutSec} s), start recording ${describeTarget(args.target)}` +
        (args.events ? ", logging mouse clicks and typing" : "") + "?",
      extra.signal,
    );
    const startArgs = { ...args, startWhen: undefined };
    approvedAtArm.add(startArgs);
    const arm = armStart({
      conditions,
      target: args.target,
      timeoutSec,
      checks: [
        ...(when.window ? [() => windowExists(when.window!)] : []),
        ...(when.text ? [() => textOnTarget(args.target, args.exactTitle, when.text!)] : []),
      ],
      fire: async () => {
        const handler = tool.handler as (a: unknown, e: unknown) => Promise<CallToolResult>;
        const res = await handler(startArgs, { ...extra, signal: new AbortController().signal });
        const sc = res.structuredContent as { sessionId?: string } | undefined;
        if (res.isError || !sc?.sessionId) {
          throw new Error((res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(" ") || "start failed");
        }
        return sc.sessionId;
      },
    });
    return okResponse({
      sessionId: arm.id,
      status: "armed",
      backend: args.backend ?? "gdigrab",
      outputPath: "",
      waitingFor: describeConditions(conditions),
      timeoutSec,
      note: "Nothing is recorded yet. get_session with this id shows when it starts (and its recording's sessionId); stop_recording with it disarms.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Everything decided before the first resource is taken: the target, the
 * option checks, devices, consent, and the encoder. Throws on a problem. */
async function prepareStart(server: McpServer, args: StartArgs, extra: Extra) {
  const { ffmpeg } = requireFfmpeg();
  // A cursor left out of the video is redrawn from the event log (#170).
  const hideCursor = args.cursor === "events";
  if (hideCursor || args.focus || args.elements || args.hotkeys) args.events = true;
  const { target, monitors, window } = await resolveCaptureTarget(args.target, { exactTitle: args.exactTitle, backend: args.backend });
  const backend = args.backend ?? "gdigrab";
  checkStartChoices(
    { backend, systemAudio: args.audio?.source === "system", replay: args.replayBufferSec !== undefined, webcam: !!args.webcam, logs: !!args.logs, perf: !!args.perf },
    { windowHwnd: !!window?.hwnd, wgcAvailable: backend === "wgc" && wgcAvailable() },
  );
  // Instant replay (#197): a segment ring instead of one mp4.
  const replay = args.replayBufferSec !== undefined ? planReplayBuffer(args.replayBufferSec) : null;
  const fps = args.fps ?? DEFAULT_FPS;
  const quality: Quality = (args.quality as Quality) ?? DEFAULT_QUALITY;
  const maxDurationSec = resolveMaxDuration(args.maxDurationSec);
  const output = resolveOutput(args.output, subdir("recordings"), `rec-${stamp()}-${rand()}.mp4`, args.overwrite);
  // A nearly full drive fails partway with a write error (#354).
  const disk = diskCheck(await freeBytesFor(dirname(output)));
  if (disk.refuse) throw new ScreencastError(disk.refuse, "Free some space (delete_recording removes old recordings), or record to another drive with output.");
  // Devices are resolved up front so a missing one fails before anything
  // is spawned, with a clear install hint.
  const audio = args.audio?.source === "system" ? { device: await resolveLoopbackDevice(args.audio.device) } : undefined;
  const webcamDevice = args.webcam ? await resolveVideoDevice(args.webcam.device) : undefined;
  // ddagrab captures one display, picked by its DXGI output (#199).
  const dda = backend === "ddagrab" ? planDdaSource(captureFrame(target, monitors), await getDxgiOutputs()) : null;
  if (!approvedAtArm.has(args)) {
    const prompt = consentPrompt({
      target: describeTarget(args.target, window),
      replayBufferSec: replay?.bufferSec,
      maxDurationSec,
      audioDevice: audio?.device,
      webcamDevice,
      events: !!args.events,
      focus: args.focus,
      elements: args.elements,
      hotkeys: args.hotkeys,
      output,
    });
    await confirmCapture(server, prompt, extra.signal);
  }

  // GPU encode (#199): auto probes once per process, else libx264. The
  // capture's size rules out a hardware encoder it is too big for (#253);
  // a wgc window's size is only known once its recorder runs.
  const firstPick = await resolveEncoder(
    args.encoder ?? (backend === "ddagrab" ? "auto" : "x264"),
    backend === "ddagrab" ? "ddagrab" : "gdigrab",
    ffmpeg,
    undefined,
    backend === "wgc" ? undefined : frameSize(target, monitors),
  );
  const ddaUsable = async (p: EncoderPick) => !dda || p.gpuFrames || (await ddagrabWorks(ffmpeg));
  if (!(await ddaUsable(firstPick))) {
    throw new ScreencastError("Desktop Duplication (ddagrab) does not capture on this machine (a remote session, or no D3D11 GPU).", 'Use backend "gdigrab".');
  }

  return { ffmpeg, hideCursor, target, monitors, window, backend, replay, fps, quality, maxDurationSec, output, audio, webcamDevice, dda, firstPick, ddaUsable, diskNote: disk.note };
}
/** The video clock's zero, the event log's frame, and the session record,
 * once the capture runs. */
function sessionRecordFor(
  args: StartArgs,
  prep: Awaited<ReturnType<typeof prepareStart>>,
  run: {
    id: string;
    child: ChildProcess;
    watch: CaptureWatch;
    spawnedAt: number;
    captureOpts: unknown;
    webcam: unknown;
    encoder: string;
    evPaths: { raw: string; jsonl: string } | null;
    keyMode: KeyMode;
    webcamRaw?: string;
  },
) {
  const { target, monitors, window, backend, output, fps, quality, maxDurationSec, replay, audio, webcamDevice } = prep;
  // The video clock's zero, for add_marker (#174) and the event log.
  const startMs = captureStartMs(run.watch, backend, run.spawnedAt);
  let frame = args.events ? captureFrame(target, monitors) : null;
  // wgc frames the client area; its size is known once the recorder starts.
  if (backend === "wgc" && frame && window?.client) {
    const m = /wgc: (\d+)x(\d+)/.exec(run.watch.head());
    frame = { x: window.client.x, y: window.client.y, w: m ? Number(m[1]) : frame.w, h: m ? Number(m[2]) : frame.h };
  }
  const record = buildSessionRecord({
    id: run.id,
    target: args.target,
    output,
    fps,
    quality,
    pid: run.child.pid ?? null,
    spawnedAt: run.spawnedAt,
    startMs,
    maxDurationSec,
    window,
    backend,
    encoder: run.encoder,
    ...(run.evPaths ? { events: { jsonl: run.evPaths.jsonl, raw: run.evPaths.raw, keys: run.keyMode, frame } } : {}),
    ...(replay ? { replay } : {}),
    ...(backend !== "wgc" ? { capture: { target, opts: run.captureOpts, ...(run.webcam ? { webcam: run.webcam } : {}) } } : {}),
    ...(webcamDevice && run.webcamRaw
      ? { webcam: { device: webcamDevice, rawPath: run.webcamRaw, startMs: webcamStart(run.watch, !!audio).webcamStartMs, corner: args.webcam?.corner, size: args.webcam?.size, shape: args.webcam?.shape } }
      : {}),
    processImage: backend === "wgc" ? basename(process.execPath).toLowerCase() : "ffmpeg.exe",
    identity: serverIdentity(),
  });
  return { startMs, frame, record };
}

/** Register the child for shutdown first; if the registry write fails, the
 * caller's release() stops the capture rather than leave one nothing can
 * reach (#207). */
function registerSession(store: SessionStore, record: SessionRecord, child: ChildProcess): void {
  store.attachChild(record.id, child);
  try {
    store.create(record);
  } catch (err) {
    store.detachChild(record.id);
    throw new ScreencastError(`Recording stopped: the session registry could not be written (${errorMessage(err)}).`);
  }
}

export function register(server: McpServer): void {
  const tool: RegisteredTool = server.registerTool(
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
    async (args, extra): Promise<CallToolResult> => {
      if (args.startWhen) return armRecording(server, tool, args, extra);
      // Shutdown waits for this call so it can stop what it spawns (#285).
      let release = (): void => {};
      const res = new StartResources();
      try {
        release = beginStart();
        const prep = await prepareStart(server, args, extra);
        const { ffmpeg, hideCursor, target, monitors, window, backend, replay, fps, quality, maxDurationSec, output, audio, webcamDevice, dda, firstPick, ddaUsable } = prep;
        // From here on every resource taken is released by one path on failure.
        res.output = output;
        if (webcamDevice) {
          res.webcamRaw = webcamPartPath(output, 0);
          mkdirSync(partsDir(output), { recursive: true });
        }
        if (replay) {
          prepareReplayDir(replay);
          res.replay = replay;
        }
        // The event logger starts first so the first frames have events (#118).
        // A replay session's raw log lives in its buffer; save_replay slices the
        // window it needs, and the helper rotates it to about the buffer's
        // length however long the session runs (#258).
        const keyMode: KeyMode = args.keys ?? DEFAULT_KEY_MODE;
        const evPaths = args.events ? (replay ? { raw: join(replay.dir, "events.raw"), jsonl: "" } : eventPaths(output)) : null;
        if (evPaths && !replay) prepareEventPaths(evPaths, args.overwrite);
        res.evPaths = evPaths;
        // App logs (#334): note where each file ends now; following starts once
        // the session exists, and reads from these marks.
        const tailer = args.logs ? new LogTailer(args.logs) : null;
        await tailer?.mark();
        // Hotkeys (#337) act once the session exists; a press before that is ignored.
        let onHotkey: (action: HotkeyAction) => void = () => {};
        res.logger = evPaths
          ? await startEventLogger(evPaths.raw, keyMode, {
              ...(replay ? { rotateSec: replayEventRotateSec(replay.bufferSec) } : {}),
              ...(args.focus ? { focus: args.focus } : {}),
              ...(args.elements ? { elements: true } : {}),
              ...(args.hotkeys ? { hotkeys: true, onHotkey: (a: HotkeyAction) => onHotkey(a) } : {}),
            })
          : null;

        const id = `rec-${stamp()}-${rand(6)}`;
        const capture = { id, ffmpeg, backend, target, monitors, window, fps, quality, audio, hideCursor, dda, webcamDevice, webcamRaw: res.webcamRaw, output, maxDurationSec, replay };
        // A hardware encoder that exits during startup is retried once with
        // libx264, and the result says so (#253).
        const started = await startWithEncoderFallback(firstPick, (p) => launchCapture(capture, p), {
          why: (r) => tailLines(r.watch, 3),
          canFallback: () => ddaUsable({ encoder: "x264", gpuFrames: false }),
          beforeRetry: () => {
            if (replay) resetReplaySegments(replay);
          },
        });
        const { run, failure: retried, pick } = started;
        const { child, watch, spawnedAt, captureOpts, webcam } = run;
        if (run.settled === "exited") {
          throw new ScreencastError(
            `Recording failed to start (${backend === "wgc" ? "window capture" : "ffmpeg"} exited immediately):\n${tailLines(watch)}` +
              (retried ? `\n(Retried with libx264 after ${retried})` : ""),
          );
        }
        res.child = child;
        const { startMs, frame, record } = sessionRecordFor(args, prep, { id, child, watch, spawnedAt, captureOpts, webcam, encoder: pick.encoder, evPaths, keyMode, webcamRaw: res.webcamRaw });
        const store = getStore();
        registerSession(store, record, child);
        // The session owns its resources now; finalizers release them.
        res.handOff();
        const logger = res.logger;
        if (logger && evPaths) trackEventLog(store, id, { logger, evPaths, keyMode, startMs, frame, replay, child });
        // Keep the on-disk record consistent if the child dies on its own: a
        // crash is "failed" with the stderr tail, a clean exit the cap or the
        // window closing (#240).
        attachExitHandler(store, id, child, { backend, maxDurationSec, spawnedAt, watch });
        if (args.perf) trackPerf(store, id, { output, startMs, window });
        if (tailer && args.logs) trackLogs(store, id, { tailer, logs: args.logs, output, startMs });
        if (args.hotkeys) onHotkey = hotkeyHandler(store, id);
        if (args.stopWhen) watchStopWhen(store, id, { target: args.target, exactTitle: args.exactTitle, text: args.stopWhen.text });

        return okResponse(
          startResult({
            record,
            audioDevice: audio?.device,
            maxDurationSec,
            encoder: pick.encoder,
            encoderNote: pick.note,
            diskNote: prep.diskNote,
            ...(dda ? { gpuFrames: pick.gpuFrames } : {}),
            webcamDevice,
            window,
            ...(evPaths ? { events: { jsonl: evPaths.jsonl, keys: keyMode } } : {}),
            ...(args.logs ? { logs: { path: logsPath(output), missing: args.logs.some((l) => !existsSync(l.path)) } } : {}),
            ...(args.hotkeys ? { hotkeys: { taken: logger ? hotkeysTaken(logger) : [] } } : {}),
            ...(replay ? { replay: { ...replay, events: !!evPaths } } : {}),
          }),
        );
      } catch (error) {
        await res.release();
        return errorResponse(error);
      } finally {
        release();
      }
    },
  );
}
