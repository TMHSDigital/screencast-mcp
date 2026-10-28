import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import {
  EVENT_TYPES,
  eventPaths,
  parseEventsJsonl,
  selectEvents,
  summarizeEvents,
  eventGaps,
} from "../utils/events.js";
import { getStore } from "../context.js";

/** Events returned per call unless the caller asks for more. */
export const DEFAULT_EVENT_LIMIT = 200;
export const MAX_EVENT_LIMIT = 5000;

const inputSchema = {
  sessionId: z.string().min(1).optional().describe("Session id of a recording started with events: true."),
  input: z
    .string()
    .optional()
    .describe("Or a recording path (its sibling .events.jsonl is read) or the .events.jsonl itself."),
  from: z.number().min(0).optional().describe("Only events at or after this video time, in seconds."),
  to: z.number().min(0).optional().describe("Only events at or before this video time, in seconds."),
  types: z
    .array(z.enum(EVENT_TYPES))
    .optional()
    .describe(
      "Only these types: down / up (mouse buttons), move (sampled cursor), wheel, key (a named shortcut), " +
        "typing (a burst of typing: start and length only), gap (events may be missing). Clicks are down.",
    ),
  inFrameOnly: z.boolean().optional().describe("Drop events whose cursor was outside the recorded area."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_EVENT_LIMIT)
    .optional()
    .describe(`Most events to return (default ${DEFAULT_EVENT_LIMIT}); the result says when more matched.`),
};

export function register(server: McpServer): void {
  server.registerTool(
    "read_events",
    {
      title: "Read Input Events",
      description:
        "Read the input event log of a recording made with start_recording events: true: " +
        "mouse clicks, scroll, cursor positions, shortcuts, and typing bursts, each with its video " +
        "time in seconds and position in video pixels. Filter by time range and type, " +
        "e.g. types: ['down'] for the clicks, then sample_frames at those times.",
      inputSchema,
      outputSchema: looseOutput({
        eventsPath: z.string(),
        total: z.number().int(),
        matched: z.number().int(),
        returned: z.number().int(),
        summary: z.record(z.string(), z.number()),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        let path: string;
        if (args.sessionId) {
          const record = getStore().get(args.sessionId);
          if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
          if (!record.events) {
            throw new ScreencastError(
              `Session "${args.sessionId}" was recorded without an event log. ` +
                "Start the recording with events: true.",
            );
          }
          if (record.status === "recording") {
            throw new ScreencastError("The recording is still running; its event log is written when it stops.");
          }
          path = record.events.path;
        } else if (args.input) {
          path = args.input.endsWith(".jsonl") ? args.input : eventPaths(args.input).jsonl;
        } else {
          throw new ScreencastError("Pass sessionId or input.");
        }
        if (!existsSync(path)) {
          throw new ScreencastError(`No event log at ${path}. Record with start_recording events: true.`);
        }
        const all = parseEventsJsonl(readFileSync(path, "utf8"));
        const matched = selectEvents(all, args);
        const limit = args.limit ?? DEFAULT_EVENT_LIMIT;
        const gaps = eventGaps(all);
        return okResponse({
          eventsPath: path,
          total: all.length,
          matched: matched.length,
          returned: Math.min(limit, matched.length),
          summary: summarizeEvents(all),
          ...(gaps.length > 0
            ? {
                truncated: true,
                gaps,
                warning:
                  "The log is missing events in the gaps listed: Windows removed the input hook, input went to an " +
                  "elevated window or the lock screen, or the helper stopped. Do not read silence there as no activity.",
              }
            : {}),
          events: matched.slice(0, limit),
          ...(matched.length > limit
            ? { note: `${matched.length - limit} more matched; narrow from/to or types, or raise limit.` }
            : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
