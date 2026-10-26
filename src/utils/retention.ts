/**
 * Retention for captures the server keeps under SCREENCAST_HOME (#209).
 *
 * Screenshots and sampled frames pile up: every screenshot, sample_frames,
 * and contact_sheet call writes files, and they can show whatever was on
 * screen. With SCREENCAST_RETENTION_DAYS set, files in screenshots/ and
 * frames/ older than that are deleted when the server starts, along with
 * leftover raw event logs in recordings/. Recordings and edits are never
 * touched: they are the user's work. Off by default.
 */
import { readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homeRoot } from "./paths.js";

export const RETENTION_ENV = "SCREENCAST_RETENTION_DAYS";

/** The configured retention in days, or null when it is off (unset, 0, or invalid). */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env[RETENTION_ENV]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface PruneResult {
  removed: number;
  bytes: number;
}

/** Delete capture files older than `days` under `root`. Returns what went. */
export function pruneCaptures(days: number, now: number = Date.now(), root: string = homeRoot()): PruneResult {
  const cutoff = now - days * 86_400_000;
  const result: PruneResult = { removed: 0, bytes: 0 };
  const prune = (dir: string, keep: (name: string) => boolean, recurse: boolean): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // not created yet
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) {
          if (!recurse) continue;
          prune(path, keep, true);
          if (readdirSync(path).length === 0 && st.mtimeMs < cutoff) rmdirSync(path);
        } else if (!keep(name) && st.mtimeMs < cutoff) {
          unlinkSync(path);
          result.removed++;
          result.bytes += st.size;
        }
      } catch {
        // Locked or already gone: try again next start.
      }
    }
  };
  prune(join(root, "screenshots"), () => false, true);
  prune(join(root, "frames"), () => false, true);
  prune(join(root, "recordings"), (name) => !/\.events\.raw(\.stop)?$/.test(name), false);
  return result;
}
