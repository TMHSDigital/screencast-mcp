import { z } from "zod";
import { extname, join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { jobTimeoutMs } from "../utils/jobs.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { captureStill } from "../utils/still.js";
import { buildHighlightArgs, targetSize } from "../utils/diff.js";
import { recognize, mergePasses, findMatches, redactionRects, passScales, type OcrLine, type TextMatch } from "../utils/ocr.js";
import { buildSampleByFpsArgs, planFpsSampling } from "../utils/media.js";
import { windowMatchReport } from "../utils/windows.js";
import { subdir, stamp, rand, stillOutput } from "../utils/paths.js";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tif", ".tiff"]);
const MAX_LINES = 300;
/** Default and largest frame count for a whole-clip scan (#204). */
export const DEFAULT_SCAN_FRAMES = 30;
export const MAX_SCAN_FRAMES = 120;

const inputSchema = {
  target: z
    .string()
    .optional()
    .describe("Read text live from the screen: 'full' | 'monitor:<index>' | 'window:<title>' (or window:exe=<app.exe> / window:hwnd=<handle>) | 'region:...'."),
  input: z.string().optional().describe("Or read text from an image or video file (one of target / input)."),
  timestamp: z.number().nonnegative().optional().describe("For a video input: the second to read (default 0). Ignored with scanEverySec."),
  scanEverySec: z
    .number()
    .positive()
    .optional()
    .describe(
      "For a video input: read a frame every N seconds across the whole clip instead of one frame, so " +
        "text shown at any moment is found (use it to check a clip for secrets before sharing). Each match " +
        "gets its time, and redactRegions get start/end. The interval widens to stay within maxFrames.",
    ),
  maxFrames: z
    .number()
    .int()
    .min(1)
    .max(MAX_SCAN_FRAMES)
    .optional()
    .describe(`With scanEverySec: most frames to read (default ${DEFAULT_SCAN_FRAMES}); each takes about a second.`),
  exactTitle: z.boolean().optional().describe("For window: targets, match the title exactly (default false)."),
  backend: z
    .enum(["gdigrab", "wgc"])
    .optional()
    .describe(
      "For a live target: gdigrab (default) reads what is visible; 'wgc' (window: targets, FFmpeg 8+) " +
        "reads the window's own surface even when other windows cover it.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Text to look for. Case-insensitive, and tolerant of common OCR misreads (_ vs -, I vs l, " +
        "O vs 0; regexes get the _ vs - tolerance). Without a query, all recognised text is returned.",
    ),
  regex: z.boolean().optional().describe("Treat query as a regular expression (case-insensitive)."),
  redact: z
    .boolean()
    .optional()
    .describe(
      "Also return padded rectangles around each match, ready to pass to redact_region " +
        "(regions) to cover them. Detection is best-effort: review the result.",
    ),
  keep: z
    .boolean()
    .optional()
    .describe(
      "For a live target: keep the captured screenshot and return its path (default false: it is " +
        "deleted after reading, since it may show the secrets being looked for).",
    ),
  returnImage: z
    .boolean()
    .optional()
    .describe("Return the image inline with matches outlined in red (default true when there is a query)."),
};

/** OCR several frames in one PowerShell run: each frame is upscaled for every
 * pass (passScales), and the passes are merged back per frame. */
async function readFrames(
  sources: string[],
  work: string,
  signal: AbortSignal,
): Promise<Array<{ lines: OcrLine[]; width: number; height: number }>> {
  const sized = await Promise.all(sources.map((s) => probeMedia(s)));
  const passes: string[] = [];
  const passScaleList: number[] = [];
  const owner: number[] = [];
  for (let f = 0; f < sources.length; f++) {
    const { width, height } = sized[f];
    if (!width || !height) throw new ScreencastError("Could not read the image size.");
    for (const [i, scale] of passScales(width, height).entries()) {
      const out = join(work, `pass${f}-${i}.png`);
      await runFfmpeg(["-y", "-v", "error", "-i", sources[f], "-vf", `scale=iw*${scale}:ih*${scale}:flags=lanczos`, out], 60_000, {
        signal,
      });
      passes.push(out);
      passScaleList.push(scale);
      owner.push(f);
    }
  }
  const results = await recognize(passes, passScaleList);
  return sources.map((_, f) => ({
    lines: mergePasses(results.filter((_r, i) => owner[i] === f)),
    width: sized[f].width!,
    height: sized[f].height!,
  }));
}

export function register(server: McpServer): void {
  server.tool(
    "find_text",
    "Read text on screen or in an image/video frame with the OCR engine built into Windows " +
      "(no install), with each line's and match's bounding box. Find where a label or button " +
      "is, check what the screen says, or locate secrets (e.g. regex 'sk-|ghp_|api.?key') and get " +
      "redact_region rectangles for them; for a video, scanEverySec checks the whole clip. Boxes are " +
      "in the image's pixels; for a live target, add `origin` for desktop coordinates. Best-effort " +
      "detection: always review.",
    inputSchema,
    async (args, extra) => {
      try {
        requireFfmpeg();
        if ((args.target === undefined) === (args.input === undefined)) {
          throw new ScreencastError("Provide exactly one of: target (live screen) or input (a file).");
        }
        const work = mkdtempSync(join(tmpdir(), "screencast-ocr-"));
        try {
          if (args.scanEverySec !== undefined) return await scanClip(args, work, extra.signal);

          // 1. Get the source as one PNG frame.
          let source: string;
          let windowReport: Record<string, unknown> = {};
          let origin: { x: number; y: number } | undefined;
          if (args.target !== undefined) {
            const resolved = await resolveCaptureTarget(args.target, { exactTitle: args.exactTitle, backend: args.backend });
            // Captures go to the work dir and vanish with it unless kept (#209).
            source = args.keep ? join(subdir("screenshots"), `ocr-${stamp()}-${rand()}.png`) : join(work, "capture.png");
            const backend = args.backend ?? "gdigrab";
            await captureStill(resolved, source, backend);
            if (resolved.window) windowReport = windowMatchReport(resolved.window);
            // Where the image sits on the desktop: boxes are image pixels (#233).
            // A WGC still is the window's client area.
            const area = targetSize(resolved.target, resolved.monitors);
            origin = backend === "wgc" && resolved.window?.client ? resolved.window.client : { x: area.x, y: area.y };
          } else {
            if (!existsSync(args.input!)) throw new ScreencastError(`Input file not found: ${args.input}`);
            const isImage = IMAGE_EXTENSIONS.has(extname(args.input!).toLowerCase());
            source = join(work, "frame.png");
            await runFfmpeg(
              ["-y", "-v", "error", ...(isImage ? [] : ["-ss", String(args.timestamp ?? 0)]), "-i", args.input!, "-frames:v", "1", ...stillOutput(source)],
              60_000,
              { signal: extra.signal },
            );
          }

          // 2. Upscaled copies for each recognition pass, then OCR them in one run.
          const [{ lines, width, height }] = await readFrames([source], work, extra.signal);

          // 3. Match, and optionally outline / suggest redactions.
          const matches = args.query ? findMatches(lines, args.query, args.regex === true) : [];
          const images = [];
          const wantImage = args.returnImage ?? Boolean(args.query);
          if (wantImage) {
            const shown = join(work, "shown.png");
            await runFfmpeg(buildHighlightArgs(source, matches, shown), 30_000, { signal: extra.signal });
            images.push(...(await encodeInlineImages([shown], DEFAULT_MAX_IMAGE_WIDTH, 1)).images);
          }
          return okResponse(
            {
              ...(args.target !== undefined ? (args.keep ? { screenshotPath: source } : {}) : { input: args.input }),
              imageSize: { width, height },
              ...(origin ? { origin } : {}),
              ...(args.query
                ? {
                    query: args.query,
                    matchCount: matches.length,
                    matches,
                    ...(args.redact ? { redactRegions: redactionRects(matches, { width, height }) } : {}),
                  }
                : {}),
              text: lines.map((l) => l.text).join("\n"),
              lines: lines.slice(0, MAX_LINES).map(({ words: _w, ...l }) => l),
              ...(lines.length > MAX_LINES ? { linesTruncated: lines.length - MAX_LINES } : {}),
              ...windowReport,
              note: "OCR is best-effort: small or stylised text can be missed. Review before relying on it, especially for redaction.",
            },
            images,
          );
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}

type Args = {
  input?: string;
  target?: string;
  scanEverySec?: number;
  maxFrames?: number;
  query?: string;
  regex?: boolean;
  redact?: boolean;
  returnImage?: boolean;
};

/** Whole-clip scan (#204): OCR a frame every scanEverySec seconds (widened to
 * fit maxFrames) and report each match with its time. A redaction window runs
 * from the previous sample to the next, since the text may be on screen for
 * any part of the time between two samples. */
async function scanClip(args: Args, work: string, signal: AbortSignal) {
  if (args.input === undefined) throw new ScreencastError("scanEverySec reads a video file: pass input, not target.");
  if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
  if (IMAGE_EXTENSIONS.has(extname(args.input).toLowerCase())) {
    throw new ScreencastError("scanEverySec is for a video input; an image has one frame, so drop scanEverySec.");
  }
  const info = await probeMedia(args.input);
  const maxFrames = args.maxFrames ?? DEFAULT_SCAN_FRAMES;
  const plan = planFpsSampling(info.videoDurationSec ?? info.durationSec, 1 / args.scanEverySec!, maxFrames);
  await runFfmpeg(
    buildSampleByFpsArgs(args.input, plan.fps, join(work, "scan_%05d.png"), maxFrames),
    jobTimeoutMs(info.durationSec),
    { signal },
  );
  const frames = readdirSync(work).filter((f) => f.startsWith("scan_")).sort().map((f) => join(work, f));
  if (frames.length === 0) throw new ScreencastError("Could not read any frames from the video.");
  const step = 1 / plan.fps;
  const times = frames.map((_, i) => Math.round(i * step * 1000) / 1000);
  const end = info.videoDurationSec ?? info.durationSec ?? times[times.length - 1] + step;
  const read = await readFrames(frames, work, signal);

  const matches: Array<TextMatch & { t: number }> = [];
  const redactRegions: Array<ReturnType<typeof redactionRects>[number] & { start: number; end: number }> = [];
  const seenLines = new Set<string>();
  read.forEach((frame, i) => {
    for (const l of frame.lines) seenLines.add(l.text);
    if (!args.query) return;
    const hits = findMatches(frame.lines, args.query, args.regex === true);
    const start = Math.max(0, Math.round((times[i] - step) * 1000) / 1000);
    const stop = Math.min(end, Math.round((times[i] + step) * 1000) / 1000);
    for (const [k, rect] of redactionRects(hits, frame).entries()) {
      matches.push({ t: times[i], ...hits[k] });
      redactRegions.push({ ...rect, start, end: stop });
    }
  });

  const images = [];
  const first = matches[0];
  if ((args.returnImage ?? Boolean(args.query)) && first) {
    const i = times.indexOf(first.t);
    const shown = join(work, "shown.png");
    await runFfmpeg(buildHighlightArgs(frames[i], matches.filter((m) => m.t === first.t), shown), 30_000, { signal });
    images.push(...(await encodeInlineImages([shown], DEFAULT_MAX_IMAGE_WIDTH, 1)).images);
  }
  const text = [...seenLines].join("\n");
  return okResponse(
    {
      input: args.input,
      imageSize: { width: read[0].width, height: read[0].height },
      scan: {
        everySec: Math.round(step * 1000) / 1000,
        framesScanned: frames.length,
        ...(plan.clamped ? { note: `Widened from ${args.scanEverySec} s to fit maxFrames ${maxFrames}.` } : {}),
      },
      ...(args.query
        ? {
            query: args.query,
            matchCount: matches.length,
            matches: matches.slice(0, MAX_LINES),
            ...(args.redact ? { redactRegions } : {}),
          }
        : {}),
      text: text.length > 20_000 ? `${text.slice(0, 20_000)}...` : text,
      note:
        "OCR is best-effort and reads only the sampled frames: text shown briefly between samples, or small " +
        "or stylised text, can be missed. Review before sharing, especially for redaction.",
    },
    images,
  );
}
