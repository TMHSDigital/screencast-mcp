import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { looseOutput } from "../utils/toolSpec.js";
import { assertOutputAllowed } from "../utils/paths.js";
import {
  cleanLabel,
  insertMarker,
  markerTimeSec,
  markersPath,
  readMarkers,
  writeMarkers,
  MAX_LABEL,
  type Marker,
} from "../utils/chapters.js";
import { getStore } from "../context.js";

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
          const store = getStore();
          const record = store.get(args.sessionId);
          if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
          let t = args.at;
          if (t === undefined) {
            if (record.status !== "recording") {
              throw new ScreencastError(
                `Session "${args.sessionId}" is ${record.status}, so there is no "now" to mark.`,
                "Pass at (video seconds) to mark a stopped recording.",
              );
            }
            t = markerTimeSec(record.videoStartMs ?? Date.parse(record.startedAt), Date.now());
          } else if (record.durationSec != null && t > record.durationSec) {
            throw new ScreencastError(`at ${t}s is past the end of the recording (${record.durationSec}s).`);
          }
          const marker: Marker = { t, label: args.label, at: new Date().toISOString() };
          // Patch only the markers field: the registry merges field by field,
          // so a stop or event-log update meanwhile is kept (#235).
          const markers = insertMarker(record.markers ?? [], marker);
          store.update(args.sessionId, { markers });
          let sidecar = markersPath(record.outputPath);
          let warning: string | undefined;
          try {
            sidecar = writeMarkers(record.outputPath, markers, args.sessionId);
          } catch (err) {
            warning = `Saved in the session, but the sidecar ${sidecar} could not be written: ${(err as Error).message}`;
          }
          return okResponse({
            sessionId: args.sessionId,
            marker: { t: Math.round(t * 1000) / 1000, label: cleanLabel(args.label) },
            count: markers.length,
            markersPath: sidecar,
            ...(record.status === "recording" ? { live: true } : {}),
            ...(warning ? { warning } : {}),
          });
        }
        const input = args.input!;
        if (args.at === undefined) throw new ScreencastError("Pass at (video seconds) to mark a file.");
        if (!existsSync(input)) throw new ScreencastError(`Input file not found: ${input}`);
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
