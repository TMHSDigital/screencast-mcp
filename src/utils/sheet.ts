/**
 * Contact sheets and poster frames (#115).
 *
 * A contact sheet tiles N timestamped frames of a video into one image, so an
 * agent can see a whole recording in a single image read. Each tile is grabbed
 * at its own timestamp (accurate seek), scaled to a fixed width, and labelled;
 * a final pass tiles them. All builders here are pure.
 */
import { ScreencastError } from "./errors.js";
import { escapeFilterPath, bundledFontPath } from "./fonts.js";
import { stillOutput, sequencePattern } from "./paths.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mapPool } from "./pool.js";
import { runFfmpeg } from "./ffmpeg.js";

export const DEFAULT_SHEET_COUNT = 12;
export const MAX_SHEET_COUNT = 48;
export const DEFAULT_TILE_WIDTH = 320;

/** `count` timestamps spread evenly across the video, each in the middle of
 * its slice (so the first is not a black opening frame). Millisecond precision. */
export function evenTimes(durationSec: number, count: number): number[] {
  if (!(durationSec > 0)) throw new ScreencastError("Could not read the video's duration.");
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * durationSec) / count * 1000) / 1000);
}

/** `m:ss.s`, or `h:mm:ss` from an hour up. */
export function formatTimecode(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const rest = (tenths % 600) / 10;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(rest)).padStart(2, "0")}`;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Grid for `count` tiles: `columns` if given, else one row for up to four
 * tiles and roughly square beyond that. */
export function sheetGrid(count: number, columns?: number): { columns: number; rows: number } {
  const auto = count <= 4 ? count : Math.ceil(Math.sqrt(count));
  const c = Math.max(1, Math.min(count, columns ?? auto));
  return { columns: c, rows: Math.ceil(count / c) };
}

/** Grab one labelled tile: seek to `timeSec`, scale to `tileWidth`, and draw
 * the label (read from `labelFile`, so no text escaping is needed). */
export function buildTileArgs(
  input: string,
  timeSec: number,
  output: string,
  tileWidth: number,
  fontFile: string,
  labelFile: string,
): string[] {
  if (!Number.isInteger(tileWidth) || tileWidth < 64) {
    throw new ScreencastError("tileWidth must be an integer of at least 64.");
  }
  const fontSize = Math.max(12, Math.round(tileWidth / 16));
  const label =
    `drawtext=fontfile=${escapeFilterPath(fontFile)}:textfile=${escapeFilterPath(labelFile)}:expansion=none:` +
    `fontcolor=white:fontsize=${fontSize}:x=6:y=h-text_h-6:box=1:boxcolor=black@0.6:boxborderw=4`;
  return [
    "-y", "-v", "error", "-ss", String(timeSec), "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${tileWidth}:-2,${label}`,
    ...stillOutput(output),
  ];
}

/** Tile a numbered PNG sequence into one image; unused cells stay black. */
export function buildSheetArgs(
  tilePattern: string,
  grid: { columns: number; rows: number },
  output: string,
): string[] {
  return [
    "-y", "-v", "error", "-framerate", "1", "-i", tilePattern,
    "-vf", `tile=${grid.columns}x${grid.rows}:padding=4:margin=4:color=black`,
    "-frames:v", "1",
    ...stillOutput(output),
  ];
}

/** A single representative poster frame: sample 30 candidates across the
 * whole video and let ffmpeg's `thumbnail` filter pick the most typical. */
export function buildPosterArgs(input: string, durationSec: number, output: string, width: number): string[] {
  if (!(durationSec > 0)) throw new ScreencastError("Could not read the video's duration.");
  const candidates = 30;
  const rate = Math.max(1e-4, candidates / durationSec);
  return [
    "-y", "-v", "error", "-i", input,
    "-vf", `fps=${rate.toFixed(4)},thumbnail=${candidates},scale='min(${width},iw)':-2`,
    "-frames:v", "1",
    ...stillOutput(output),
  ];
}

/** Tile timecode-labelled frames of `input` at `times` into one PNG at
 * `output`; shared with bug_report (#198). Returns the grid used. */
export async function renderContactSheet(
  input: string,
  times: number[],
  output: string,
  opts: { tileWidth: number; columns?: number },
  signal?: AbortSignal,
): Promise<{ columns: number; rows: number }> {
  const grid = sheetGrid(times.length, opts.columns);
  // Tiles and their label files live in a private temp dir, removed
  // whatever happens.
  const work = mkdtempSync(join(tmpdir(), "screencast-sheet-"));
  try {
    const font = bundledFontPath("bold");
    await mapPool(times, async (t, i) => {
      const labelFile = join(work, `label_${i}.txt`);
      writeFileSync(labelFile, formatTimecode(t));
      const tile = join(work, `tile_${String(i).padStart(3, "0")}.png`);
      await runFfmpeg(buildTileArgs(input, t, tile, opts.tileWidth, font, labelFile), 60_000, { signal });
    });
    await runFfmpeg(buildSheetArgs(sequencePattern(work, "tile_%03d.png"), grid, output), 60_000, { signal });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return grid;
}
