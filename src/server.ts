/**
 * Builds the MCP server with every tool, resource, and prompt registered, but
 * no transport: index.ts connects it over stdio, and the tool-layer tests
 * connect it in memory (#192).
 */
import { createRequire } from "node:module";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseToolsets,
  serverInstructions,
  SELECTABLE_TOOLSETS,
  toolsetOf,
  type ToolsetSelection,
} from "./utils/toolsets.js";

import { register as registerStartRecording } from "./tools/startRecording.js";
import { register as registerStopRecording } from "./tools/stopRecording.js";
import { register as registerSaveReplay } from "./tools/saveReplay.js";
import { register as registerListSessions } from "./tools/listSessions.js";
import { register as registerGetSession } from "./tools/getSession.js";
import { register as registerReadEvents } from "./tools/readEvents.js";
import { register as registerAddMarker } from "./tools/addMarker.js";
import { register as registerChapters } from "./tools/chapters.js";
import { register as registerReviewRecording } from "./tools/reviewRecording.js";
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
import { register as registerKeystrokeOverlay } from "./tools/keystrokeOverlay.js";
import { register as registerBackdrop } from "./tools/backdrop.js";
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
import { register as registerListTargets } from "./tools/listTargets.js";
import { register as registerDoctor } from "./tools/doctor.js";
import { register as registerXfadeTransition } from "./tools/xfadeTransition.js";
import { register as registerAssembleHighlights } from "./tools/assembleHighlights.js";
import { register as registerTitleCard } from "./tools/titleCard.js";
import { register as registerMusicBed } from "./tools/musicBed.js";
import { register as registerReframe } from "./tools/reframe.js";
import { register as registerZoom } from "./tools/zoom.js";
import { register as registerPipeline } from "./tools/pipeline.js";
import { register as registerExportPreset } from "./tools/exportPreset.js";
import { register as registerBugReport } from "./tools/bugReport.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { attachLogging } from "./utils/logging.js";
import { trackClientRoots } from "./utils/roots.js";

// Resolves from src/ in dev and dist/ in the published package alike; keeps
// the advertised version from drifting from package.json (the hardcoded
// string here had already fallen behind twice).
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export function createServer(options: { toolsets?: string } = {}): McpServer {
  const selection = parseToolsets(options.toolsets ?? process.env.SCREENCAST_TOOLSETS);
  if (selection.unknown.length > 0) {
    console.error(
      `screencast-mcp: ignoring unknown SCREENCAST_TOOLSETS entries: ${selection.unknown.join(", ")} ` +
        `(known: all, ${SELECTABLE_TOOLSETS.join(", ")})`,
    );
  }
  const server = new McpServer(
    {
      name: "screencast-mcp",
      version,
    },
    // ffmpeg warnings and capture events are sent as log messages (#222).
    // The instructions carry the workflow map so tool descriptions stay short (#214).
    { capabilities: { logging: {} }, instructions: serverInstructions(selection) },
  );
  attachLogging(server);
  const tools = captureRegisteredTools(server);

  registerStartRecording(server);
  registerStopRecording(server);
  registerSaveReplay(server);
  registerListSessions(server);
  registerGetSession(server);
  registerReadEvents(server);
  registerAddMarker(server);
  registerReviewRecording(server);
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
  registerKeystrokeOverlay(server);
  registerBackdrop(server);
  registerCompress(server);
  registerExtractAudio(server);
  registerNormalizeAudio(server);
  registerDenoise(server);
  registerTranscribe(server);
  registerBurnSubtitles(server);
  registerChapters(server);
  registerClip(server);
  registerCutIdle(server);
  registerRedactRegion(server);
  registerListAudioDevices(server);
  registerListTargets(server);
  registerDoctor(server);
  registerXfadeTransition(server);
  registerAssembleHighlights(server);
  registerTitleCard(server);
  registerMusicBed(server);
  registerReframe(server);
  registerZoom(server);
  registerPipeline(server);
  registerExportPreset(server);
  registerBugReport(server);
  applyToolsets(tools, selection);
  registerResources(server);
  registerPrompts(server);
  // Confine caller-chosen output paths to the client's roots (#221).
  trackClientRoots(server);

  return server;
}

/** Records every tool registered from here on, by name, so toolsets can
 * remove the ones not selected (#214). */
function captureRegisteredTools(server: McpServer): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const register = server.registerTool.bind(server) as (...args: unknown[]) => RegisteredTool;
  server.registerTool = ((...args: unknown[]) => {
    const tool = register(...args);
    tools.set(args[0] as string, tool);
    return tool;
  }) as typeof server.registerTool;
  return tools;
}

/** Removes the tools outside the selected toolsets: they are not listed and
 * cannot be called. Every tool must belong to a toolset. */
function applyToolsets(tools: Map<string, RegisteredTool>, selection: ToolsetSelection): void {
  for (const [name, tool] of tools) {
    const set = toolsetOf(name);
    if (!set) throw new Error(`Tool "${name}" belongs to no toolset; add it to TOOLSETS in src/utils/toolsets.ts.`);
    if (!selection.enabled.includes(set)) tool.remove();
  }
}
