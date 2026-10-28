import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { STOPS_SESSION, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { probeDuration, stopSession } from "../utils/lifecycle.js";
import { getStore } from "../context.js";

const inputSchema = {
  sessionId: z.string().min(1).describe("Session id returned by start_recording."),
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
        if (record.status !== "recording") {
          return okResponse({
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
        const { record: updated, graceful, durationSec } = await stopSession(store, record, {
          reason: "stopped",
          probe: (path) => probeDuration(ffprobe, path),
        });

        return okResponse({
          sessionId: record.id,
          status: "stopped",
          outputPath: record.outputPath,
          durationSec: durationSec ?? null,
          finalizedGracefully: graceful,
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
