/**
 * Add a marker to a session (#174), shared by add_marker and the recording
 * hotkey (#337): at a given video second, or "now" while it records (the
 * pause point while it is paused, #200).
 */
import { errorMessage, ScreencastError } from "./errors.js";
import { insertMarker, markerTimeSec, markersPath, writeMarkers, type Marker } from "./chapters.js";
import { recordedSec } from "./pause.js";
import type { SessionStore } from "./sessions.js";

export interface SessionMarkerResult {
  t: number;
  count: number;
  markersPath: string;
  live: boolean;
  warning?: string;
}

export function addSessionMarker(store: SessionStore, sessionId: string, label: string, at?: number): SessionMarkerResult {
  const record = store.get(sessionId);
  if (!record) throw new ScreencastError(`No session with id "${sessionId}".`);
  let t = at;
  if (t === undefined && record.status === "paused") {
    t = recordedSec(record.segments?.parts ?? []);
  } else if (t === undefined) {
    if (record.status !== "recording") {
      throw new ScreencastError(
        `Session "${sessionId}" is ${record.status}, so there is no "now" to mark.`,
        "Pass at (video seconds) to mark a stopped recording.",
      );
    }
    t = markerTimeSec(record.videoStartMs ?? Date.parse(record.startedAt), Date.now());
  } else if (record.durationSec != null && t > record.durationSec) {
    throw new ScreencastError(`at ${t}s is past the end of the recording (${record.durationSec}s).`);
  }
  const marker: Marker = { t, label, at: new Date().toISOString() };
  // Patch only the markers field: the registry merges field by field, so a
  // stop or event-log update meanwhile is kept (#235).
  const markers = insertMarker(record.markers ?? [], marker);
  store.update(sessionId, { markers });
  let sidecar = markersPath(record.outputPath);
  let warning: string | undefined;
  try {
    sidecar = writeMarkers(record.outputPath, markers, sessionId);
  } catch (err) {
    warning = `Saved in the session, but the sidecar ${sidecar} could not be written: ${errorMessage(err)}`;
  }
  return {
    t,
    count: markers.length,
    markersPath: sidecar,
    live: record.status === "recording" || record.status === "paused",
    ...(warning ? { warning } : {}),
  };
}
