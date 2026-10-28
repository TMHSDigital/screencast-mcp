import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { buildSampleAtTimestampArgs } from "../utils/media.js";
import { subdir } from "../utils/paths.js";
import { encodeInlineImages, clampInlineCount, MAX_INLINE_IMAGES } from "../utils/images.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  fingerprintFile,
  findIndex,
  keyframeTime,
  readIndex,
  resolveRecording,
  sameFingerprint,
  searchIndex,
} from "../utils/recordingIndex.js";

/** Thumbnail width: enough to recognise the screen, cheap in tokens. */
const THUMB_WIDTH = 480;

const inputSchema = {
  input: z.string().optional().describe("Recording path."),
  sessionId: z.string().optional().describe("Or a stopped session id."),
  query: z.string().min(1).describe("Text; tolerates OCR misreads."),
  regex: z.boolean().optional().describe("query is a regex."),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe(`Max hits (default ${DEFAULT_SEARCH_LIMIT}).`),
  images: z.number().int().min(0).max(MAX_INLINE_IMAGES).optional().describe("Thumbnails of the top N hits (default 0)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "search_recording",
    {
      title: "Search Recording",
      description:
        "Search an index_recording timeline (screen text, events, markers, transcript): timecoded hits, " +
        "best first, secrets masked. No frames unless asked.",
      inputSchema,
      outputSchema: looseOutput({ total: z.number(), hits: z.array(z.unknown()) }),
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      try {
        const source = await resolveRecording(args);
        const indexPath = findIndex(source.path, subdir("edits"));
        const index = indexPath ? readIndex(indexPath) : null;
        if (!indexPath || !index) {
          throw new ScreencastError(`No index for ${source.path}.`, "Run index_recording on it first.");
        }
        const stale = !sameFingerprint(index.fingerprint, fingerprintFile(source.path));
        const { hits, total } = searchIndex(index, args.query, { regex: args.regex === true, limit: args.limit });

        const want = Math.min(clampInlineCount(args.images ?? 0), hits.length);
        let images: Awaited<ReturnType<typeof encodeInlineImages>>["images"] = [];
        if (want > 0) {
          requireFfmpeg();
          const work = mkdtempSync(join(tmpdir(), "screencast-search-"));
          try {
            const shots: string[] = [];
            for (const [i, hit] of hits.slice(0, want).entries()) {
              const at = hit.t === hit.start ? keyframeTime(hit) : hit.t;
              const out = join(work, `hit_${i}.png`);
              await runFfmpeg(buildSampleAtTimestampArgs(source.path, at, out), 60_000, { signal: extra.signal });
              if (existsSync(out)) shots.push(out);
            }
            images = (await encodeInlineImages(shots, THUMB_WIDTH, want)).images;
          } finally {
            rmSync(work, { recursive: true, force: true });
          }
        }
        return okResponse(
          {
            indexPath,
            query: args.query,
            total,
            hits,
            ...(total > hits.length ? { more: total - hits.length } : {}),
            ...(index.ocr ? {} : { note: "The index has no screen text (OCR was unavailable when it was built)." }),
            ...(stale ? { stale: true, warning: "The recording changed since it was indexed; run index_recording again." } : {}),
          },
          images,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
