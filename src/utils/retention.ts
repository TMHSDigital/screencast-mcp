/**
 * Retention for captures the server keeps under SCREENCAST_HOME (#209).
 *
 * Screenshots and sampled frames pile up: every screenshot, sample_frames,
 * and contact_sheet call writes files, and they can show whatever was on
 * screen. With SCREENCAST_RETENTION_DAYS set, files in screenshots/ and
 * frames/ older than that are deleted when the server starts, along with
 * leftover raw event logs in recordings/ and index_recording's text
 * timelines (`*.index.json`, which hold the recording's screen text, #266) in
 * recordings/, edits/, and edits/indexes/. An index is derived data:
 * index_recording rebuilds it. Recordings and edits themselves are never
 * touched: they are the user's work. Sidecars next to recordings outside
 * SCREENCAST_HOME are not touched either. Off by default.
 */
import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homeRoot } from "./paths.js";

export const RETENTION_ENV = "SCREENCAST_RETENTION_DAYS";

/** The configured retention in days, or null when it is off (unset, 0, or invalid). */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env[RETENTION_ENV]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** index_recording's sidecars, and a temp file a crash left mid-write. */
const INDEX_FILE = /\.index\.json(\.\d+\.tmp)?$/;

export interface PruneResult {
  removed: number;
  bytes: number;
}

/** Delete capture files older than `days` under `root`. Returns what went.
 * Async so a large frames/ folder never blocks the event loop; the server
 * runs it after the transport connects (#294). */
export async function pruneCaptures(days: number, now: number = Date.now(), root: string = homeRoot()): Promise<PruneResult> {
  const cutoff = now - days * 86_400_000;
  const result: PruneResult = { removed: 0, bytes: 0 };
  const prune = async (dir: string, keep: (name: string) => boolean, recurse: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // not created yet
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (st.isDirectory()) {
          if (!recurse) continue;
          await prune(path, keep, true);
          if ((await readdir(path)).length === 0 && st.mtimeMs < cutoff) await rmdir(path);
        } else if (!keep(name) && st.mtimeMs < cutoff) {
          await unlink(path);
          result.removed++;
          result.bytes += st.size;
        }
      } catch {
        // Locked or already gone: try again next start.
      }
    }
  };
  await prune(join(root, "screenshots"), () => false, true);
  await prune(join(root, "frames"), () => false, true);
  await prune(join(root, "recordings"), (name) => !/\.events\.raw(\.stop)?$/.test(name) && !INDEX_FILE.test(name), false);
  await prune(join(root, "edits"), (name) => !INDEX_FILE.test(name), false);
  await prune(join(root, "edits", "indexes"), (name) => !INDEX_FILE.test(name), false);
  return result;
}
