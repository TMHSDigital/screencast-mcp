/**
 * Export an animated GIF or WebP under a size budget (#124): encode, measure,
 * step down the settings ladder, and keep the first attempt that fits (or the
 * smallest). Shared by export_gif and pipeline.
 */
import { basename, dirname, extname, join } from "node:path";
import { renameSync, rmSync, statSync } from "node:fs";
import { runEditJob, probeDuration, type ToolExtra } from "./jobs.js";
import {
  animLadder,
  nextLadderIndex,
  buildAnimArgs,
  DEFAULT_ANIM_FPS,
  DEFAULT_ANIM_WIDTH,
  DEFAULT_MAX_BYTES,
  MAX_ATTEMPTS,
  type AnimFormat,
  type AnimSettings,
} from "./anim.js";

export interface AnimExportOptions {
  format?: AnimFormat;
  maxBytes?: number;
  fps?: number;
  width?: number;
  start?: number;
  duration?: number;
}

export async function exportAnimation(input: string, output: string, opts: AnimExportOptions, extra?: ToolExtra) {
  const format: AnimFormat = opts.format ?? "gif";
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const full = await probeDuration(input);
  const clipSec = opts.duration ?? (full !== null ? full - (opts.start ?? 0) : null);
  const ladder = animLadder(format, opts.fps ?? DEFAULT_ANIM_FPS, opts.width ?? DEFAULT_ANIM_WIDTH);

  // Each attempt is its own sibling file so a later, smaller attempt never
  // has to overwrite an earlier one; the winner is renamed onto output.
  const ext = extname(output);
  const attemptPath = (i: number) => join(dirname(output), `${basename(output, ext)}.try${i}${ext}`);
  const attempts: Array<{ path: string; size: number; settings: AnimSettings }> = [];
  try {
    let index: number | null = 0;
    while (index !== null && attempts.length < MAX_ATTEMPTS) {
      const path = attemptPath(attempts.length);
      const clip = { start: opts.start, duration: opts.duration };
      await runEditJob(buildAnimArgs(input, path, format, ladder[index], clip), {
        output: path,
        durationSec: clipSec,
        extra,
      });
      const size = statSync(path).size;
      attempts.push({ path, size, settings: ladder[index] });
      if (size <= maxBytes) break;
      index = nextLadderIndex(index, size, maxBytes, ladder.length);
    }
    const fits = attempts.find((a) => a.size <= maxBytes);
    const chosen = fits ?? attempts.reduce((a, b) => (b.size < a.size ? b : a));
    renameSync(chosen.path, output);
    return {
      outputPath: output,
      format,
      sizeBytes: chosen.size,
      maxBytes,
      withinBudget: chosen.size <= maxBytes,
      settings: chosen.settings,
      attempts: attempts.map((a) => ({ ...a.settings, sizeBytes: a.size })),
      ...(fits
        ? {}
        : {
            note:
              `Could not get under ${maxBytes} bytes; kept the smallest attempt. ` +
              "Export a shorter clip (start/duration), or try format: 'webp'.",
          }),
    };
  } finally {
    for (const a of attempts) rmSync(a.path, { force: true });
  }
}
