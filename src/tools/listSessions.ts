import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { isAlive } from "../utils/sessions.js";
import { listArms } from "../utils/triggers.js";
import { getStore } from "../context.js";

export function register(server: McpServer): void {
  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "List recording sessions, newest first: id, status, target, output path, duration, and whether the " +
        "recorder is alive. A summary each unless full; get_session gives one in full.",
      inputSchema: {
        status: z.array(z.enum(["recording", "paused", "stopped", "failed", "orphaned"])).min(1).optional().describe("Only these."),
        limit: z.number().int().min(1).max(100).optional().describe("At most this many (default all)."),
        query: z.string().min(1).max(80).optional().describe("In label, id, target or output."),
        full: z.boolean().optional().describe("Whole records."),
      },
      outputSchema: looseOutput({
        count: z.number().int(),
        sessions: z.array(looseOutput({ id: z.string(), status: z.string(), outputPath: z.string(), alive: z.boolean() })),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const all = getStore().list();
        const q = args.query?.toLowerCase();
        const picked = all
          .filter((s) => !args.status || args.status.includes(s.status))
          .filter((s) => !q || [s.label, s.id, s.target, s.outputPath].some((v) => v?.toLowerCase().includes(q)))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, args.limit ?? Infinity);
        // A summary by default (#366): a full record carries segments,
        // markers, sidecar summaries and the capture plan, and a hundred of
        // them is tens of KB in the model's context.
        const sessions = picked.map((s) => {
          // A paused session has no capture process; its server's is what matters.
          const alive = s.status === "recording" ? isAlive(s.pid) : s.status === "paused" ? isAlive(s.serverPid ?? null) : false;
          if (args.full) return { ...s, alive };
          return {
            id: s.id,
            ...(s.label ? { label: s.label } : {}),
            status: s.status,
            target: s.target,
            outputPath: s.outputPath,
            startedAt: s.startedAt,
            ...(s.stoppedAt ? { stoppedAt: s.stoppedAt } : {}),
            durationSec: s.durationSec ?? null,
            ...(s.endReason ? { endReason: s.endReason } : {}),
            ...(s.error ? { error: s.error.split("\n")[0] } : {}),
            alive,
          };
        });
        // Triggered recordings still waiting, and what earlier ones became (#336).
        const armed = listArms();
        return okResponse({
          count: sessions.length,
          ...(sessions.length < all.length ? { total: all.length } : {}),
          sessions,
          ...(armed.length ? { armed } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
