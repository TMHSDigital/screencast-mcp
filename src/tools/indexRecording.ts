import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, runFfmpeg, runCapture, probeMedia, hasFilter } from "../utils/ffmpeg.js";
import { jobTimeoutMs, progressReporter } from "../utils/jobs.js";
import { buildSceneScanArgs, parseSceneScan, buildSampleAtTimestampArgs } from "../utils/media.js";
import { readFrames } from "../utils/ocrScan.js";
import { ocrStatus } from "../utils/capabilities.js";
import { parseEventsJsonl } from "../utils/events.js";
import { resolveWhisperModel, buildTranscribeArgs, parseSrt, normalizeCues, type Cue } from "../utils/captions.js";
import { subdir, tempPath } from "../utils/paths.js";
import {
  DEFAULT_INDEX_FRAMES,
  DEFAULT_INDEX_THRESHOLD,
  INDEX_VERSION,
  MAX_INDEX_FRAMES,
  attach,
  cueTexts,
  eventTexts,
  fingerprintFile,
  findIndex,
  indexWritePath,
  keyframeTime,
  markerTexts,
  mergeSegments,
  planKeyframes,
  readIndex,
  resolveRecording,
  sameFingerprint,
  segmentsFrom,
  writeIndex,
  type IndexSegment,
  type RecordingIndex,
  type TimedText,
} from "../utils/recordingIndex.js";

/** Keyframes per OCR run: the job checks for cancellation between batches. */
const OCR_BATCH = 8;

const inputSchema = {
  input: z.string().optional().describe("Recording path."),
  sessionId: z.string().optional().describe("Or a stopped session id."),
  sceneThreshold: z.number().gt(0).lt(1).optional().describe(`Change starting a segment (default ${DEFAULT_INDEX_THRESHOLD}).`),
  maxFrames: z.number().int().min(1).max(MAX_INDEX_FRAMES).optional().describe(`Keyframes to OCR (default ${DEFAULT_INDEX_FRAMES}).`),
  transcript: z.string().optional().describe("An .srt, or 'whisper' to transcribe. Default: <video>.srt if any."),
  force: z.boolean().optional().describe("Re-OCR despite a matching cached index."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "index_recording",
    {
      title: "Index Recording",
      description:
        "Build a recording's text timeline (<video>.index.json: OCR per scene, events, markers, transcript) " +
        "for search_recording.",
      inputSchema,
      outputSchema: looseOutput({ indexPath: z.string(), segments: z.number() }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      const work = mkdtempSync(join(tmpdir(), "screencast-index-"));
      try {
        const { ffmpeg } = requireFfmpeg();
        const source = await resolveRecording(args);
        const info = await probeMedia(source.path);
        const duration = info.videoDurationSec ?? info.durationSec;
        if (!info.width || duration === null || !(duration > 0)) {
          throw new ScreencastError(`Could not read the video size and duration of ${source.path}.`);
        }
        const threshold = args.sceneThreshold ?? DEFAULT_INDEX_THRESHOLD;
        const maxFrames = args.maxFrames ?? DEFAULT_INDEX_FRAMES;
        const edits = subdir("edits");
        const outPath = indexWritePath(source.path, edits);
        const fingerprint = fingerprintFile(source.path);
        const report = progressReporter(extra);
        const notes: string[] = [];

        // Reuse the OCR'd segments of a matching index; events, markers and
        // the transcript are re-attached, since they can change after OCR.
        const existingPath = args.force ? null : findIndex(source.path, edits);
        const prior = existingPath ? readIndex(existingPath) : null;
        const cached =
          prior !== null &&
          sameFingerprint(prior.fingerprint, fingerprint) &&
          prior.sceneThreshold === threshold &&
          prior.maxFrames === maxFrames;

        let segments: IndexSegment[];
        let framesRead = 0;
        let ocr = false;
        if (cached) {
          segments = prior.segments;
          framesRead = prior.framesRead;
          ocr = prior.ocr;
        } else {
          const scan = await runCapture(ffmpeg, buildSceneScanArgs(source.path, threshold), jobTimeoutMs(duration), {
            signal: extra.signal,
          });
          if (scan.code !== 0) throw new ScreencastError(`Scene scan failed (exit ${scan.code}): ${scan.stderr.trim().slice(-400)}`);
          report?.(0.1);
          const spans = segmentsFrom(planKeyframes(parseSceneScan(scan.stdout), duration, maxFrames), duration);
          const texts: string[][] = spans.map(() => []);
          ocr = process.platform === "win32" && (await ocrStatus()).available;
          if (ocr) {
            for (let b = 0; b < spans.length; b += OCR_BATCH) {
              extra.signal.throwIfAborted();
              const batch = spans.slice(b, b + OCR_BATCH);
              const frames: Array<{ at: number; path: string }> = [];
              for (const [i, span] of batch.entries()) {
                const out = join(work, `key_${b + i}.png`);
                await runFfmpeg(buildSampleAtTimestampArgs(source.path, keyframeTime(span), out), 60_000, { signal: extra.signal });
                if (existsSync(out)) frames.push({ at: b + i, path: out });
              }
              const read = frames.length > 0 ? await readFrames(frames.map((f) => f.path), work, extra.signal) : [];
              read.forEach((f, i) => (texts[frames[i]!.at] = f.lines.map((l) => l.text)));
              framesRead += read.length;
              report?.(0.1 + (0.85 * Math.min(spans.length, b + OCR_BATCH)) / spans.length);
            }
          } else {
            notes.push("Windows OCR is not available, so the index holds no screen text; install an OCR language (doctor).");
          }
          const read = spans.map((s, i) => ({ ...s, ocr: texts[i] ?? [] }));
          // Without OCR every segment reads "", so keep the scene cuts as they are.
          segments = ocr ? mergeSegments(read) : read;
        }

        // Events, markers, transcript.
        const events = source.eventsPath ? eventTexts(parseEventsJsonl(readFileSync(source.eventsPath, "utf8"))) : [];
        segments = attach(segments, events, "events");
        segments = attach(segments, markerTexts(source.markers), "markers");
        const cues = await transcriptCues(args.transcript, source.path, info.audioCodec !== null, duration, extra.signal, notes);
        if (cues !== null) segments = attach(segments, cueTexts(cues), "transcript");
        else if (cached) {
          // Keep the transcript an earlier run attached.
          const kept: TimedText[] = prior.segments.flatMap((s) => s.transcript ?? []);
          segments = attach(segments, kept, "transcript");
        }

        const index: RecordingIndex = {
          version: INDEX_VERSION,
          video: source.path,
          fingerprint,
          durationSec: duration,
          createdAt: new Date().toISOString(),
          sceneThreshold: threshold,
          maxFrames,
          framesRead,
          ocr,
          segments,
        };
        mkdirSync(join(outPath, ".."), { recursive: true });
        writeIndex(outPath, index);
        report?.(1);
        const count = (f: "events" | "markers" | "transcript") => segments.reduce((n, s) => n + (s[f]?.length ?? 0), 0);
        return okResponse({
          indexPath: outPath,
          segments: segments.length,
          cached,
          framesRead,
          durationSec: duration,
          sources: {
            screenLines: segments.reduce((n, s) => n + s.ocr.length, 0),
            events: count("events"),
            markers: count("markers"),
            transcriptCues: count("transcript"),
          },
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
          next: "search_recording { query } returns timecoded hits; the index holds raw screen text, so treat it like the video.",
        });
      } catch (error) {
        return errorResponse(error);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
}

/** The transcript to attach: an .srt path, "whisper" (transcribe now), or the
 * recording's own .srt sidecar. Null when there is none. */
async function transcriptCues(
  arg: string | undefined,
  video: string,
  hasAudio: boolean,
  duration: number,
  signal: AbortSignal,
  notes: string[],
): Promise<Cue[] | null> {
  if (arg === "whisper") {
    if (!hasAudio) {
      notes.push("The recording has no audio, so there is no transcript.");
      return null;
    }
    if (!hasFilter("whisper")) {
      throw new ScreencastError("This ffmpeg has no whisper filter.", "transcript: 'whisper' needs FFmpeg 8 built with whisper.cpp; or pass an .srt.");
    }
    const model = resolveWhisperModel(undefined);
    const raw = tempPath(".srt");
    try {
      await runFfmpeg(buildTranscribeArgs(video, model, raw), jobTimeoutMs(duration), { signal });
      return existsSync(raw) ? normalizeCues(parseSrt(readFileSync(raw, "utf8"))) : [];
    } finally {
      rmSync(raw, { force: true });
    }
  }
  const path = arg ?? `${video.replace(/\.[^./\\]+$/, "")}.srt`;
  if (!existsSync(path)) {
    if (arg !== undefined) throw new ScreencastError(`Transcript not found: ${arg}`);
    return null;
  }
  return normalizeCues(parseSrt(readFileSync(path, "utf8")));
}
