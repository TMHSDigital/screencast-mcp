import { z } from "zod";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, release, version as osVersion } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { planPipeline, type PipelineStep } from "../utils/pipeline.js";
import { exportAnimation } from "../utils/animExport.js";
import { DEFAULT_MAX_BYTES, type AnimFormat } from "../utils/anim.js";
import { evenTimes, DEFAULT_SHEET_COUNT, DEFAULT_TILE_WIDTH } from "../utils/sheet.js";
import { scanVideoFrames, scanMatches, type VideoScan } from "../utils/ocrScan.js";
import { eventPaths, parseEventsJsonl, whenFinalized } from "../utils/events.js";
import { ocrStatus, parseFfmpegVersion, versionText } from "../utils/capabilities.js";
import { getMonitors } from "../utils/monitors.js";
import { resolveOutputDir, subdir, stamp, rand } from "../utils/paths.js";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";
import type { SessionRecord } from "../utils/sessions.js";
import { getStore } from "../context.js";
import { redactRegionSchema } from "./redactRegion.js";
import { renderContactSheet } from "./contactSheet.js";
import { DEFAULT_SCAN_FRAMES, MAX_SCAN_FRAMES } from "./findText.js";
import {
  DEFAULT_CLIP_SEC,
  DEFAULT_ERROR_PATTERN,
  DEFAULT_SCAN_EVERY_SEC,
  DEFAULT_SECRET_PATTERN,
  MAX_CLIP_SEC,
  MAX_STEPS,
  REPORT_FILES,
  buildReportMarkdown,
  clipWindow,
  errorFindings,
  maskSecrets,
  mergeRedactions,
  reconstructSteps,
  type BugReportData,
} from "../utils/bugReport.js";

const { version: serverVersion } = createRequire(import.meta.url)("../../package.json") as { version: string };

const inputSchema = {
  input: z.string().min(1).optional().describe("Recording path (uses its .events.jsonl)."),
  sessionId: z.string().min(1).optional().describe("Or a stopped session's id."),
  title: z.string().max(200).optional().describe("Issue title."),
  actual: z.string().max(4000).optional().describe("What happened."),
  expected: z.string().max(4000).optional().describe("What should happen."),
  start: z.number().nonnegative().optional().describe("Clip start s (default: end - clipSec)."),
  end: z.number().positive().optional().describe("Clip end s (default: recording end)."),
  clipSec: z.number().positive().max(MAX_CLIP_SEC).optional().describe(`Clip length without start (default ${DEFAULT_CLIP_SEC}).`),
  redact: z.boolean().optional().describe("Box out OCR-found secrets in every output (default true; needs Windows OCR)."),
  secretPattern: z.string().optional().describe("Secret regex (default: API keys, tokens, password: values)."),
  regions: z.array(redactRegionSchema).optional().describe("Extra boxes (video px; start/end on the clip clock)."),
  errorPattern: z.string().optional().describe("Error-line regex."),
  scanEverySec: z.number().positive().optional().describe(`OCR every N s (default ${DEFAULT_SCAN_EVERY_SEC}).`),
  maxFrames: z.number().int().min(1).max(MAX_SCAN_FRAMES).optional().describe(`Scan frame cap (default ${DEFAULT_SCAN_FRAMES}).`),
  gif: z.boolean().optional().describe("Also export a GIF (default true)."),
  maxBytes: z.number().int().min(10_000).optional().describe(`GIF size budget (default ${DEFAULT_MAX_BYTES}).`),
  outputDir: z.string().optional().describe("Package folder (default: a new one in SCREENCAST_HOME/edits)."),
  overwrite: z.boolean().optional().describe("Replace a report already in outputDir."),
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface Source {
  path: string;
  eventsPath: string | null;
  record?: SessionRecord;
}

export async function resolveSource(args: { input?: string; sessionId?: string }): Promise<Source> {
  if (args.sessionId !== undefined) {
    const record = getStore().get(args.sessionId);
    if (!record) throw new ScreencastError(`No session with id "${args.sessionId}".`);
    if (record.status === "recording") {
      throw new ScreencastError("The recording is still running; stop_recording it first.");
    }
    await whenFinalized(record.id);
    if (!existsSync(record.outputPath)) throw new ScreencastError(`The session's recording is missing: ${record.outputPath}`);
    const events = record.events?.path;
    return { path: record.outputPath, eventsPath: events && existsSync(events) ? events : null, record };
  }
  const path = args.input!;
  if (!existsSync(path)) throw new ScreencastError(`Input file not found: ${path}`);
  const { jsonl } = eventPaths(path);
  return { path, eventsPath: existsSync(jsonl) ? jsonl : null };
}

/** "1920x1080 @150% (primary)" per display, best-effort (Windows only). */
async function displayRows(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  try {
    const monitors = await getMonitors();
    return monitors
      .map((m) => `${m.width}x${m.height}${m.dpi ? ` @${Math.round((m.dpi / 96) * 100)}%` : ""}${m.primary ? " (primary)" : ""}`)
      .join(", ");
  } catch {
    return null;
  }
}

export function register(server: McpServer): void {
  server.registerTool(
    "bug_report",
    {
      title: "Bug Report Package",
      description:
        "Package a recording as a paste-ready repro folder: secret-scanned, redacted clip and GIF, contact " +
        "sheet, steps from the event log, OCR'd errors, environment, report.md for gh issue create --body-file.",
      inputSchema,
      outputSchema: looseOutput({
        outputDir: z.string(),
        reportPath: z.string(),
        jsonPath: z.string(),
        clipPath: z.string(),
      }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      let createdDir: string | null = null;
      const written: string[] = [];
      try {
        if ((args.input === undefined) === (args.sessionId === undefined)) {
          throw new ScreencastError("Provide exactly one of: input (a recording path) or sessionId.");
        }
        const { ffmpeg } = requireFfmpeg();
        const source = await resolveSource(args);
        const info = await probeMedia(source.path);
        if (!info.width || !info.height) throw new ScreencastError(`Could not read the size of ${source.path}.`);
        const duration = info.videoDurationSec ?? info.durationSec;
        if (duration === null) throw new ScreencastError(`Could not read the duration of ${source.path}.`);
        const window = clipWindow(duration, args);
        const clipLen = r3(window.end - window.start);
        const redact = args.redact !== false;
        const secretPattern = args.secretPattern ?? DEFAULT_SECRET_PATTERN;
        // Fail on a bad pattern before any work.
        maskSecrets(["x"], secretPattern);
        if (args.errorPattern !== undefined) maskSecrets(["x"], args.errorPattern);

        // The package folder: fixed names inside it, so refuse to clobber
        // an earlier report unless asked.
        const format: AnimFormat = "gif";
        const dir = resolveOutputDir(args.outputDir, subdir("edits")) ?? join(subdir("edits"), `bug-report-${stamp()}-${rand()}`);
        const paths = {
          markdown: join(dir, REPORT_FILES.markdown),
          json: join(dir, REPORT_FILES.json),
          clip: join(dir, REPORT_FILES.clip),
          gif: join(dir, REPORT_FILES.gif(format)),
          sheet: join(dir, REPORT_FILES.contactSheet),
        };
        const clash = Object.values(paths).filter((p) => existsSync(p));
        if (clash.length > 0 && !args.overwrite) {
          throw new ScreencastError(
            `The folder already holds a report: ${clash.join(", ")}. Pass overwrite: true to replace it, or choose another outputDir.`,
          );
        }
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
          createdDir = dir;
        }
        const warnings: string[] = [];

        const work = mkdtempSync(join(tmpdir(), "screencast-bug-"));
        try {
          // 1. One OCR scan of the clip window, for both the secret scan and
          //    the error text: nothing is encoded before redaction is known.
          let ocr: BugReportData["ocr"] = "unavailable";
          let scan: VideoScan | null = null;
          const status = await ocrStatus();
          if (status.available) {
            scan = await scanVideoFrames(
              source.path,
              {
                everySec: args.scanEverySec ?? DEFAULT_SCAN_EVERY_SEC,
                maxFrames: args.maxFrames ?? DEFAULT_SCAN_FRAMES,
                range: { start: window.start, duration: clipLen },
              },
              work,
              extra.signal,
            );
            ocr = "read";
          } else if (redact) {
            throw new ScreencastError(
              `The secret scan needs Windows OCR, which is unavailable here${status.error ? ` (${status.error})` : ""}.`,
              "Pass redact: false to package without it (then check the clip yourself before sharing), or run doctor.",
            );
          } else {
            warnings.push("Windows OCR is unavailable, so no error text was read.");
          }
          const found = scan && redact ? mergeRedactions(scanMatches(scan, secretPattern, true, "line").redactRegions) : [];
          const regions = [...found, ...(args.regions ?? [])];
          const errors = scan ? errorFindings(scan.frames, args.errorPattern ?? DEFAULT_ERROR_PATTERN, redact ? secretPattern : null) : [];
          extra.signal.throwIfAborted();

          // 2. The clip: trim and redact fused into one encode (pipeline).
          const steps: PipelineStep[] = [
            { op: "trim", start: window.start, end: window.end },
            ...(regions.length > 0 ? [{ op: "redact" as const, regions, style: "box" as const }] : []),
          ];
          const plan = planPipeline(source.path, paths.clip, steps, {
            width: info.width,
            height: info.height,
            fps: info.fps ?? 30,
            durationSec: info.durationSec,
            hasAudio: info.audioCodec !== null,
          });
          await runEditJob(plan.args, { output: paths.clip, durationSec: plan.durationSec, inputDurationSec: clipLen, extra });
          written.push(paths.clip);

          // 3. GIF and contact sheet, both from the redacted clip.
          let anim: Awaited<ReturnType<typeof exportAnimation>> | null = null;
          if (args.gif !== false) {
            anim = await exportAnimation(paths.clip, paths.gif, { format, maxBytes: args.maxBytes ?? DEFAULT_MAX_BYTES }, extra);
            written.push(paths.gif);
            if (anim.note) warnings.push(anim.note);
          }
          await renderContactSheet(paths.clip, evenTimes(clipLen, DEFAULT_SHEET_COUNT), paths.sheet, { tileWidth: DEFAULT_TILE_WIDTH }, extra.signal);
          written.push(paths.sheet);

          // 4. Steps from the event log.
          const allSteps = source.eventsPath ? reconstructSteps(parseEventsJsonl(readFileSync(source.eventsPath, "utf8"))) : [];
          const stepsNote = source.eventsPath
            ? allSteps.length === 0
              ? "The event log has no clicks, shortcuts, typing, or scrolls."
              : undefined
            : "The recording has no input event log (record with start_recording events: true).";

          // 5. Environment.
          const ff = parseFfmpegVersion(versionText(ffmpeg) ?? "");
          const displays = await displayRows();
          const record = source.record;
          const mask = (s: string) => (redact ? (maskSecrets([s], secretPattern)[0] ?? s) : s);
          const environment: Array<[string, string]> = [
            ["OS", `${osVersion()} (${release()}), ${process.arch}`],
            ...(displays ? [["Displays", displays] as [string, string]] : []),
            ...(record ? [["Recorded target", mask(record.target)] as [string, string]] : []),
            ...(record?.matchedWindow ? [["Window", mask(record.matchedWindow)] as [string, string]] : []),
            ...(record?.backend ? [["Capture backend", record.backend] as [string, string]] : []),
            [
              "Recording",
              `${info.width}x${info.height}${info.fps ? ` @ ${Math.round(info.fps * 100) / 100} fps` : ""}, ` +
                `${r3(duration)} s${info.videoCodec ? `, ${info.videoCodec}` : ""}`,
            ],
            ["ffmpeg", ff.version ?? "unknown"],
            ["screencast-mcp", `${serverVersion} (Node ${process.version})`],
          ];

          // 6. report.md and report.json.
          const data: BugReportData = {
            title: args.title?.trim() || "Bug report",
            ...(args.expected ? { expected: args.expected } : {}),
            ...(args.actual ? { actual: args.actual } : {}),
            createdAt: new Date().toISOString(),
            clip: { start: window.start, end: window.end, recordingDurationSec: r3(duration), width: info.width, height: info.height },
            files: {
              clip: REPORT_FILES.clip,
              ...(anim ? { gif: REPORT_FILES.gif(format) } : {}),
              contactSheet: REPORT_FILES.contactSheet,
            },
            ...(anim ? { gif: { format, sizeBytes: anim.sizeBytes, withinBudget: anim.withinBudget } } : {}),
            steps: allSteps.slice(0, MAX_STEPS),
            ...(allSteps.length > MAX_STEPS ? { stepsOmitted: allSteps.length - MAX_STEPS } : {}),
            ...(stepsNote ? { stepsNote } : {}),
            errors,
            ocr,
            redaction: {
              scanned: scan !== null && redact,
              ...(scan && redact ? { everySec: r3(scan.step), framesScanned: scan.frames.length } : {}),
              found: found.length,
              manual: args.regions?.length ?? 0,
            },
            environment,
          };
          writeFileSync(paths.markdown, buildReportMarkdown(data));
          written.push(paths.markdown);
          writeFileSync(
            paths.json,
            JSON.stringify({ ...data, steps: allSteps, redaction: { ...data.redaction, regions } }, null, 2) + "\n",
          );
          written.push(paths.json);

          if (scan?.clamped) {
            warnings.push(`The scan interval was widened to ${r3(scan.step)} s to fit maxFrames.`);
          }
          const { images } = await encodeInlineImages([paths.sheet], DEFAULT_MAX_IMAGE_WIDTH, 1);
          return okResponse(
            {
              outputDir: dir,
              reportPath: paths.markdown,
              jsonPath: paths.json,
              clipPath: paths.clip,
              ...(anim ? { gifPath: paths.gif, gifSizeBytes: anim.sizeBytes, gifWithinBudget: anim.withinBudget } : {}),
              contactSheetPath: paths.sheet,
              clip: { start: window.start, end: window.end },
              steps: allSteps.length,
              errors: errors.map((e) => e.text),
              ocr,
              redaction: data.redaction,
              ...(warnings.length > 0 ? { warnings } : {}),
              next:
                `Review the clip and report.md, then: gh issue create --title ${JSON.stringify(data.title)} ` +
                `--body-file ${JSON.stringify(paths.markdown)} and drag the GIF into the issue.`,
              note: "Redaction is OCR-based and best-effort: look at the clip before posting it anywhere public.",
            },
            images,
          );
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        // Never leave half a package behind.
        if (createdDir) rmSync(createdDir, { recursive: true, force: true });
        else for (const p of written) rmSync(p, { force: true });
        return errorResponse(error);
      }
    },
  );
}
