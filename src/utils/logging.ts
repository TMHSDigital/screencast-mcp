/**
 * MCP logging notifications (#222): ffmpeg warnings (dropped frames, a full
 * audio buffer) and notable capture events reach the client as
 * `notifications/message` instead of being dropped. Each server registers
 * itself when it is built; a message goes to every connected one, filtered by
 * the level its client set with `logging/setLevel` (the SDK does that).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

export const LOGGER_NAME = "screencast-mcp";

const servers = new Set<McpServer>();

/** Route log messages to this server's client. */
export function attachLogging(server: McpServer): void {
  servers.add(server);
}

/** Send a log message to every connected client. Never throws: a log line
 * must not fail the capture or edit it describes. */
export function logMessage(level: LoggingLevel, message: string, data: Record<string, unknown> = {}): void {
  for (const server of servers) {
    if (!server.isConnected()) continue;
    server
      .sendLoggingMessage({ level, logger: LOGGER_NAME, data: { message, ...data } })
      .catch(() => {});
  }
}

/** ffmpeg's periodic stats line (`frame=  12 fps=10 ... drop=0 speed=1x`). */
const PROGRESS = /^\s*(?:frame|size)=/;
const WARNING =
  /\b(?:warning|deprecated|dropp(?:ed|ing)|too full|discard\w*|non[- ]?monoton\w*|past duration|could not|cannot|failed|invalid|corrupt\w*|missing|error)\b/i;
/** Lines that match WARNING but are noise: the build banner, and swscale's
 * notice about full-range input that every PNG/JPEG conversion prints. */
const BENIGN = /^\s*configuration:|deprecated pixel format used/i;
/** At most this many distinct lines per job or recording. */
export const MAX_WARNINGS = 20;

function isWarning(line: string): boolean {
  return !PROGRESS.test(line) && WARNING.test(line) && !BENIGN.test(line);
}

/** The distinct warning lines in an ffmpeg stderr transcript, in order. */
export function ffmpegWarnings(stderr: string): string[] {
  const out = new Set<string>();
  for (const raw of stderr.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (line && isWarning(line)) out.add(line);
    if (out.size >= MAX_WARNINGS) break;
  }
  return [...out];
}

/** Forward the warnings in a finished ffmpeg job's stderr, as one message. */
export function logFfmpegWarnings(stderr: string, data: Record<string, unknown> = {}): void {
  const warnings = ffmpegWarnings(stderr);
  if (warnings.length > 0) logMessage("warning", "ffmpeg reported warnings.", { ...data, warnings });
}

/** Report dropped frames at most this often while a recording runs. */
export const DROP_REPORT_INTERVAL_MS = 10_000;

/**
 * Watches a long-running capture's stderr as it streams: each distinct
 * warning line is forwarded once, and a growing `drop=` count in the stats
 * line is reported at most every DROP_REPORT_INTERVAL_MS.
 */
export class StderrWatch {
  private partial = "";
  private readonly seen = new Set<string>();
  private dropped = 0;
  private lastDropReport = -Infinity;

  constructor(
    private readonly data: () => Record<string, unknown>,
    private readonly send: typeof logMessage = logMessage,
    private readonly now: () => number = Date.now,
  ) {}

  feed(chunk: string): void {
    const parts = (this.partial + chunk).split(/[\r\n]/);
    this.partial = parts.pop() ?? "";
    for (const raw of parts) this.line(raw.trim());
  }

  private line(line: string): void {
    if (!line) return;
    if (PROGRESS.test(line)) {
      const drop = Number(/\bdrop=\s*(\d+)/.exec(line)?.[1] ?? 0);
      if (drop > this.dropped && this.now() - this.lastDropReport >= DROP_REPORT_INTERVAL_MS) {
        this.lastDropReport = this.now();
        this.dropped = drop;
        this.send("warning", `The recording has dropped ${drop} frame(s) so far.`, { ...this.data(), dropped: drop });
      }
      return;
    }
    if (!isWarning(line) || this.seen.has(line) || this.seen.size >= MAX_WARNINGS) return;
    this.seen.add(line);
    this.send("warning", line, { ...this.data(), source: "ffmpeg" });
  }
}
