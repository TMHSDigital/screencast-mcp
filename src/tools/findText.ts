import { z } from "zod";
import { extname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { resolveCaptureTarget } from "../utils/resolveTarget.js";
import { captureStill } from "../utils/still.js";
import { buildHighlightArgs } from "../utils/diff.js";
import { recognize, mergePasses, findMatches, redactionRects, passScales } from "../utils/ocr.js";
import { windowMatchReport } from "../utils/windows.js";
import { subdir, stamp, rand } from "../utils/paths.js";
import { encodeInlineImages, DEFAULT_MAX_IMAGE_WIDTH } from "../utils/images.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tif", ".tiff"]);
const MAX_LINES = 300;

const inputSchema = {
  target: z
    .string()
    .optional()
    .describe("Read text live from the screen: 'full' | 'monitor:<index>' | 'window:<title>' | 'region:...'."),
  input: z.string().optional().describe("Or read text from an image or video file (one of target / input)."),
  timestamp: z.number().nonnegative().optional().describe("For a video input: the second to read (default 0)."),
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
        "O vs 0). Without a query, all recognised text is returned.",
    ),
  regex: z.boolean().optional().describe("Treat query as a regular expression (case-insensitive)."),
  redact: z
    .boolean()
    .optional()
    .describe(
      "Also return padded rectangles around each match, ready to pass to redact_region " +
        "(regions) to cover them. Detection is best-effort: review the result.",
    ),
  returnImage: z
    .boolean()
    .optional()
    .describe("Return the image inline with matches outlined in red (default true when there is a query)."),
};

export function register(server: McpServer): void {
  server.tool(
    "find_text",
    "Read text on screen or in an image/video frame with the OCR engine built into Windows " +
      "(no install), with each line's and match's bounding box. Find where a label or button " +
      "is, check what the screen says, or locate secrets (e.g. regex 'sk-|ghp_|api.?key') and get " +
      "redact_region rectangles for them. Best-effort detection: always review.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        if ((args.target === undefined) === (args.input === undefined)) {
          throw new ScreencastError("Provide exactly one of: target (live screen) or input (a file).");
        }
        const work = mkdtempSync(join(tmpdir(), "screencast-ocr-"));
        try {
          // 1. Get the source as one PNG frame.
          let source: string;
          let windowReport: Record<string, unknown> = {};
          if (args.target !== undefined) {
            const resolved = await resolveCaptureTarget(args.target, { exactTitle: args.exactTitle });
            source = join(subdir("screenshots"), `ocr-${stamp()}-${rand()}.png`);
            await captureStill(resolved, source, args.backend ?? "gdigrab");
            if (resolved.window) windowReport = windowMatchReport(resolved.window);
          } else {
            if (!existsSync(args.input!)) throw new ScreencastError(`Input file not found: ${args.input}`);
            const isImage = IMAGE_EXTENSIONS.has(extname(args.input!).toLowerCase());
            source = join(work, "frame.png");
            await runFfmpeg(
              ["-y", "-v", "error", ...(isImage ? [] : ["-ss", String(args.timestamp ?? 0)]), "-i", args.input!, "-frames:v", "1", source],
              60_000,
            );
          }
          const { width, height } = await probeMedia(source);
          if (!width || !height) throw new ScreencastError("Could not read the image size.");

          // 2. Upscaled copies for each recognition pass, then OCR them in one run.
          const scales = passScales(width, height);
          const passes = scales.map((s, i) => join(work, `pass${i}.png`));
          for (let i = 0; i < scales.length; i++) {
            await runFfmpeg(
              ["-y", "-v", "error", "-i", source, "-vf", `scale=iw*${scales[i]}:ih*${scales[i]}:flags=lanczos`, passes[i]],
              60_000,
            );
          }
          const lines = mergePasses(await recognize(passes, scales));

          // 3. Match, and optionally outline / suggest redactions.
          const matches = args.query ? findMatches(lines, args.query, args.regex === true) : [];
          const images = [];
          const wantImage = args.returnImage ?? Boolean(args.query);
          if (wantImage) {
            const shown = join(work, "shown.png");
            await runFfmpeg(buildHighlightArgs(source, matches, shown), 30_000);
            images.push(...(await encodeInlineImages([shown], DEFAULT_MAX_IMAGE_WIDTH, 1)).images);
          }
          return okResponse(
            {
              ...(args.target !== undefined ? { screenshotPath: source } : { input: args.input }),
              imageSize: { width, height },
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
