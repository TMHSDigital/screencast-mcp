/**
 * perf_overlay (#335): draw a recording's performance track on the video. The
 * whole track becomes a small bar chart (one bar per time slice, the busy ones
 * in red) in a corner, and a playhead moves across it with the video, so a
 * viewer sees where the CPU spike is while watching it happen. One ffmpeg
 * pass; the chart is a fixed number of drawbox bars however long the video.
 * Pure.
 */
import { ScreencastError } from "./errors.js";
import { escapeFilterPath } from "./fonts.js";
import { encodeTail, type Quality } from "./targets.js";
import { BUSY_CPU_PCT, type PerfSample } from "./perf.js";

export const PERF_METRICS = ["cpu", "sysCpu", "rssMB", "sysMem"] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];
export const PERF_CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"] as const;
export type PerfCorner = (typeof PERF_CORNERS)[number];

/** Bars in the chart, whatever the video's length. */
export const PERF_BARS = 120;

/** What each metric is called on the chart. */
export const METRIC_LABELS: Record<PerfMetric, string> = {
  cpu: "App CPU %",
  sysCpu: "CPU %",
  rssMB: "App memory MB",
  sysMem: "Memory %",
};

/** One value per time slice of [0, durationSec): the highest sample in it, or
 * the last value seen before it when a slice has none. Pure. */
export function chartValues(samples: readonly PerfSample[], metric: PerfMetric, durationSec: number, bars = PERF_BARS): Array<number | null> {
  if (!(durationSec > 0)) throw new ScreencastError("The video has no duration.");
  const out: Array<number | null> = new Array<number | null>(bars).fill(null);
  for (const s of samples) {
    const v = s[metric];
    if (v === undefined || !Number.isFinite(v) || s.t < 0 || s.t >= durationSec) continue;
    const i = Math.min(bars - 1, Math.floor((s.t / durationSec) * bars));
    out[i] = Math.max(out[i] ?? -Infinity, v);
  }
  let last: number | null = null;
  return out.map((v) => (v === null ? last : (last = v)));
}

/** The chart's full scale: 100 for percentages, the peak (rounded up) for MB. Pure. */
export function chartScale(metric: PerfMetric, values: ReadonlyArray<number | null>): number {
  if (metric !== "rssMB") return 100;
  const peak = Math.max(0, ...values.map((v) => v ?? 0));
  return peak > 0 ? Math.ceil(peak / 50) * 50 : 1;
}

export interface PerfOverlayOptions {
  metric: PerfMetric;
  corner: PerfCorner;
  /** Chart size in video pixels. */
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  durationSec: number;
  /** A text file holding the label, and the font to draw it with. */
  label?: { textFile: string; fontFile: string };
  quality?: Quality;
  hasAudio: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function buildPerfOverlayArgs(input: string, output: string, values: ReadonlyArray<number | null>, o: PerfOverlayOptions): string[] {
  const W = even(o.width);
  const H = even(o.height);
  if (W > o.videoWidth || H > o.videoHeight) throw new ScreencastError("The chart is larger than the video.");
  const scale = chartScale(o.metric, values);
  const top = Math.round(H * 0.25); // room for the label
  const plot = H - top - 4;
  const bw = W / values.length;
  const bars = values.flatMap((v, i) => {
    if (v === null || v <= 0) return [];
    const h = Math.max(1, Math.round((Math.min(v, scale) / scale) * plot));
    const busy = o.metric !== "rssMB" && o.metric !== "sysMem" && v >= BUSY_CPU_PCT;
    return [`drawbox=x=${Math.floor(i * bw)}:y=${H - 2 - h}:w=${Math.max(1, Math.ceil(bw))}:h=${h}:color=${busy ? "0xFF5252" : "0x4FC3F7"}@0.95:t=fill`];
  });
  const D = Number(o.durationSec.toFixed(3));

  const label = o.label
    ? `,drawtext=fontfile=${escapeFilterPath(o.label.fontFile)}:textfile=${escapeFilterPath(o.label.textFile)}:expansion=none:` +
      `fontcolor=white:fontsize=${Math.max(10, Math.round(top * 0.7))}:x=6:y=${Math.round(top * 0.15)}`
    : "";
  const margin = Math.round(Math.min(o.videoWidth, o.videoHeight) * 0.02);
  const x = o.corner.endsWith("left") ? margin : o.videoWidth - W - margin;
  const y = o.corner.startsWith("top") ? margin : o.videoHeight - H - margin;
  // An opaque panel keeps the bars' colours (drawbox does not write alpha).
  // The playhead is its own stream: overlay re-evaluates x every frame,
  // where drawbox's x is evaluated once.
  const chart = [`color=c=0x1E1E1E:s=${W}x${H}:d=${D}:r=30`, "format=yuv420p", ...bars].join(",") + label;
  const playhead = `color=c=white:s=2x${H - top}:d=${D}:r=30`;
  return [
    "-y", "-i", input,
    "-filter_complex",
    `${chart}[c];${playhead}[p];[c][p]overlay=x='min(${W - 2},t/${D}*${W})':y=${top}:shortest=1[g];[0:v][g]overlay=x=${x}:y=${y}:shortest=1[v]`,
    "-map", "[v]", "-map", "0:a?",
    ...encodeTail({ quality: o.quality ?? "standard", audio: o.hasAudio ? "copy" : "omit", faststart: true }),
    output,
  ];
}
