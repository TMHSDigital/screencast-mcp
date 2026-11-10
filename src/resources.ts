/**
 * MCP resources (#126): recording sessions as resources a client can list,
 * read, and attach, without a filesystem tool.
 *
 *   screencast://sessions               every session (JSON)
 *   screencast://sessions/{id}          one session's record (JSON)
 *   screencast://sessions/{id}/poster   a JPEG preview frame of its recording
 *
 * Clients are told when the list changes (a recording starts or stops), and
 * a client that subscribes to the list or one session gets resources/updated
 * when its content changes (#324).
 */
import { existsSync, rmSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getStore, isShuttingDown } from "./context.js";
import { ScreencastError } from "./utils/errors.js";
import { runFfmpeg, probeMedia } from "./utils/ffmpeg.js";
import { encodeInlineImages } from "./utils/images.js";
import { tempPath } from "./utils/paths.js";

const json = (uri: string, value: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
});

function sessionOrThrow(id: string) {
  const s = getStore().get(id);
  if (!s) throw new ScreencastError(`No session with id ${id}.`);
  return s;
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "sessions",
    "screencast://sessions",
    {
      title: "Recording sessions",
      description: "Every recording session (active and finished), newest first.",
      mimeType: "application/json",
    },
    (uri) => json(uri.href, getStore().list()),
  );

  server.registerResource(
    "session",
    new ResourceTemplate("screencast://sessions/{id}", {
      list: () => ({
        resources: getStore().list().map((s) => ({
          uri: `screencast://sessions/${s.id}`,
          name: s.id,
          title: `${s.status}: ${s.target}`,
          description: `${s.target} -> ${s.outputPath}`,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Recording session", description: "One session's record.", mimeType: "application/json" },
    (uri, { id }) => {
      const s = sessionOrThrow(String(id));
      return json(uri.href, { ...s, fileExists: existsSync(s.outputPath) });
    },
  );

  server.registerResource(
    "session-poster",
    new ResourceTemplate("screencast://sessions/{id}/poster", { list: undefined }),
    {
      title: "Recording preview",
      description: "A JPEG frame from the middle of a session's recording.",
      mimeType: "image/jpeg",
    },
    async (uri, { id }) => {
      const s = sessionOrThrow(String(id));
      if (!existsSync(s.outputPath)) throw new ScreencastError(`Recording file not found: ${s.outputPath}`);
      const { durationSec } = await probeMedia(s.outputPath);
      const frame = tempPath(".png");
      try {
        await runFfmpeg(["-y", "-v", "error", "-ss", String((durationSec ?? 0) / 2), "-i", s.outputPath, "-frames:v", "1", frame], 30_000);
        const [image] = (await encodeInlineImages([frame], 960, 1)).images;
        if (!image) throw new ScreencastError(`Could not extract a thumbnail frame from ${s.outputPath}`);
        return { contents: [{ uri: uri.href, mimeType: image.mimeType, blob: image.data }] };
      } finally {
        rmSync(frame, { force: true });
      }
    },
  );

  // Subscriptions (#324): a client subscribed to the session list or one
  // session's URI gets resources/updated when its content changes, e.g. a
  // recording that ended on its own (max duration, window closed).
  const subscribed = new Map<string, string | null>();
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, (req) => {
    subscribed.set(req.params.uri, resourceSnapshot(req.params.uri));
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  // Skipped once shutdown starts (the client's pipe may be gone), and never
  // allowed to throw into a registry write (#229).
  getStore().onChange(() => {
    if (isShuttingDown() || !server.isConnected()) return;
    try {
      server.sendResourceListChanged();
    } catch {
      /* the client went away */
    }
    for (const [uri, before] of subscribed) {
      const now = resourceSnapshot(uri);
      if (now === before) continue;
      subscribed.set(uri, now);
      server.server.sendResourceUpdated({ uri }).catch(() => {
        /* the client went away */
      });
    }
  });
}

/** What a subscribable URI currently holds, to tell whether it changed; null
 * for a session that does not exist (yet) or a URI with no snapshot. */
export function resourceSnapshot(uri: string): string | null {
  if (uri === "screencast://sessions") return JSON.stringify(getStore().list());
  const m = /^screencast:\/\/sessions\/([^/]+)$/.exec(uri);
  const s = m ? getStore().get(decodeURIComponent(m[1]!)) : undefined;
  return s ? JSON.stringify(s) : null;
}
