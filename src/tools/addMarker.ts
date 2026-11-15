import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { looseOutput } from "../utils/toolSpec.js";
import { assertOutputAllowed } from "../utils/paths.js";
import { cleanLabel, insertMarker, markersPath, readMarkers, writeMarkers, MAX_LABEL } from "../utils/chapters.js";
import { getStore } from "../context.js";
import { addSessionMarker } from "../utils/sessionMarker.js";

/** Adds one marker to the session record and its sidecar: never replaces
 * anything, and each call adds another. */
const ADDS_MARKER: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const inputSchema = {
  label: z.string().min(1).max(MAX_LABEL).describe('e.g. "bug appears".'),
  sessionId: z.string().min(1).optional().describe("Recording to mark (a stopped one needs at)."),
  input: z.string().min(1).optional().describe("Or a video path (needs at)."),
  at: z
    .number()
    .min(0)
    .optional()
    .describe("Video second (default: now, while recording)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "add_marker",
    {
      title: "Add Marker",
      description:
        "Mark a labelled moment on a recording, live or at a second. Kept in the session and a sidecar; " +
        "chapters and pipeline turn markers into chapters.",
      inputSchema,
      outputSchema: looseOutput({ count: z.number().int(), markersPath: z.string() }),
      annotations: ADDS_MARKER,
    },
    async (args) => {
      try {
        if (!args.sessionId && !args.input) throw new ScreencastError("Pass sessionId or input.");
        if (args.sessionId) {
          const res = addSessionMarker(getStore(), args.sessionId, args.label, args.at);
          return okResponse({
            sessionId: args.sessionId,
            marker: { t: Math.round(res.t * 1000) / 1000, label: cleanLabel(args.label) },
            count: res.count,
            markersPath: res.markersPath,
            ...(res.live ? { live: true } : {}),
            ...(res.warning ? { warning: res.warning } : {}),
          });
        }
        const input = args.input!;
        if (args.at === undefined) throw new ScreencastError("Pass at (video seconds) to mark a file.");
        requireInput(input);
        assertOutputAllowed(markersPath(input));
        const markers = insertMarker(readMarkers(input), { t: args.at, label: args.label, at: new Date().toISOString() });
        const path = writeMarkers(input, markers);
        return okResponse({
          marker: { t: Math.round(args.at * 1000) / 1000, label: cleanLabel(args.label) },
          count: markers.length,
          markersPath: path,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
