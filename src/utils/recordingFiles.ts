/**
 * Every file a recording can leave next to it (#321), for delete_recording:
 * the event logs, webcam sidecar, transcript, index (beside the video or in
 * the edits/indexes fallback), markers, pause parts, and a WGC stop file.
 */
import { basename } from "node:path";
import { markersPath } from "./chapters.js";
import { eventPaths } from "./events.js";
import { partsDir, webcamOutputPath } from "./pause.js";
import { allowedOutputDirs, assertLocalPath, homeRoot, isWithin } from "./paths.js";
import { ScreencastError } from "./errors.js";
import { defaultTranscriptPath, fallbackIndexPath, indexSidecarPath } from "./recordingIndex.js";
import { wgcStopFile } from "./wgc.js";

/** The sidecar paths of `video` (they may not exist). `siblings` are the
 * file names in its folder, so a `<base>.srt` another video in the folder
 * could own is left alone. Pure. */
export function recordingSidecars(video: string, siblings: readonly string[], editsDir: string): { files: string[]; dirs: string[] } {
  const events = eventPaths(video);
  const transcript = defaultTranscriptPath(video, siblings);
  const files = [
    events.jsonl,
    events.raw,
    `${events.raw}.stop`,
    webcamOutputPath(video),
    indexSidecarPath(video),
    fallbackIndexPath(video, editsDir),
    markersPath(video),
    wgcStopFile(video),
    ...(transcript.path && !transcript.ambiguous ? [transcript.path] : []),
  ];
  return { files: [...new Set(files)].filter((f) => basename(f) !== basename(video)), dirs: [partsDir(video)] };
}

/** Refuse to delete outside SCREENCAST_HOME and the allowed directories.
 * With none configured, only SCREENCAST_HOME, like replacing a file (#321). */
export function assertDeleteAllowed(path: string): void {
  assertLocalPath(path, "Recording");
  const dirs = [homeRoot(), ...(allowedOutputDirs() ?? [])];
  if (dirs.some((d) => isWithin(path, d))) return;
  throw new ScreencastError(
    `Recording ${path} is outside SCREENCAST_HOME and the allowed directories, so it is not deleted. ` +
      "Add its folder to SCREENCAST_ALLOWED_DIRS or the client's workspace roots, or delete it yourself.",
  );
}
