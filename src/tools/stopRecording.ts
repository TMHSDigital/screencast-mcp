import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { STOPS_SESSION, looseOutput } from "../utils/toolSpec.js";
import { probeMedia, requireFfmpeg } from "../utils/ffmpeg.js";
import { probeDuration, stopSession } from "../utils/lifecycle.js";
import { getStore } from "../context.js";
import { finishReplay, type ReplayStopResult } from "../utils/replay.js";
import { webcamPlacement, type WebcamInfo } from "../utils/pause.js";

/** A replay buffer's fate, for the stop result (#197). */
function replayReport(r: ReplayStopResult): Record<string, unknown> {
  return {
    saved: r.saved,
    discarded: r.discarded,
    ...(r.save ? { durationSec: r.save.durationSec, eventsPath: r.save.eventsPath } : {}),
    ...(r.error ? { error: r.error, note: "The buffer was kept; call stop_recording with save: true again, or save_replay." } : {}),
  };
}

/** The aligned webcam file and where overlay would put it (#200). */
async function webcamReport(cam: WebcamInfo, output: string): Promise<Record<string, unknown>> {
  if (cam.error || !existsSync(cam.path)) return { error: cam.error ?? `No webcam file was written (${cam.path}).` };
  const size = async (p: string) => {
    try {
      const info = await probeMedia(p);
      return info.width && info.height ? { width: info.width, height: info.height } : null;
    } catch {
      return null;
    }
  };
  const [screen, camSize] = await Promise.all([size(output), size(cam.path)]);
  // A circle is the centre square of the camera, sized by its height.
  const circle = cam.shape === "circle";
  const place = screen && camSize ? webcamPlacement(screen, circle ? { width: 1, height: 1 } : camSize, cam.corner, cam.size) : null;
  return {
    path: cam.path,
    ...(place
      ? {
          overlay: {
            input: output,
            overlay: cam.path,
            x: place.x,
            y: place.y,
            ...(circle ? { height: place.height, shape: "circle" } : { width: place.width }),
          },
          note: "Aligned with the recording: pass `overlay` to the overlay tool (any corner or size works).",
        }
      : {}),
  };
}

const inputSchema = {
  sessionId: z.string().min(1).describe("Session id returned by start_recording."),
  save: z
    .boolean()
    .optional()
    .describe("Replay buffer: write it all to outputPath first (default: discard)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "stop_recording",
    {
      title: "Stop Recording",
      description:
        "Stop a recording gracefully so the file is finalized; returns the path and duration.",
      inputSchema,
      outputSchema: looseOutput({
        sessionId: z.string(),
        status: z.string(),
        outputPath: z.string(),
        durationSec: z.number().nullable(),
      }),
      annotations: STOPS_SESSION,
    },
    async (args) => {
      try {
        const store = getStore();
        const record = store.get(args.sessionId);
        if (!record) {
          throw new ScreencastError(`No session with id "${args.sessionId}".`);
        }
        if (record.status !== "recording" && record.status !== "paused") {
          // A replay buffer outlives a session that ended on its own (the
          // maxDurationSec cap) until it is saved or discarded here (#197).
          const replay =
            record.replay && existsSync(record.replay.dir)
              ? await finishReplay(record.replay, {
                  save: args.save ?? false,
                  output: record.outputPath,
                  quality: record.quality,
                  tools: requireFfmpeg,
                })
              : undefined;
          return okResponse({
            ...(replay ? { replay: replayReport(replay) } : {}),
            sessionId: record.id,
            status: record.status,
            outputPath: record.outputPath,
            durationSec: record.durationSec ?? null,
            endReason: record.endReason ?? null,
            note:
              record.endReason === "max_duration"
                ? `Recording already ended at its maxDurationSec cap (${record.maxDurationSec}s).`
                : record.endReason === "window_closed"
                  ? "Recording already ended: the recorded window was closed."
                  : "Session was not active; returning its recorded final state.",
          });
        }

        const { ffprobe } = requireFfmpeg();
        const { record: updated, graceful, durationSec, replay, segments } = await stopSession(store, record, {
          reason: "stopped",
          probe: (path) => probeDuration(ffprobe, path),
          saveReplay: args.save,
        });

        return okResponse({
          sessionId: record.id,
          status: "stopped",
          outputPath: record.outputPath,
          durationSec: durationSec ?? null,
          finalizedGracefully: graceful,
          ...(replay ? { replay: replayReport(replay) } : {}),
          ...(segments && segments.count > 1 ? { segmentsJoined: segments.count } : {}),
          ...(segments?.error ? { segmentsError: segments.error } : {}),
          ...(updated?.webcam ? { webcam: await webcamReport(updated.webcam, record.outputPath) } : {}),
          ...(updated?.events
            ? { eventsPath: updated.events.path, events: updated.events.summary ?? {}, ...(updated.events.error ? { eventsError: updated.events.error } : {}) }
            : {}),
          fileExists: existsSync(record.outputPath),
          note: graceful
            ? "ffmpeg quit cleanly; file finalized."
            : "Process terminated by pid; fragmented mp4 keeps the file playable.",
          record: updated,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
