/**
 * OCR over video frames (#204, #198): sample a clip every N seconds, read each
 * frame with the Windows OCR engine, and turn the matches into timed redaction
 * windows. Shared by find_text (scanEverySec) and bug_report, so the secret
 * scan behind both is the same code.
 *
 * readFrames and scanVideoFrames run ffmpeg and PowerShell; scanMatches is pure.
 */
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { ScreencastError } from "./errors.js";
import { probeMedia, runFfmpeg } from "./ffmpeg.js";
import { jobTimeoutMs } from "./jobs.js";
import { buildSampleByFpsArgs, planFpsSampling } from "./media.js";
import { recognize, mergePasses, findMatches, redactionRects, passScales, type OcrLine, type TextMatch } from "./ocr.js";
import type { Rect } from "./diff.js";
import { mapPool } from "./pool.js";

export interface ReadFrame {
  lines: OcrLine[];
  width: number;
  height: number;
}

/** One ffmpeg run that writes every OCR pass of a frame: the frame is split
 * and upscaled once per scale. The PNGs are scratch read straight back by
 * OCR, so they are written uncompressed (#291). Pure. */
export function buildOcrPassArgs(source: string, scales: number[], outputs: string[]): string[] {
  if (scales.length === 0 || scales.length !== outputs.length) {
    throw new ScreencastError("Each OCR pass needs one output.");
  }
  const scale = (s: number) => `scale=iw*${s}:ih*${s}:flags=lanczos`;
  const png = ["-compression_level", "0"];
  if (scales.length === 1) return ["-y", "-v", "error", "-i", source, "-vf", scale(scales[0]!), ...png, outputs[0]!];
  const labels = scales.map((_s, i) => `[s${i}]`);
  const graph = [`[0:v]split=${scales.length}${labels.join("")}`, ...scales.map((s, i) => `${labels[i]}${scale(s)}[o${i}]`)].join(";");
  return [
    "-y", "-v", "error", "-i", source, "-filter_complex", graph,
    ...outputs.flatMap((out, i) => ["-map", `[o${i}]`, ...png, out]),
  ];
}

/** OCR several frames in one PowerShell run: each frame is upscaled for every
 * pass (passScales), and the passes are merged back per frame. `sameSize`
 * probes only the first frame, for frames sampled from one video (#291). */
export async function readFrames(
  sources: string[],
  work: string,
  signal?: AbortSignal,
  opts: { sameSize?: boolean } = {},
): Promise<ReadFrame[]> {
  const sizeOf = async (source: string) => {
    const { width, height } = await probeMedia(source);
    if (!width || !height) throw new ScreencastError("Could not read the image size.");
    return { width, height };
  };
  const shared = opts.sameSize && sources[0] ? await sizeOf(sources[0]) : null;
  const sized = await mapPool(sources, async (source) => ({ source, ...(shared ?? (await sizeOf(source))) }));
  // One ffmpeg per frame for all its scales, a few frames at a time.
  const perFrame = await mapPool(sized, async ({ source, width, height }, f) => {
    const scales = passScales(width, height);
    const outs = scales.map((_s, i) => join(work, `pass${f}-${i}.png`));
    await runFfmpeg(buildOcrPassArgs(source, scales, outs), 60_000, { signal });
    return scales.map((scale, i) => ({ out: outs[i]!, scale, f }));
  });
  const flat = perFrame.flat();
  const passes = flat.map((p) => p.out);
  const passScaleList = flat.map((p) => p.scale);
  const owner = flat.map((p) => p.f);
  const results = await recognize(passes, passScaleList);
  return sized.map(({ width, height }, f) => ({
    lines: mergePasses(results.filter((_r, i) => owner[i] === f)),
    width,
    height,
  }));
}

export interface ScannedFrame extends ReadFrame {
  /** Seconds from the start of the scanned range. */
  t: number;
  /** The sampled PNG (inside the caller's work dir). */
  path: string;
}

export interface VideoScan {
  frames: ScannedFrame[];
  /** Seconds between samples, after widening to fit maxFrames. */
  step: number;
  /** Length of the scanned range in seconds. */
  end: number;
  /** True when everySec was widened to fit maxFrames. */
  clamped: boolean;
}

/** Sample `input` every `everySec` seconds (widened to fit `maxFrames`) into
 * `work`, optionally only `range`, and OCR every sample. Times are relative to
 * the range start. */
export async function scanVideoFrames(
  input: string,
  opts: { everySec: number; maxFrames: number; range?: { start: number; duration: number } },
  work: string,
  signal?: AbortSignal,
): Promise<VideoScan> {
  const info = await probeMedia(input);
  const full = info.videoDurationSec ?? info.durationSec;
  const length = opts.range ? opts.range.duration : full;
  const plan = planFpsSampling(length, 1 / opts.everySec, opts.maxFrames);
  await runFfmpeg(
    buildSampleByFpsArgs(input, plan.fps, join(work, "scan_%05d.png"), opts.maxFrames, false, opts.range),
    jobTimeoutMs(info.durationSec),
    { signal },
  );
  const paths = readdirSync(work).filter((f) => f.startsWith("scan_")).sort().map((f) => join(work, f));
  if (paths.length === 0) throw new ScreencastError("Could not read any frames from the video.");
  const step = 1 / plan.fps;
  const timeAt = (i: number) => Math.round(i * step * 1000) / 1000;
  const end = length ?? timeAt(paths.length - 1) + step;
  const read = await readFrames(paths, work, signal, { sameSize: true });
  return {
    frames: read.map((frame, i) => ({ ...frame, t: timeAt(i), path: paths[i] ?? "" })),
    step,
    end,
    clamped: plan.clamped,
  };
}

export type TimedMatch = TextMatch & { t: number };
export type TimedRect = Rect & { start: number; end: number };

/** The window a hit at `t` must be covered for: from the previous sample to
 * the next, since the text may be on screen for any part of the time between
 * two samples. Pure. */
export function sampleWindow(t: number, step: number, end: number): { start: number; end: number } {
  return {
    start: Math.max(0, Math.round((t - step) * 1000) / 1000),
    end: Math.min(end, Math.round((t + step) * 1000) / 1000),
  };
}

/** Every match of `query` in a scan, with its time, and a padded, timed
 * redaction rectangle per match (or per matching line, with scope "line").
 * Pure. */
export function scanMatches(
  scan: Pick<VideoScan, "frames" | "step" | "end">,
  query: string,
  regex: boolean,
  scope: "match" | "line" = "match",
): { matches: TimedMatch[]; redactRegions: TimedRect[] } {
  const matches: TimedMatch[] = [];
  const redactRegions: TimedRect[] = [];
  for (const frame of scan.frames) {
    const hits = findMatches(frame.lines, query, regex);
    const window = sampleWindow(frame.t, scan.step, scan.end);
    // redactionRects maps boxes one to one.
    const boxes =
      scope === "line"
        ? [...new Set(hits.map((h) => frame.lines.find((l) => l.text === h.line) ?? h))]
        : hits;
    for (const hit of hits) matches.push({ t: frame.t, ...hit });
    for (const rect of redactionRects(boxes, frame)) redactRegions.push({ ...rect, ...window });
  }
  return { matches, redactRegions };
}
