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
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getStore } from "./context.js";
import { requireFfmpeg } from "./utils/ffmpeg.js";
import { probeDuration, stopAll } from "./utils/lifecycle.js";
import { register as registerStartRecording } from "./tools/startRecording.js";
import { register as registerStopRecording } from "./tools/stopRecording.js";
import { register as registerListSessions } from "./tools/listSessions.js";
import { register as registerGetSession } from "./tools/getSession.js";
import { register as registerReadEvents } from "./tools/readEvents.js";
import { register as registerScreenshot } from "./tools/screenshot.js";
import { register as registerSampleFrames } from "./tools/sampleFrames.js";
import { register as registerContactSheet } from "./tools/contactSheet.js";
import { register as registerScreenDiff } from "./tools/screenDiff.js";
import { register as registerWaitForChange } from "./tools/waitForChange.js";
import { register as registerFindText } from "./tools/findText.js";
import { register as registerGetMediaInfo } from "./tools/getMediaInfo.js";
import { register as registerTrim } from "./tools/trim.js";
import { register as registerConcat } from "./tools/concat.js";
import { register as registerConvert } from "./tools/convert.js";
import { register as registerExportGif } from "./tools/exportGif.js";
import { register as registerCrop } from "./tools/crop.js";
import { register as registerScale } from "./tools/scale.js";
import { register as registerSpeed } from "./tools/speed.js";
import { register as registerOverlay } from "./tools/overlay.js";
import { register as registerCallout } from "./tools/callout.js";
import { register as registerCompress } from "./tools/compress.js";
import { register as registerExtractAudio } from "./tools/extractAudio.js";
import { register as registerNormalizeAudio } from "./tools/normalizeAudio.js";
import { register as registerDenoise } from "./tools/denoise.js";
import { register as registerTranscribe } from "./tools/transcribe.js";
import { register as registerBurnSubtitles } from "./tools/burnSubtitles.js";
import { register as registerClip } from "./tools/clip.js";
import { register as registerCutIdle } from "./tools/cutIdle.js";
import { register as registerRedactRegion } from "./tools/redactRegion.js";
import { register as registerListAudioDevices } from "./tools/listAudioDevices.js";
import { register as registerXfadeTransition } from "./tools/xfadeTransition.js";
import { register as registerAssembleHighlights } from "./tools/assembleHighlights.js";
import { register as registerTitleCard } from "./tools/titleCard.js";
import { register as registerMusicBed } from "./tools/musicBed.js";
import { register as registerReframe } from "./tools/reframe.js";
import { register as registerZoom } from "./tools/zoom.js";
import { register as registerPipeline } from "./tools/pipeline.js";
import { register as registerExportPreset } from "./tools/exportPreset.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

// Resolves from src/ in dev and dist/ in the published package alike; keeps
// the advertised version from drifting from package.json (the hardcoded
// string here had already fallen behind twice).
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const server = new McpServer({
  name: "screencast-mcp",
  version,
});

registerStartRecording(server);
registerStopRecording(server);
registerListSessions(server);
registerGetSession(server);
registerReadEvents(server);
registerScreenshot(server);
registerSampleFrames(server);
registerContactSheet(server);
registerScreenDiff(server);
registerWaitForChange(server);
registerFindText(server);
registerGetMediaInfo(server);
registerTrim(server);
registerConcat(server);
registerConvert(server);
registerExportGif(server);
registerCrop(server);
registerScale(server);
registerSpeed(server);
registerOverlay(server);
registerCallout(server);
registerCompress(server);
registerExtractAudio(server);
registerNormalizeAudio(server);
registerDenoise(server);
registerTranscribe(server);
registerBurnSubtitles(server);
registerClip(server);
registerCutIdle(server);
registerRedactRegion(server);
registerListAudioDevices(server);
registerXfadeTransition(server);
registerAssembleHighlights(server);
registerTitleCard(server);
registerMusicBed(server);
registerReframe(server);
registerZoom(server);
registerPipeline(server);
registerExportPreset(server);
registerResources(server);
registerPrompts(server);

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

let shuttingDown = false;

/** Finalize every active recording, then exit. Idempotent and never throws. */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
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
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
