/**
 * Where a recording is idle, for cut_idle and the pipeline step (#122, #353):
 * a frozen (and silent) screen, no input in the event log, or both.
 */
import { existsSync, readFileSync } from "node:fs";
import { ScreencastError } from "./errors.js";
import { runCapture } from "./ffmpeg.js";
import { eventPaths, parseEventsJsonl } from "./events.js";
import { buildIdleScanArgs, eventIdle, intersect, parseFreezes, parseSilences, type IdleBasis, type IdleScanOptions, type Interval } from "./idle.js";

export interface FindIdleOptions extends IdleScanOptions {
  basis?: IdleBasis;
  minIdleSec: number;
  useAudio: boolean;
  duration: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The idle stretches on the input's clock, and a phrase saying what idle meant. */
export async function findIdle(ffmpeg: string, input: string, o: FindIdleOptions): Promise<{ idle: Interval[]; rule: string }> {
  const basis = o.basis ?? "screen";
  let fromEvents: Interval[] | null = null;
  if (basis !== "screen") {
    const log = eventPaths(input).jsonl;
    if (!existsSync(log)) {
      throw new ScreencastError(`basis "${basis}" needs the recording's event log (${log}).`, 'Record with start_recording events: true, or use basis "screen".');
    }
    fromEvents = eventIdle(parseEventsJsonl(readFileSync(log, "utf8")), o.duration, o.minIdleSec);
    if (basis === "events") return { idle: fromEvents, rule: "no clicks, wheel or typing" };
  }
  const scan = await runCapture(ffmpeg, buildIdleScanArgs(input, o.minIdleSec, o.useAudio, o), o.timeoutMs, { signal: o.signal });
  if (scan.code !== 0) throw new ScreencastError(`Idle scan failed (exit ${scan.code}): ${scan.stderr.trim().slice(-400)}`);
  const freezes = parseFreezes(scan.stderr, o.duration);
  let idle = o.useAudio ? intersect(freezes, parseSilences(scan.stderr, o.duration)) : freezes;
  let rule = o.useAudio ? "frozen video and silent audio" : "frozen video";
  if (fromEvents) {
    idle = intersect(idle, fromEvents);
    rule += ", and no clicks, wheel or typing";
  }
  return { idle, rule };
}
