import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { eventPaths, prepareEventPaths } from "../utils/events.js";
import { logMessage } from "../utils/logging.js";
import { MAX_REPLAY_SEC, replayDiskBytes, saveReplay } from "../utils/replay.js";
import { getStore } from "../context.js";

const inputSchema = {
  sessionId: z.string().min(1).describe("Session id of a replay buffer."),
  lastSec: z
    .number()
    .positive()
    .max(MAX_REPLAY_SEC)
    .optional()
    .describe("Seconds back from now (default and max: the buffer length)."),
  output: z.string().optional().describe("Output .mp4 path (default under SCREENCAST_HOME/recordings)."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
  reencode: z
    .boolean()
    .optional()
    .describe("Frame-exact re-encode. Default: instant stream copy that may hide up to 2 s of earlier frames."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "save_replay",
    {
      title: "Save Replay",
      description:
        "Save the last N seconds of a replay buffer (start_recording replayBufferSec) to an mp4; the buffer keeps running.",
      inputSchema,
      outputSchema: looseOutput({
        sessionId: z.string(),
        outputPath: z.string(),
        durationSec: z.number(),
      }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        const record = getStore().get(args.sessionId);
        if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
        if (!record.replay) {
          throw new ScreencastError(
            `Session "${args.sessionId}" is not a replay buffer.`,
            "Start one with start_recording { replayBufferSec: 60 }; for an ordinary recording use stop_recording and trim.",
          );
        }
        const { ffmpeg, ffprobe } = requireFfmpeg();
        const buf = record.replay;
        const lastSec = Math.min(args.lastSec ?? buf.bufferSec, buf.bufferSec);
        const output = resolveOutput(args.output, subdir("recordings"), `replay-${stamp()}-${rand()}.mp4`, args.overwrite);
        if (buf.events) prepareEventPaths(eventPaths(output), args.overwrite);
        const started = Date.now();
        const result = await saveReplay(buf, {
          ffmpeg,
          ffprobe,
          lastSec,
          output,
          reencode: args.reencode,
          quality: record.quality,
          live: record.status === "recording",
          signal: extra.signal,
        });
        const elapsedMs = Date.now() - started;
        logMessage("info", `Saved ${result.durationSec}s of replay ${record.id} to ${output}.`, {
          sessionId: record.id,
          outputPath: output,
          durationSec: result.durationSec,
        });
        const short = result.durationSec + 0.25 < lastSec;
        return okResponse({
          sessionId: record.id,
          ...result,
          requestedSec: args.lastSec ?? null,
          bufferSec: buf.bufferSec,
          bufferRunning: record.status === "recording",
          bufferDiskBytes: replayDiskBytes(buf),
          elapsedMs,
          note:
            (args.lastSec !== undefined && args.lastSec > buf.bufferSec
              ? `Capped at the buffer length (${buf.bufferSec}s). `
              : "") +
            (short ? "The buffer held less footage than requested (it started recently). " : "") +
            (result.includesLive ? "" : "The clip ends at the last completed segment, up to 2 s before now. ") +
            (record.status === "recording"
              ? "The buffer keeps running; stop_recording discards it unless save: true."
              : "This buffer is no longer recording; stop_recording discards it."),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
