#!/usr/bin/env node
/**
 * screencast-mcp - a Windows-first MCP server for screen recording, frame
 * sampling ("watching" footage), and minimal ffmpeg edits.
 *
 * Transport: stdio. ffmpeg/ffprobe are external dependencies detected per call.
 * Capture is always explicit (a tool call) and never auto-fires - a recording
 * can contain anything on screen, including secrets. See the README threat
 * model.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getStore, isShuttingDown, markShuttingDown } from "./context.js";
import { requireFfmpeg } from "./utils/ffmpeg.js";
import { probeDuration, stopAll } from "./utils/lifecycle.js";
import { createServer } from "./server.js";
import { pruneCaptures, retentionDays, RETENTION_ENV } from "./utils/retention.js";

const server = createServer();

async function main(): Promise<void> {
  // Reconcile any sessions interrupted by a previous crash and kill ffmpeg
  // children that outlived the last run, so no zombie capture survives.
  try {
    const reaped = getStore().reapOrphans();
    if (reaped.length > 0) {
      process.stderr.write(`Reaped ${reaped.length} orphaned recording(s) on startup.\n`);
    }
  } catch (err) {
    process.stderr.write(
      `Orphan reaping skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  const days = retentionDays();
  if (days !== null) {
    const pruned = pruneCaptures(days);
    if (pruned.removed > 0) {
      process.stderr.write(`Deleted ${pruned.removed} capture file(s) older than ${days} day(s) (${RETENTION_ENV}).\n`);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Without this, a client that disconnects mid-recording leaves the server
  // and its ffmpeg child running (the child's pipes keep the event loop
  // alive), so the screen keeps being recorded (#76). stdin EOF is the stdio
  // transport's disconnect signal; signals cover a client that kills us.
  process.stdin.on("end", () => void shutdown("client disconnected"));
  process.stdin.on("close", () => void shutdown("client disconnected"));
  server.server.onclose = () => void shutdown("transport closed");
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown(sig));
  }
}

// A write to a client that has gone away fails with EPIPE; without a handler
// that error is uncaught and kills the server mid-cleanup (#229).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") process.stderr.write(`stdout error: ${err.message}\n`);
  void shutdown("client pipe closed");
});

// A crash must never leave captures running: stop them, then exit (#207).
process.on("uncaughtException", (err) => {
  process.stderr.write(`Uncaught exception: ${err.stack ?? err.message}\n`);
  void shutdown("uncaught exception", 1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
  );
});

/** Finalize every active recording, then exit. Idempotent and never throws. */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (isShuttingDown()) return;
  markShuttingDown();
  try {
    const store = getStore();
    if (store.activeIds().length > 0) {
      let ffprobe: string | null = null;
      try {
        ffprobe = requireFfmpeg().ffprobe;
      } catch {
        /* duration stays unknown */
      }
      const stopped = await stopAll(store, (path) =>
        ffprobe ? probeDuration(ffprobe, path) : Promise.resolve(null),
      );
      process.stderr.write(`Shutdown (${reason}): stopped ${stopped.length} recording(s).\n`);
    }
  } catch (err) {
    process.stderr.write(
      `Shutdown cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
