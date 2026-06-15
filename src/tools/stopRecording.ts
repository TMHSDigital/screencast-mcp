import { z } from "zod";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runCapture } from "../utils/ffmpeg.js";
import { buildProbeArgs, parseMediaInfo } from "../utils/media.js";
import { isAlive, isFfmpegProcess, killPid } from "../utils/sessions.js";
import { getStore } from "../context.js";

const inputSchema = {
  sessionId: z.string().min(1).describe("Session id returned by start_recording."),
};

/** Wait up to ms for a child to exit; resolve true if it did. */
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function probeDuration(ffprobe: string, path: string): Promise<number | null> {
  if (!existsSync(path)) return null;
  try {
    const res = await runCapture(ffprobe, buildProbeArgs(path), 30_000);
    if (res.code !== 0) return null;
    return parseMediaInfo(JSON.parse(res.stdout)).durationSec;
  } catch {
    return null;
  }
}

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
            note: "Session was not active; returning its recorded final state.",
          });
        }

        const { ffprobe } = requireFfmpeg();
        let graceful = false;
        const child = store.getChild(record.id);

        if (child && child.stdin && child.stdin.writable) {
          // ffmpeg quits cleanly (and writes the moov atom) on 'q'.
          child.stdin.write("q\n");
          child.stdin.end();
          graceful = await waitForExit(child, 8000);
          if (!graceful && record.pid !== null) killPid(record.pid);
        } else if (record.pid !== null && isAlive(record.pid)) {
          // Cross-restart stop: no stdin handle. Terminate by pid. The
          // fragmented-mp4 muxing keeps the partial file playable.
          if (isFfmpegProcess(record.pid)) killPid(record.pid);
        }
        store.detachChild(record.id);

        // Give the muxer a moment to flush the trailer.
        await new Promise((r) => setTimeout(r, 400));
        const durationSec = await probeDuration(ffprobe, record.outputPath);

        const updated = store.update(record.id, {
          status: "stopped",
          stoppedAt: new Date().toISOString(),
          durationSec: durationSec ?? undefined,
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
