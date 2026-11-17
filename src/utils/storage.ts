/**
 * How much room SCREENCAST_HOME uses and how much its volume has left, for
 * doctor (#354). Recordings and edits are never pruned automatically, so this
 * is how the agent and the person find out the store is filling up.
 */
import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

/** Below this much free space on the home volume, doctor lists a problem: an
 * hour of 1080p30 at the standard quality is a few GB. */
export const LOW_FREE_BYTES = 2 * 1024 ** 3;

export const STORE_FOLDERS = ["recordings", "edits", "screenshots", "frames"] as const;

/** Total size of the files under `dir` (0 when it is missing). Async, so a
 * frames/ folder with tens of thousands of files does not block the server. */
export async function folderBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile()) total += await stat(p).then((s) => s.size, () => 0);
  }
  return total;
}

/** Free bytes on the volume that holds `path` (null when it cannot be read). */
export async function freeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function storageUsage(home: string): Promise<{ freeBytes: number | null; bytes: Record<(typeof STORE_FOLDERS)[number], number> }> {
  const [free, ...sizes] = await Promise.all([freeBytes(home), ...STORE_FOLDERS.map((f) => folderBytes(join(home, f)))]);
  const bytes = Object.fromEntries(STORE_FOLDERS.map((f, i) => [f, sizes[i] ?? 0])) as Record<(typeof STORE_FOLDERS)[number], number>;
  return { freeBytes: free ?? null, bytes };
}

/** "3.4 GB" style, for messages. Pure. */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}
