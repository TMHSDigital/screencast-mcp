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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getStore } from "./context.js";
import { register as registerStartRecording } from "./tools/startRecording.js";
import { register as registerStopRecording } from "./tools/stopRecording.js";
import { register as registerListSessions } from "./tools/listSessions.js";
import { register as registerGetSession } from "./tools/getSession.js";
import { register as registerScreenshot } from "./tools/screenshot.js";
import { register as registerSampleFrames } from "./tools/sampleFrames.js";
import { register as registerGetMediaInfo } from "./tools/getMediaInfo.js";
import { register as registerTrim } from "./tools/trim.js";
import { register as registerConcat } from "./tools/concat.js";
import { register as registerConvert } from "./tools/convert.js";
import { register as registerCrop } from "./tools/crop.js";
import { register as registerScale } from "./tools/scale.js";
import { register as registerSpeed } from "./tools/speed.js";
import { register as registerOverlay } from "./tools/overlay.js";
import { register as registerCompress } from "./tools/compress.js";
import { register as registerExtractAudio } from "./tools/extractAudio.js";
import { register as registerClip } from "./tools/clip.js";
import { register as registerRedactRegion } from "./tools/redactRegion.js";
import { register as registerListAudioDevices } from "./tools/listAudioDevices.js";
import { register as registerXfadeTransition } from "./tools/xfadeTransition.js";
import { register as registerAssembleHighlights } from "./tools/assembleHighlights.js";

const server = new McpServer({
  name: "screencast-mcp",
  version: "0.6.0",
});

registerStartRecording(server);
registerStopRecording(server);
registerListSessions(server);
registerGetSession(server);
registerScreenshot(server);
registerSampleFrames(server);
registerGetMediaInfo(server);
registerTrim(server);
registerConcat(server);
registerConvert(server);
registerCrop(server);
registerScale(server);
registerSpeed(server);
registerOverlay(server);
registerCompress(server);
registerExtractAudio(server);
registerClip(server);
registerRedactRegion(server);
registerListAudioDevices(server);
registerXfadeTransition(server);
registerAssembleHighlights(server);

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
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
