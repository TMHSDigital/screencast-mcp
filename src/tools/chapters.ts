import { z } from "zod";
import { extname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia, runCapture } from "../utils/ffmpeg.js";
import { jobTimeoutMs, runEditJob } from "../utils/jobs.js";
import { buildSceneScanArgs, parseSceneScan, editOutputExt, DEFAULT_SCENE_THRESHOLD } from "../utils/media.js";
import { parseSrt } from "../utils/captions.js";
import {
  buildChapters,
  buildChaptersMuxArgs,
  ffmetadata,
  markerPoints,
  markersOrChapters,
  scenePoints,
  transcriptPoints,
  youtubeChapters,
  YOUTUBE_MIN_CHAPTER_SEC,
  type ChapterContainer,
  type ChapterPoint,
  type Marker,
} from "../utils/chapters.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { getStore } from "../context.js";

const CONTAINERS = new Set<string>([".mp4", ".mkv", ".mov"]);
/** Most chapters from: scenes picks, the opening one included. */
const MAX_SCENE_CHAPTERS = 12;

const inputSchema = {
  input: z.string().min(1).optional().describe("Path to the video."),
  sessionId: z.string().min(1).optional().describe("Or a stopped recording's id."),
  from: z
    .enum(["markers", "scenes", "transcript"])
    .optional()
    .describe("markers (default; add_marker, else the file's chapters), scenes (screen changes), or transcript (SRT sections)."),
  chapters: z
    .array(z.object({ start: z.number().min(0), title: z.string().min(1).max(100) }))
    .min(1)
    .max(200)
    .optional()
    .describe("Or explicit { start, title } chapters."),
  transcript: z.string().optional().describe("The .srt for from: transcript."),
  minChapterSec: z
    .number()
    .min(0)
    .optional()
    .describe(`Shortest chapter (default 1; scenes ${YOUTUBE_MIN_CHAPTER_SEC}, transcript 30).`),
  subtitles: z.string().optional().describe("Also mux this .srt/.vtt/.ass as a soft subtitle track."),
  subtitleLanguage: z.string().regex(/^[a-z]{3}$/).optional().describe('ISO 639-2, e.g. "eng".'),
  textOnly: z.boolean().optional().describe("Return chapters and YouTube text only; write no file."),
  output: z.string().optional().describe("Optional .mp4/.mkv/.mov path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing output file."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "chapters",
    {
      title: "Chapters",
      description:
        "Write chapters (markers, scene changes, transcript, or a list) into an mp4/mkv/mov copy without " +
        "re-encoding; returns YouTube chapter text. Can mux an SRT as soft subtitles.",
      inputSchema,
      outputSchema: looseOutput({
        chapters: z.array(looseOutput({ start: z.number(), end: z.number(), title: z.string() })),
        youtube: z.string(),
      }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        let input = args.input;
        let sessionMarkers: Marker[] | undefined;
        if (args.sessionId) {
          const record = getStore().get(args.sessionId);
          if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
          if (record.status === "recording" || record.status === "paused") throw new ScreencastError("The recording is still running; stop it first.");
          input ??= record.outputPath;
          sessionMarkers = record.markers;
        }
        if (!input) throw new ScreencastError("Pass input or sessionId.");
        if (!existsSync(input)) throw new ScreencastError(`Input file not found: ${input}`);
        for (const f of [args.transcript, args.subtitles]) {
          if (f !== undefined && !existsSync(f)) throw new ScreencastError(`File not found: ${f}`);
        }
        if (args.subtitles && !/\.(srt|vtt|ass|ssa)$/i.test(args.subtitles)) {
          throw new ScreencastError("subtitles must be an .srt, .vtt, or .ass file.");
        }
        const info = await probeMedia(input);
        const durationSec = info.durationSec;
        if (!durationSec || durationSec <= 0) throw new ScreencastError(`Could not read the duration of ${input}.`);

        const from = args.chapters ? "list" : (args.from ?? "markers");
        let points: ChapterPoint[];
        let minDefault = 1;
        let source = from;
        if (args.chapters) {
          points = args.chapters;
        } else if (from === "scenes") {
          minDefault = YOUTUBE_MIN_CHAPTER_SEC;
          const { ffmpeg } = requireFfmpeg();
          const scan = await runCapture(
            ffmpeg,
            buildSceneScanArgs(input, DEFAULT_SCENE_THRESHOLD),
            jobTimeoutMs(durationSec),
            { signal: extra.signal },
          );
          if (scan.code !== 0) {
            throw new ScreencastError(`Scene scan failed (exit ${scan.code}): ${scan.stderr.trim().slice(-400)}`);
          }
          points = scenePoints(parseSceneScan(scan.stdout), args.minChapterSec ?? minDefault, MAX_SCENE_CHAPTERS);
        } else if (from === "transcript") {
          if (!args.transcript) throw new ScreencastError("from: transcript needs transcript (an .srt path).");
          minDefault = 30;
          points = transcriptPoints(parseSrt(readFileSync(args.transcript, "utf8")), { minChapterSec: args.minChapterSec ?? minDefault });
          if (points.length === 0) throw new ScreencastError(`No cues in ${args.transcript}.`);
        } else {
          let markers = sessionMarkers ?? [];
          if (markers.length === 0) {
            const found = await markersOrChapters(input, extra.signal);
            markers = found.markers;
            if (found.from === "chapters") source = "embedded chapters";
          }
          if (markers.length === 0) {
            throw new ScreencastError(
              `No markers for ${input}.`,
              "Add some with add_marker, or use from: scenes / transcript, or pass chapters.",
            );
          }
          points = markerPoints(markers);
        }
        const chapters = buildChapters(points, durationSec, { minChapterSec: args.minChapterSec ?? minDefault });
        if (chapters.length === 0) throw new ScreencastError("No chapter falls inside the video.");
        const yt = youtubeChapters(chapters, durationSec);
        const result = {
          source,
          chapters,
          youtube: yt.text,
          ...(yt.issues.length > 0 ? { youtubeIssues: yt.issues } : {}),
        };
        if (args.textOnly) return okResponse(result);

        const ext = (args.output ? extname(args.output).toLowerCase() : editOutputExt(input)) as ChapterContainer;
        if (!CONTAINERS.has(ext)) {
          throw new ScreencastError(`Chapters can be written to .mp4, .mkv, or .mov, not ${ext || "a file without an extension"}.`);
        }
        const output = resolveOutput(args.output, subdir("edits"), `chapters-${stamp()}-${rand()}${ext}`, args.overwrite);
        const work = mkdtempSync(join(tmpdir(), "screencast-chapters-"));
        try {
          const meta = join(work, "chapters.txt");
          writeFileSync(meta, ffmetadata(chapters));
          await runEditJob(
            buildChaptersMuxArgs(input, meta, output, { container: ext, subtitles: args.subtitles, language: args.subtitleLanguage }),
            { output, durationSec, extra },
          );
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
        return okResponse({
          outputPath: output,
          ...result,
          ...(args.subtitles
            ? { subtitleTrack: { file: args.subtitles, codec: ext === ".mkv" ? "copy" : "mov_text", ...(args.subtitleLanguage ? { language: args.subtitleLanguage } : {}) } }
            : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
