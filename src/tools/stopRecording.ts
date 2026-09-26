import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { probeDuration, stopSession } from "../utils/lifecycle.js";
import { getStore } from "../context.js";

const inputSchema = {
  sessionId: z.string().min(1).describe("Session id returned by start_recording."),
};

export function register(server: McpServer): void {
  server.tool(
    "stop_recording",
    "Stop a recording by session id. Sends ffmpeg a graceful quit so the file " +
      "is finalized rather than truncated, then returns the final path and " +
      "duration. Falls back to terminating the process by pid if the live " +
      "handle was lost (for example after a server restart).",
    inputSchema,
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
