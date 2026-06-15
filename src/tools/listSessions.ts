import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { isAlive } from "../utils/sessions.js";
import { getStore } from "../context.js";

export function register(server: McpServer): void {
  server.tool(
    "list_sessions",
    "List all recording sessions (active and finished) with their status, " +
      "target, output path, and whether the process is still alive.",
    {},
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
