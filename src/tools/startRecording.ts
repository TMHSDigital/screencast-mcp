import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, wgcAvailable } from "../utils/ffmpeg.js";
import { fileURLToPath } from "node:url";
import {
  buildCaptureArgs,
  captureFrame,
  resolveQuality,
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
import { resolveLoopbackDevice } from "../utils/audioDevices.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { getStore } from "../context.js";
import { classifyUnrequestedExit, killPid, type SessionRecord } from "../utils/sessions.js";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import {
  DEFAULT_KEY_MODE,
  eventPaths,
  parseCaptureStart,
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
      "Capture target: 'full' | 'monitor:<index>' (0 = primary) | " +
        "'window:<title>' (or window:exe=<app.exe> / window:hwnd=<handle>, without relying on the title) | 'region:<x>,<y>,<w>,<h>' (absolute pixels). " +
        "window: records the on-screen rectangle the window occupies, resolved " +
        "ONCE at start (it must be visible, on top, not minimized); it does not " +
        "follow a window moved or resized mid-recording.",
    ),
  exactTitle: z
    .boolean()
    .optional()
    .describe(
      "For window: targets, match only a window whose title equals the given " +
        "title (case-insensitive); never fall back to a substring match. Default false.",
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
        .describe("system captures what is playing on the machine; none is video-only."),
      device: z
        .string()
        .optional()
        .describe(
          "Optional dshow loopback device name (from list_audio_devices). When " +
            "omitted, a loopback device is auto-detected.",
        ),
    })
    .optional()
    .describe(
      "Audio capture (default none, video-only). source 'system' needs a " +
        "loopback device; microphone capture is not supported.",
    ),
  output: z
    .string()
    .optional()
    .describe(
      "Optional output .mp4 path. Defaults to a file under SCREENCAST_HOME/recordings.",
    ),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
  maxDurationSec: z
    .number()
    .int()
    .min(0)
    .max(MAX_RECORDING_CAP_SEC)
    .optional()
    .describe(
      `Stop automatically after this many seconds, finalizing the file (default ` +
        `${DEFAULT_MAX_RECORDING_SEC}, or SCREENCAST_MAX_RECORDING_SEC; at most ${MAX_RECORDING_CAP_SEC}, 7 days). 0 = no cap. ` +
        "A safety net against a recording that is never stopped.",
    ),
  events: z
    .boolean()
    .optional()
    .describe(
      "Also log mouse clicks, scroll, cursor positions, and typing to " +
        "<recording>.events.jsonl, timed to the video and in video pixels (default " +
        "false). Read it with read_events. Adds about a second to start.",
    ),
  keys: z
    .enum(["masked", "shortcuts"])
    .optional()
    .describe(
      "With events: masked (default) logs typing only as bursts (start and length on a 0.5 s grid), " +
        "never which keys or when each one was pressed. shortcuts also names chords made with Ctrl, Alt, " +
        "or Win (e.g. Ctrl+S), with their times; typed text is never logged.",
    ),
  backend: z
    .enum(["gdigrab", "wgc"])
    .optional()
    .describe(
      "gdigrab (default) records the screen rectangle. wgc (window: targets, FFmpeg 8+) records the " +
        "window's own surface through Windows Graphics Capture: it keeps recording the window when " +
        "it is covered, moved, or in the background, and frames only its client area. No audio with wgc.",
    ),
};

export function register(server: McpServer): void {
  server.tool(
    "start_recording",
    "Start a screen recording (Windows gdigrab) as a background ffmpeg process. " +
      "Returns a session id and output path. Recording is explicit and never " +
      "auto-starts. Use stop_recording with the id to finalize the file. " +
      "Audio is video-only by default; set audio.source = 'system' to also " +
      "capture system (loopback) audio. Microphone capture is not supported.",
    inputSchema,
    async (args) => {
      try {
        const { ffmpeg } = requireFfmpeg();
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

        const ffArgs = buildCaptureArgs(target, {
          fps,
          quality,
          output,
          monitors,
          audio,
          maxDurationSec,
        });
        // The event logger starts first so the first frames have events (#118).
        const keyMode: KeyMode = args.keys ?? DEFAULT_KEY_MODE;
        const evPaths = args.events ? eventPaths(output) : null;
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
                  JSON.stringify({ ffmpeg, hwnd: window!.hwnd, fps, encode: [...resolveQuality(quality), ...captureKeyframeArgs(fps)], output, maxDurationSec }),
                ],
                { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
              )
            : spawn(ffmpeg, ffArgs, {
                stdio: ["pipe", "ignore", "pipe"],
                windowsHide: true,
              });

        // Detect an immediate failure (bad window title, busy device, etc.).
        // The head keeps the input banner, whose start: time aligns events.
        let stderrTail = "";
        let stderrHead = "";
        child.stderr?.on("data", (d) => {
          const text = d.toString();
          stderrTail = (stderrTail + text).slice(-2000);
          if (stderrHead.length < 8000) stderrHead += text;
        });
        // gdigrab is running once it survives a moment; the wgc recorder says
        // so when its first frame is written (a repaint can take a second).
        const settled = await new Promise<"running" | "exited">((resolve) => {
          const timer = setTimeout(() => resolve("running"), backend === "wgc" ? 15_000 : 1200);
          if (backend === "wgc") {
            child.stderr?.on("data", () => {
              if (parseCaptureStart(stderrHead) !== null) {
                clearTimeout(timer);
                resolve("running");
              }
            });
          }
          child.on("error", (err) => {
            clearTimeout(timer);
            stderrTail += `\n${err.message}`;
            resolve("exited");
          });
          child.on("exit", () => {
            clearTimeout(timer);
            resolve("exited");
          });
        });

        const id = `rec-${stamp()}-${rand(6)}`;
        if (settled === "exited") {
          if (logger) await stopEventLogger(logger);
          if (evPaths) rmSync(evPaths.raw, { force: true });
          const tail = stderrTail.trim().split("\n").slice(-6).join("\n");
          throw new ScreencastError(
            `Recording failed to start (${backend === "wgc" ? "window capture" : "ffmpeg"} exited immediately):\n${tail}`,
          );
        }
        if (backend === "wgc" && frame && window?.client) {
          const m = /wgc: (\d+)x(\d+)/.exec(stderrHead);
          frame = { x: window.client.x, y: window.client.y, w: m ? Number(m[1]) : frame.w, h: m ? Number(m[2]) : frame.h };
        }

        const record: SessionRecord = {
          id,
          target: args.target,
          outputPath: output,
          fps,
          quality,
          pid: child.pid ?? null,
          serverPid: process.pid,
          status: "recording",
          startedAt: new Date().toISOString(),
          ...(maxDurationSec > 0 ? { maxDurationSec } : {}),
          ...(window ? { matchedWindow: window.matchedTitle } : {}),
          ...(evPaths ? { events: { path: evPaths.jsonl, keys: keyMode } } : {}),
          backend,
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
          throw new ScreencastError(
            `Recording stopped: the session registry could not be written (${(err as Error).message}).`,
          );
        }
        if (logger && evPaths && frame) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          trackFinalizer(
            id,
            exited.then(async () => {
              await stopEventLogger(logger);
              const startMs = parseCaptureStart(stderrHead) ?? spawnedAt;
              try {
                const events = writeEventsFile(evPaths, { startMs, frame, endSec: (Date.now() - startMs) / 1000 });
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
        // Keep the on-disk record consistent if the child dies on its own. A
        // non-zero exit is a crash (disk full, encoder failure), not a clean
        // stop - record it as "failed" with the stderr tail so the caller can
        // tell the two apart. A clean exit nobody requested is the
        // maxDurationSec cap, or the recorded window closing (#240).
        child.on("exit", (code) => {
          store.detachChild(id);
          const cur = store.get(id);
          // A deliberate stop (stop_recording / shutdown) records its own final
          // state; only an exit nobody asked for is classified here.
          if (!cur || cur.status !== "recording" || store.isStopping(id)) return;
          const verdict = classifyUnrequestedExit({ code, backend, maxDurationSec, elapsedMs: Date.now() - spawnedAt });
          store.tryUpdate(id, {
            ...verdict,
            stoppedAt: new Date().toISOString(),
            ...(verdict.status === "failed"
              ? { error: `${backend === "wgc" ? "The window recorder" : "ffmpeg"} exited with code ${code}:\n${stderrTail.trim().split("\n").slice(-6).join("\n")}` }
              : {}),
          });
        });

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
          ...(window ? windowMatchReport(window) : {}),
          ...(evPaths ? { eventsPath: evPaths.jsonl, keys: keyMode } : {}),
          note:
            "Call stop_recording with this sessionId to finalize the file." +
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
