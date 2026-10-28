import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { resumeSession } from "../utils/recorder.js";
import { logMessage } from "../utils/logging.js";
import { recordedSec } from "../utils/pause.js";
import { getStore } from "../context.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function register(server: McpServer): void {
  server.registerTool(
    "resume_recording",
    {
      title: "Resume Recording",
      description: "Resume a paused recording (same target and settings).",
      inputSchema: { sessionId: z.string().min(1).describe("From start_recording.") },
      outputSchema: looseOutput({ sessionId: z.string(), status: z.string(), recordedSec: z.number() }),
      annotations: WRITES_FILE,
    },
    async (args) => {
      try {
        const store = getStore();
        const record = store.get(args.sessionId);
        if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
        if (record.status === "recording") {
          return okResponse({
            sessionId: record.id,
            status: "recording",
            recordedSec: r3(recordedSec(record.segments?.parts ?? [])),
            note: "Already recording.",
          });
        }
        const { ffmpeg } = requireFfmpeg();
        // Resuming continues the capture the user approved at start (same
        // target, settings, and cap), so it is not asked again.
        const res = await resumeSession(store, record, ffmpeg);
        logMessage("notice", `Recording ${record.id} resumed.`, { sessionId: record.id });
        return okResponse({
          sessionId: record.id,
          status: "recording",
          recordedSec: r3(res.recordedSec),
          pid: res.record.pid,
          ...(res.capSec > 0 ? { remainingSec: res.capSec } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
