/**
 * The video clock: when a capture's first frame was grabbed, and how wall-clock
 * times map to video seconds across pause/resume spans. Sidecars (input events,
 * app logs, perf samples) all convert to this clock. Pure.
 */

/** The first input's start time in epoch ms from ffmpeg's stderr banner, or
 * null if it has not been printed. gdigrab stamps frames with wall-clock time,
 * so `start: 1792936190.232363` is when the first frame was grabbed. */
export function parseCaptureStart(stderr: string, inputIndex = 0): number | null {
  const input = stderr.indexOf(`Input #${inputIndex},`);
  if (input < 0) return null;
  const next = stderr.indexOf("Input #", input + 1);
  const m = /start: (\d{9,}\.\d+)/.exec(stderr.slice(input, next < 0 ? undefined : next));
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** One recorded stretch of a paused-and-resumed recording (#200): it began at
 * `startMs` (epoch) and sits at `offsetSec` in the joined video. The last one
 * may be open-ended (still recording). */
export interface ClockSpan {
  startMs: number;
  offsetSec: number;
  durationSec?: number;
}

/** Map an epoch time to video seconds across spans; null inside a pause.
 * Before the first span, times stay negative (dropped like before). Pure. */
export function videoTimeSec(epochMs: number, spans: ClockSpan[]): number | null {
  const first = spans[0];
  if (!first) return null;
  if (epochMs < first.startMs) return (epochMs - first.startMs) / 1000;
  for (const s of spans) {
    const rel = (epochMs - s.startMs) / 1000;
    if (rel >= 0 && (s.durationSec === undefined || rel <= s.durationSec)) return s.offsetSec + rel;
  }
  return null;
}
