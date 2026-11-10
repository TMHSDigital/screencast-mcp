import { z } from "zod";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage, errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { DELETES_FILE, looseOutput } from "../utils/toolSpec.js";
import { getStore } from "../context.js";
import { isLive } from "../utils/sessions.js";
import { samePath } from "../utils/recordingIndex.js";
import { assertDeleteAllowed, recordingSidecars } from "../utils/recordingFiles.js";
import { subdir } from "../utils/paths.js";
import { CONFIRM_TIMEOUT_MS, confirmCaptureEnabled, CONFIRM_CAPTURE_ENV } from "../utils/consent.js";

const inputSchema = {
  sessionId: z.string().min(1).optional().describe("Session id of the recording to delete."),
  input: z.string().min(1).optional().describe("Or the recording's path."),
};

/** Size of a file or a folder tree, 0 when it is gone. */
function sizeOf(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((n, name) => n + sizeOf(resolve(path, name)), 0);
  } catch {
    return 0;
  }
}

/** Ask the user before deleting when the client can ask. A client that cannot
 * is refused only when SCREENCAST_CONFIRM_CAPTURE asks for every confirmation;
 * otherwise the tool's destructiveHint lets the client gate the call. */
async function confirmDelete(server: McpServer, message: string, signal: AbortSignal): Promise<boolean> {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    if (confirmCaptureEnabled()) {
      throw new ScreencastError(
        `Not deleted: ${CONFIRM_CAPTURE_ENV} requires the user to confirm, but this client does not support MCP elicitation.`,
      );
    }
    return false;
  }
  let action: string;
  try {
    ({ action } = await server.server.elicitInput(
      { message, requestedSchema: { type: "object", properties: {} } },
      { signal, timeout: CONFIRM_TIMEOUT_MS },
    ));
  } catch (err) {
    throw new ScreencastError(`Not deleted: the confirmation request failed (${errorMessage(err)}).`);
  }
  if (action !== "accept") throw new ScreencastError(`Not deleted: ${action === "decline" ? "declined" : "cancelled"} by the user.`);
  return true;
}

export function register(server: McpServer): void {
  server.registerTool(
    "delete_recording",
    {
      title: "Delete Recording",
      description:
        "Delete a finished recording with its sidecars (event log, webcam, transcript, index, markers, pause parts) " +
        "and registry entries; reports bytes freed. Asks the user first when the client supports it. Edits made from it are kept.",
      inputSchema,
      outputSchema: looseOutput({
        outputPath: z.string(),
        deleted: z.array(z.string()),
        bytesFreed: z.number(),
        sessionsRemoved: z.array(z.string()),
      }),
      annotations: DELETES_FILE,
    },
    async (args, extra) => {
      try {
        if (!!args.sessionId === !!args.input) throw new ScreencastError("Give exactly one of sessionId or input.");
        const store = getStore();
        let video: string;
        if (args.sessionId) {
          const record = store.get(args.sessionId);
          if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
          video = record.outputPath;
        } else {
          video = resolve(args.input!);
        }
        assertDeleteAllowed(video);
        const sessions = store.list().filter((r) => samePath(r.outputPath, video));
        const live = sessions.find((r) => isLive(r.status));
        if (live) throw new ScreencastError(`Recording ${live.id} is still ${live.status}; stop it first.`);
        let siblings: string[] = [];
        try {
          siblings = readdirSync(dirname(video));
        } catch {
          /* the folder is gone */
        }
        const side = recordingSidecars(video, siblings, subdir("edits"));
        const targets = [video, ...side.files, ...side.dirs].filter((p) => existsSync(p));
        if (targets.length === 0 && sessions.length === 0) throw new ScreencastError(`Nothing to delete: ${video} does not exist.`);
        const asked = await confirmDelete(
          server,
          `Delete ${video} and ${targets.length - (existsSync(video) ? 1 : 0)} sidecar file(s)? This cannot be undone.`,
          extra.signal,
        );

        let bytesFreed = 0;
        const deleted: string[] = [];
        const failed: string[] = [];
        for (const p of targets) {
          const size = sizeOf(p);
          try {
            rmSync(p, { recursive: true, force: true });
            deleted.push(p);
            bytesFreed += size;
          } catch (err) {
            failed.push(`${p}: ${errorMessage(err)}`);
          }
        }
        const removedIds = existsSync(video) ? [] : sessions.map((r) => r.id);
        if (removedIds.length > 0) store.remove(removedIds);
        return okResponse({
          outputPath: video,
          deleted,
          bytesFreed,
          sessionsRemoved: removedIds,
          confirmedByUser: asked,
          ...(failed.length > 0 ? { failed, note: "Some files could not be deleted (in use?); the registry entry was kept if the recording remains." } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
