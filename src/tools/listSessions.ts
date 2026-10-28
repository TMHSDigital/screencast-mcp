import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { isAlive } from "../utils/sessions.js";
import { getStore } from "../context.js";

export function register(server: McpServer): void {
  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "List all recording sessions (active and finished) with their status, " +
        "target, output path, and whether the process is still alive.",
      inputSchema: {},
      outputSchema: looseOutput({
        count: z.number().int(),
        sessions: z.array(looseOutput({ id: z.string(), status: z.string(), outputPath: z.string(), alive: z.boolean() })),
      }),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const sessions = getStore()
          .list()
          .map((s) => ({ ...s, alive: s.status === "recording" && isAlive(s.pid) }));
        return okResponse({ count: sessions.length, sessions });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
