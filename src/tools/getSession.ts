import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { isAlive } from "../utils/sessions.js";
import { getStore } from "../context.js";

const inputSchema = {
  sessionId: z.string().min(1).describe("Session id returned by start_recording."),
};

export function register(server: McpServer): void {
  server.tool(
    "get_session",
    "Inspect a single recording session by id, including live status and " +
      "whether its output file exists on disk.",
    inputSchema,
    async (args) => {
      try {
        const record = getStore().get(args.sessionId);
        if (!record) {
          throw new ScreencastError(`No session with id "${args.sessionId}".`);
        }
        return okResponse({
          ...record,
          alive: record.status === "recording" && isAlive(record.pid),
          fileExists: existsSync(record.outputPath),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
