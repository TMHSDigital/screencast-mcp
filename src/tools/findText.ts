import { z } from "zod";
import { extname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, runFfmpeg } from "../utils/ffmpeg.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { captureStill } from "../utils/still.js";
import { buildHighlightArgs, targetSize } from "../utils/diff.js";
import { findMatches, redactionRects } from "../utils/ocr.js";
import { readFrames, scanVideoFrames, scanMatches } from "../utils/ocrScan.js";
import { windowMatchReport } from "../utils/windows.js";
import { confirmCapture, describeTarget } from "../utils/consent.js";
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
    .describe("Live screen target (full | monitor:<i> | window:... | region:...), or pass input."),
  input: z.string().optional().describe("Image or video file to read instead of a live target."),
  timestamp: z.number().nonnegative().optional().describe("Video input: second to read (default 0)."),
  scanEverySec: z
    .number()
    .positive()
    .optional()
    .describe(
      "Video input: scan a frame every N s across the clip (e.g. for secrets before sharing); matches " +
        "and redactRegions get times. Widens to stay within maxFrames.",
    ),
  maxFrames: z
    .number()
    .int()
    .min(1)
    .max(MAX_SCAN_FRAMES)
    .optional()
    .describe(`scanEverySec frame cap (default ${DEFAULT_SCAN_FRAMES}; ~1 s each).`),
  exactTitle: z.boolean().optional().describe("window: targets match the whole title only (default false)."),
  backend: z
    .enum(["gdigrab", "wgc"])
    .optional()
    .describe(
      "Live target: gdigrab (default) = what is visible; wgc (window:, FFmpeg 8+) = the window even if covered.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Text to find (case-insensitive, tolerates OCR misreads like I/l, O/0, _/-). Omit to return all text.",
    ),
  regex: z.boolean().optional().describe("Treat query as a regular expression (case-insensitive)."),
  redact: z
    .boolean()
    .optional()
    .describe(
      "Also return padded match rectangles ready for redact_region's regions.",
    ),
  keep: z
    .boolean()
    .optional()
    .describe(
      "Live target: keep the capture and return its path (default false: deleted after reading).",
    ),
  returnImage: z
    .boolean()
    .optional()
    .describe("Return the image with matches outlined (default: true with a query)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "find_text",
    {
      title: "Find Text (OCR)",
      description:
        "OCR (built into Windows) on the screen, an image, or video frames, with line and match boxes " +
        "in image pixels (add `origin` for desktop coordinates). Locate UI text or secrets (e.g. regex " +
        "'sk-|ghp_|api.?key') to redact. Best-effort: review results.",
      inputSchema,
      outputSchema: looseOutput({
        imageSize: looseOutput({ width: z.number(), height: z.number() }),
      }),
      annotations: READ_ONLY,
    },
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
            await confirmCapture(server, `Capture ${describeTarget(args.target, resolved.window)} once to read the text on it?`, extra.signal);
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
          const [frame] = await readFrames([source], work, extra.signal);
          if (!frame) throw new ScreencastError("Could not read the frame.");
          const { lines, width, height } = frame;

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
  const maxFrames = args.maxFrames ?? DEFAULT_SCAN_FRAMES;
  const scan = await scanVideoFrames(args.input, { everySec: args.scanEverySec!, maxFrames }, work, signal);
  const { step } = scan;
  // Every sampled frame has the same size.
  const [size] = scan.frames;
  if (!size) throw new ScreencastError("Could not read any frames from the video.");
  const seenLines = new Set<string>();
  for (const frame of scan.frames) for (const l of frame.lines) seenLines.add(l.text);
  const { matches, redactRegions } = args.query
    ? scanMatches(scan, args.query, args.regex === true)
    : { matches: [], redactRegions: [] };

  const images = [];
  const first = matches[0];
  const firstFrame = first && scan.frames.find((f) => f.t === first.t)?.path;
  if ((args.returnImage ?? Boolean(args.query)) && first && firstFrame) {
    const shown = join(work, "shown.png");
    await runFfmpeg(buildHighlightArgs(firstFrame, matches.filter((m) => m.t === first.t), shown), 30_000, { signal });
    images.push(...(await encodeInlineImages([shown], DEFAULT_MAX_IMAGE_WIDTH, 1)).images);
  }
  const text = [...seenLines].join("\n");
  return okResponse(
    {
      input: args.input,
      imageSize: { width: size.width, height: size.height },
      scan: {
        everySec: Math.round(step * 1000) / 1000,
        framesScanned: scan.frames.length,
        ...(scan.clamped ? { note: `Widened from ${args.scanEverySec} s to fit maxFrames ${maxFrames}.` } : {}),
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
