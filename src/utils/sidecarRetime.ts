/**
 * The input's event log, app log and perf sidecars, moved onto an edited
 * output's timeline (#352), so step_guide, read_events, zoom and bug_report
 * work on a trimmed or cut_idle'd result as they do on the raw recording.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TimeOp } from "./chapters.js";
import { eventPaths, formatEventsJsonl, parseEventsJsonl, type InputEvent } from "./events.js";
import { logsPath } from "./logTail.js";
import { perfPath } from "./perf.js";
import { mapTime } from "./timeline.js";

/** Source pixels -> output pixels (x * sx + ox), as the pipeline tracks it
 * while only crops and scales have changed the frame. */
export interface Geometry {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Items with a `t` on the source's clock, moved through `ops`; those trimmed
 * away or past the output's end are dropped. Pure. */
export function retimeTimed<T extends { t: number }>(items: readonly T[], ops: readonly TimeOp[], durationSec: number | null): T[] {
  return items.flatMap((it) => {
    const t = mapTime(it.t, ops);
    return t === null || (durationSec !== null && t > durationSec) ? [] : [{ ...it, t: r3(t) }];
  });
}

/** Input events moved through `ops` and `geo` onto a `width` x `height`
 * output. A burst's or gap's length is mapped by its end. Pure. */
export function retimeEvents(
  events: readonly InputEvent[],
  ops: readonly TimeOp[],
  geo: Geometry,
  size: { width: number; height: number; durationSec: number | null },
): InputEvent[] {
  return events.flatMap((e) => {
    const t = mapTime(e.t, ops);
    if (t === null || (size.durationSec !== null && t > size.durationSec)) return [];
    const x = Math.round(e.x * geo.sx + geo.ox);
    const y = Math.round(e.y * geo.sy + geo.oy);
    const out: InputEvent = { ...e, t: r3(t), x, y, inFrame: e.inFrame && x >= 0 && y >= 0 && x < size.width && y < size.height };
    if (e.durationSec !== undefined) {
      const end = mapTime(e.t + e.durationSec, ops) ?? size.durationSec ?? t;
      out.durationSec = r3(Math.max(0, end - t));
    }
    return [out];
  });
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

const toJsonl = (items: readonly unknown[]) => items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : "");

/** Write the output's sidecars from the input's. `geo` null means a zoom,
 * reframe or backdrop moved the content, so logged positions no longer match:
 * the event log is left out and a note says why. Best effort per file. */
export function writeRetimedSidecars(
  input: string,
  output: string,
  plan: { timeOps: readonly TimeOp[]; geometry: Geometry | null; width: number; height: number; durationSec: number | null },
): { eventsPath?: string; logsPath?: string; perfPath?: string; note?: string } {
  const res: { eventsPath?: string; logsPath?: string; perfPath?: string; note?: string } = {};
  const evIn = eventPaths(input).jsonl;
  if (existsSync(evIn)) {
    if (!plan.geometry) {
      res.note = "The input's event log was not carried over: a zoom, reframe or backdrop moved the content, so logged positions no longer match.";
    } else {
      try {
        const events = retimeEvents(parseEventsJsonl(readFileSync(evIn, "utf8")), plan.timeOps, plan.geometry, plan);
        const path = eventPaths(output).jsonl;
        writeFileSync(path, formatEventsJsonl(events));
        res.eventsPath = path;
      } catch {
        /* best effort: the video is written */
      }
    }
  }
  for (const [key, pathOf] of [
    ["logsPath", logsPath],
    ["perfPath", perfPath],
  ] as const) {
    const from = pathOf(input);
    if (!existsSync(from)) continue;
    try {
      const path = pathOf(output);
      writeFileSync(path, toJsonl(retimeTimed(readJsonl<{ t: number }>(from), plan.timeOps, plan.durationSec)));
      res[key] = path;
    } catch {
      /* best effort */
    }
  }
  return res;
}
