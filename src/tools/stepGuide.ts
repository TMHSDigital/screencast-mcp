import { z } from "zod";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia, runFfmpeg } from "../utils/ffmpeg.js";
import { progressReporter } from "../utils/jobs.js";
import { parseEventsJsonl } from "../utils/events.js";
import { inputSteps } from "../utils/steps.js";
import { readMarkers } from "../utils/chapters.js";
import { ocrStatus } from "../utils/capabilities.js";
import { readFrames, scanMatches, type ReadFrame } from "../utils/ocrScan.js";
import { DEFAULT_SECRET_PATTERN } from "../utils/bugReport.js";
import { resolveOutputDir, subdir, stamp, rand } from "../utils/paths.js";
import {
  GUIDE_FILES,
  MAX_GUIDE_STEPS,
  assignSections,
  buildGuideHtml,
  buildGuideMarkdown,
  buildStepFrameArgs,
  buildStepShotArgs,
  caption,
  guideSteps,
  labelAt,
  shotFilter,
  type GuideData,
  type GuideFormat,
} from "../utils/stepGuide.js";
import { resolveSource } from "./bugReport.js";

/** Frames OCR'd per PowerShell run, so a cancel lands between batches. */
const OCR_BATCH = 10;

const inputSchema = {
  input: z.string().min(1).optional().describe("Recording path (uses its .events.jsonl)."),
  sessionId: z.string().min(1).optional().describe("Or a stopped session's id."),
  title: z.string().max(200).optional().describe("Guide title."),
  format: z.enum(["md", "html", "both"]).optional().describe("md + images/, self-contained html, or both (default)."),
  ocr: z.boolean().optional().describe("OCR shots for captions and secret boxes (default true; needs Windows OCR)."),
  outputDir: z.string().optional().describe("Guide folder (default: new in SCREENCAST_HOME/edits)."),
  overwrite: z.boolean().optional().describe("Replace a guide already in outputDir."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "step_guide",
    {
      title: "Step-by-Step Guide",
      description:
        "Turn a recording's event log into a numbered how-to: a ringed screenshot and caption per step, marker " +
        "headings; Markdown and/or one HTML file. Never includes typed text.",
      inputSchema,
      outputSchema: looseOutput({ outputDir: z.string() }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      let createdDir: string | null = null;
      const written: string[] = [];
      try {
        if ((args.input === undefined) === (args.sessionId === undefined)) {
          throw new ScreencastError("Provide exactly one of: input (a recording path) or sessionId.");
        }
        requireFfmpeg();
        const source = await resolveSource(args);
        if (!source.eventsPath) {
          throw new ScreencastError(
            "The recording has no input event log, so there are no steps to write.",
            "Record with start_recording events: true, or pass a recording that has a .events.jsonl beside it.",
          );
        }
        const info = await probeMedia(source.path);
        if (!info.width || !info.height) throw new ScreencastError(`Could not read the size of ${source.path}.`);
        const duration = info.videoDurationSec ?? info.durationSec;
        if (duration === null) throw new ScreencastError(`Could not read the duration of ${source.path}.`);
        const fps = info.fps ?? 30;
        const format: GuideFormat = args.format ?? "both";
        const wantMd = format !== "html";
        const wantHtml = format !== "md";

        const useOcr = args.ocr !== false;
        if (useOcr) {
          const status = await ocrStatus();
          if (!status.available) {
            throw new ScreencastError(
              `Captions and the secret scan need Windows OCR, which is unavailable here${status.error ? ` (${status.error})` : ""}.`,
              "Pass ocr: false for a guide without them (then check the screenshots yourself before sharing), or run doctor.",
            );
          }
        }

        // The guide folder: fixed names inside it, so refuse to clobber an
        // earlier guide unless asked.
        const dir = resolveOutputDir(args.outputDir, subdir("edits")) ?? join(subdir("edits"), `step-guide-${stamp()}-${rand()}`);
        const paths = { markdown: join(dir, GUIDE_FILES.markdown), html: join(dir, GUIDE_FILES.html), images: join(dir, GUIDE_FILES.images) };
        const clash = [paths.markdown, paths.html].filter((p) => existsSync(p));
        if (clash.length > 0 && !args.overwrite) {
          throw new ScreencastError(
            `The folder already holds a guide: ${clash.join(", ")}. Pass overwrite: true to replace it, or choose another outputDir.`,
          );
        }

        const all = inputSteps(parseEventsJsonl(readFileSync(source.eventsPath, "utf8")));
        const kept = all.slice(0, MAX_GUIDE_STEPS);
        const plain = guideSteps(kept, { durationSec: duration, fps });
        const shots = plain.map((s, i) => ({ i, s })).filter(({ s }) => s.shotT !== undefined);
        const warnings: string[] = [];

        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
          createdDir = dir;
        }
        const work = mkdtempSync(join(tmpdir(), "screencast-guide-"));
        try {
          const progress = progressReporter(extra);
          const total = shots.length * (useOcr ? 3 : 2) || 1;
          let done = 0;
          const tick = () => progress?.(++done / total);

          // 1. One raw frame per step.
          const frames: string[] = [];
          for (const { s } of shots) {
            const out = join(work, `frame-${String(s.n).padStart(3, "0")}.png`);
            await runFfmpeg(buildStepFrameArgs(source.path, s.shotT!, out), 60_000, { signal: extra.signal });
            frames.push(out);
            tick();
          }

          // 2. OCR them in batches: a label under each click, secret boxes.
          const read: Array<ReadFrame | null> = frames.map(() => null);
          if (useOcr) {
            for (let b = 0; b < frames.length; b += OCR_BATCH) {
              extra.signal.throwIfAborted();
              const batch = await readFrames(frames.slice(b, b + OCR_BATCH), work, extra.signal);
              batch.forEach((f, k) => {
                read[b + k] = f;
                tick();
              });
            }
          }
          const labels: Array<string | null> = kept.map(() => null);
          const boxes = shots.map(({ i, s }, k) => {
            const frame = read[k];
            if (!frame) return [];
            if (s.x !== undefined && s.y !== undefined) labels[i] = labelAt(frame.lines, s.x, s.y);
            return scanMatches({ frames: [{ ...frame, t: 0, path: "" }], step: 1, end: 1 }, DEFAULT_SECRET_PATTERN, true, "line")
              .redactRegions;
          });
          const steps = assignSections(guideSteps(kept, { durationSec: duration, fps, labels }), readMarkers(source.path));

          // 3. Render each screenshot: secrets boxed, the click ringed.
          const imageDir = wantMd ? paths.images : join(work, "images");
          if (wantMd && existsSync(imageDir) && args.overwrite) {
            for (const f of readdirSync(imageDir)) if (/^step-\d+\.png$/.test(f)) rmSync(join(imageDir, f), { force: true });
          }
          mkdirSync(imageDir, { recursive: true });
          let redactions = 0;
          for (const [k, { i }] of shots.entries()) {
            const step = steps[i]!;
            const file = GUIDE_FILES.image(step.n);
            const ring = step.x !== undefined && step.y !== undefined ? { x: step.x, y: step.y } : undefined;
            const filter = shotFilter({ width: info.width, height: info.height }, { click: ring, boxes: boxes[k] });
            const out = join(imageDir, file);
            await runFfmpeg(buildStepShotArgs(frames[k]!, filter, out), 60_000, { signal: extra.signal });
            if (wantMd) written.push(out);
            step.image = file;
            redactions += boxes[k]!.length;
            tick();
          }

          // 4. guide.md and/or guide.html.
          const stepsNote = all.length === 0 ? "The event log has no clicks, shortcuts, typing, or scrolls." : undefined;
          const data: GuideData = {
            title: args.title?.trim() || "Step-by-step guide",
            createdAt: new Date().toISOString(),
            recording: { durationSec: Math.round(duration * 1000) / 1000, width: info.width, height: info.height },
            steps,
            ...(all.length > MAX_GUIDE_STEPS ? { stepsOmitted: all.length - MAX_GUIDE_STEPS } : {}),
            ...(stepsNote ? { stepsNote } : {}),
            ocr: useOcr ? "read" : "off",
            redactions,
          };
          if (wantMd) {
            writeFileSync(paths.markdown, buildGuideMarkdown(data));
            written.push(paths.markdown);
          }
          if (wantHtml) {
            const src = (file: string) => `data:image/png;base64,${readFileSync(join(imageDir, file)).toString("base64")}`;
            writeFileSync(paths.html, buildGuideHtml(data, src));
            written.push(paths.html);
          }
          if (data.stepsOmitted) warnings.push(`Only the first ${MAX_GUIDE_STEPS} steps were written; ${data.stepsOmitted} more were left out.`);
          if (stepsNote) warnings.push(stepsNote);

          return okResponse({
            outputDir: dir,
            ...(wantMd ? { markdownPath: paths.markdown, imagesDir: paths.images } : {}),
            ...(wantHtml ? { htmlPath: paths.html } : {}),
            steps: steps.map((s) => ({
              ...(s.n > 0 ? { n: s.n } : {}),
              t: s.t,
              action: s.action,
              caption: caption(s),
              ...(s.section ? { section: s.section } : {}),
              ...(s.image ? { image: s.image } : {}),
            })),
            ocr: data.ocr,
            redactions,
            ...(warnings.length > 0 ? { warnings } : {}),
            note: useOcr
              ? "Captions are OCR-based templates: rewrite them in guide.md as needed. The secret scan is best-effort: look at the screenshots before sharing."
              : "Not scanned for secrets: look at the screenshots before sharing.",
          });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        // Never leave half a guide behind.
        if (createdDir) rmSync(createdDir, { recursive: true, force: true });
        else for (const p of written) rmSync(p, { force: true });
        return errorResponse(error);
      }
    },
  );
}
