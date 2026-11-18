/**
 * App logs on the video clock (#334). While a recording runs, each attached
 * log file is followed from its current end, and every new line is stamped
 * with the wall clock. When the recording ends the lines move onto the
 * video's clock (pauses cut out, like the input event log) and go to
 * `<recording>.logs.jsonl`, which index_recording searches and bug_report
 * quotes around the failure.
 *
 * Following is polling, not fs.watch, so it works the same for files written
 * over SMB, by elevated processes, or by loggers that replace the file: a file
 * that shrinks or is swapped for a new one is read again from the start.
 * Everything but LogTailer is pure.
 */
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { videoTimeSec, type ClockSpan } from "./clock.js";

export const MAX_LOG_SOURCES = 5;
/** Lines kept per recording; a chatty log keeps its newest ones. */
export const MAX_LOG_LINES = 50_000;
/** Longer lines are cut, with "…". */
export const MAX_LOG_LINE = 2_000;
export const LOG_POLL_MS = 250;
/** One poll reads at most this much per file, so a log flooding in never
 * stalls the server; the rest comes on later polls. */
const MAX_READ_BYTES = 1 << 20;

export interface LogSource {
  path: string;
  /** Shown with each line; defaults to the file name. */
  label?: string;
}

export interface RawLogLine {
  epochMs: number;
  source: string;
  line: string;
}

export type LogLevel = "error" | "warn";

export interface LogLine {
  /** Seconds on the video's clock. */
  t: number;
  source: string;
  line: string;
  level?: LogLevel;
}

/** Split new bytes into whole lines, keeping a trailing partial line (and any
 * split UTF-8 character) for the next read. Pure. */
export function splitChunk(partial: Buffer, chunk: Buffer): { lines: string[]; rest: Buffer } {
  const buf = partial.length ? Buffer.concat([partial, chunk]) : chunk;
  const lines: string[] = [];
  let from = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, from)) {
    lines.push(buf.subarray(from, i).toString("utf8").replace(/\r$/, ""));
    from = i + 1;
  }
  return { lines, rest: buf.subarray(from) };
}

/** A line's level from common markers (ERROR, Exception, WARN ...). Pure. */
export function logLevel(line: string): LogLevel | undefined {
  if (/\b(error|err|fatal|critical|exception|unhandled|panic)\b|\btraceback\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b/i.test(line)) return "warn";
  return undefined;
}

const cut = (s: string) => (s.length > MAX_LOG_LINE ? `${s.slice(0, MAX_LOG_LINE - 1)}…` : s);

/** Move stamped lines onto the video clock: before the first frame, in a
 * paused stretch, or after the end, a line is dropped. Blank lines too. Pure. */
export function convertLogLines(raw: readonly RawLogLine[], clock: { startMs: number; endSec: number; spans?: ClockSpan[] }): LogLine[] {
  const out: LogLine[] = [];
  for (const r of raw) {
    if (!r.line.trim()) continue;
    const t = clock.spans?.length ? videoTimeSec(r.epochMs, clock.spans) : (r.epochMs - clock.startMs) / 1000;
    if (t === null || t < 0 || t > clock.endSec) continue;
    const level = logLevel(r.line);
    out.push({ t: Math.round(t * 1000) / 1000, source: r.source, line: cut(r.line), ...(level ? { level } : {}) });
  }
  return out.slice(-MAX_LOG_LINES);
}

export function formatLogsJsonl(lines: readonly LogLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
}

export function parseLogsJsonl(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    try {
      out.push(JSON.parse(row) as LogLine);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

/** `<recording>.logs.jsonl`. */
export function logsPath(recording: string): string {
  return recording.replace(/\.[^./\\]+$/, "") + ".logs.jsonl";
}

interface Followed {
  path: string;
  label: string;
  pos: number;
  ino: number | null;
  partial: Buffer;
}

/** Follows log files from their current end until stopped. */
export class LogTailer {
  private files: Followed[];
  private lines: RawLogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> = Promise.resolve();

  constructor(sources: readonly LogSource[], private readonly now: () => number = Date.now) {
    this.files = sources.map((s) => ({ path: s.path, label: s.label ?? basename(s.path), pos: 0, ino: null, partial: Buffer.alloc(0) }));
  }

  /** Note each file's current end (a missing file is read from its start
   * once it appears). Holds nothing open, so it can run before the capture
   * starts without needing cleanup if the start fails. */
  async mark(): Promise<void> {
    for (const f of this.files) {
      try {
        const st = await stat(f.path);
        f.pos = st.size;
        f.ino = st.ino;
      } catch {
        /* not there yet */
      }
    }
  }

  /** Start polling (after mark: lines written since are read first). */
  follow(intervalMs = LOG_POLL_MS): void {
    this.timer = setInterval(() => {
      this.polling = this.polling.then(() => this.readNew());
    }, intervalMs);
    this.timer.unref();
  }

  /** Read what each file gained since the last read (what a poll does). */
  async readNew(): Promise<void> {
    for (const f of this.files) {
      let st;
      try {
        st = await stat(f.path);
      } catch {
        continue;
      }
      // Rotated (a new file in its place) or truncated: read it from the start.
      if ((f.ino !== null && st.ino !== f.ino) || st.size < f.pos) {
        f.pos = 0;
        f.partial = Buffer.alloc(0);
      }
      f.ino = st.ino;
      if (st.size <= f.pos) continue;
      const want = Math.min(st.size - f.pos, MAX_READ_BYTES);
      let fh;
      try {
        fh = await open(f.path, "r");
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, f.pos);
        f.pos += bytesRead;
        const { lines, rest } = splitChunk(f.partial, buf.subarray(0, bytesRead));
        f.partial = rest.length > MAX_LOG_LINE * 4 ? Buffer.alloc(0) : Buffer.from(rest);
        const at = this.now();
        for (const line of lines) this.lines.push({ epochMs: at, source: f.label, line });
        if (this.lines.length > MAX_LOG_LINES * 2) this.lines = this.lines.slice(-MAX_LOG_LINES);
      } catch {
        /* locked or gone mid-read: try again next poll */
      } finally {
        await fh?.close();
      }
    }
  }

  /** Read what is new one last time, stop, and return every line. */
  async stop(): Promise<RawLogLine[]> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.polling;
    await this.readNew();
    const at = this.now();
    for (const f of this.files) {
      if (f.partial.length) this.lines.push({ epochMs: at, source: f.label, line: f.partial.toString("utf8").replace(/\r$/, "") });
      f.partial = Buffer.alloc(0);
    }
    return this.lines;
  }
}
