import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { STOPS_SESSION, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { pauseSession, probeDuration } from "../utils/lifecycle.js";
import { recordedSec } from "../utils/pause.js";
import { getStore } from "../context.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function register(server: McpServer): void {
  server.registerTool(
    "pause_recording",
    {
      title: "Pause Recording",
      description:
        "Pause a recording; until resume_recording nothing is captured, and the gap is left out of the file, events, and markers.",
      inputSchema: { sessionId: z.string().min(1).describe("From start_recording.") },
      outputSchema: looseOutput({ sessionId: z.string(), status: z.string(), recordedSec: z.number() }),
      annotations: STOPS_SESSION,
    },
    async (args) => {
      try {
        const store = getStore();
        const record = store.get(args.sessionId);
        if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
        if (record.status === "paused") {
          return okResponse({
            sessionId: record.id,
            status: "paused",
            recordedSec: r3(recordedSec(record.segments?.parts ?? [])),
            note: "Already paused.",
          });
        }
        const { ffprobe } = requireFfmpeg();
        const res = await pauseSession(store, record, { probe: (p) => probeDuration(ffprobe, p) });
        return okResponse({
          sessionId: record.id,
          status: "paused",
          recordedSec: r3(res.recordedSec),
          segments: res.record?.segments?.parts.length ?? 0,
          note: "Nothing is captured until resume_recording; stop_recording joins what was recorded.",
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
