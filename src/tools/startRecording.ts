import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import {
  buildCaptureArgs,
  DEFAULT_FPS,
  DEFAULT_QUALITY,
  DEFAULT_MAX_RECORDING_SEC,
  resolveMaxDuration,
  type Quality,
} from "../utils/targets.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { resolveLoopbackDevice } from "../utils/audioDevices.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { getStore } from "../context.js";
import type { SessionRecord } from "../utils/sessions.js";

const inputSchema = {
  target: z
    .string()
    .describe(
      "Capture target: 'full' | 'monitor:<index>' (0 = primary) | " +
        "'window:<title>' | 'region:<x>,<y>,<w>,<h>' (absolute pixels). " +
        "window: records the on-screen rectangle the window occupies, resolved " +
        "ONCE at start (it must be visible, on top, not minimized); it does not " +
        "follow a window moved or resized mid-recording.",
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
    .optional()
    .describe(
      `Stop automatically after this many seconds, finalizing the file (default ` +
        `${DEFAULT_MAX_RECORDING_SEC}, or SCREENCAST_MAX_RECORDING_SEC). 0 = no cap. ` +
        "A safety net against a recording that is never stopped.",
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
        const { target, monitors } = resolveCaptureTarget(args.target);
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
        const child = spawn(ffmpeg, ffArgs, {
          stdio: ["pipe", "ignore", "pipe"],
          windowsHide: true,
        });

        // Detect an immediate failure (bad window title, busy device, etc.).
        let stderrTail = "";
        child.stderr?.on("data", (d) => {
          stderrTail = (stderrTail + d.toString()).slice(-2000);
        });
        const settled = await new Promise<"running" | "exited">((resolve) => {
          const timer = setTimeout(() => resolve("running"), 1200);
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
          const tail = stderrTail.trim().split("\n").slice(-6).join("\n");
          throw new ScreencastError(
            `Recording failed to start (ffmpeg exited immediately):\n${tail}`,
          );
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
        };
        const store = getStore();
        store.create(record);
        store.attachChild(id, child);
        // Keep the on-disk record consistent if the child dies on its own. A
        // non-zero exit is a crash (disk full, encoder failure), not a clean
        // stop - record it as "failed" with the stderr tail so the caller can
        // tell the two apart. A clean exit nobody requested is the
        // maxDurationSec cap.
        child.on("exit", (code) => {
          const cur = store.get(id);
          // A deliberate stop (stop_recording / shutdown) records its own final
          // state; only an exit nobody asked for is classified here.
          if (cur && cur.status === "recording" && !store.isStopping(id)) {
            if (code !== 0 && code !== null) {
              store.update(id, {
                status: "failed",
                endReason: "crashed",
                stoppedAt: new Date().toISOString(),
                error: `ffmpeg exited with code ${code}:\n${stderrTail
                  .trim()
                  .split("\n")
                  .slice(-6)
                  .join("\n")}`,
              });
            } else {
              // A clean exit with no stop in flight is the -t cap firing (#82).
              store.update(id, {
                status: "stopped",
                endReason: maxDurationSec > 0 ? "max_duration" : "stopped",
                stoppedAt: new Date().toISOString(),
              });
            }
          }
          store.detachChild(id);
        });

        return okResponse({
          sessionId: id,
          status: "recording",
          outputPath: output,
          pid: record.pid,
          fps,
          quality,
          audioDevice: audio?.device ?? null,
          maxDurationSec: maxDurationSec > 0 ? maxDurationSec : null,
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
