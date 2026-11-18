/**
 * How much room SCREENCAST_HOME uses and how much its volume has left, for
 * doctor (#354). Recordings and edits are never pruned automatically, so this
 * is how the agent and the person find out the store is filling up.
 */
import { readdir, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/** Below this, start_recording refuses: ffmpeg would fail partway with a
 * write error and leave a broken file (#354). */
export const MIN_FREE_BYTES = 500 * 1024 ** 2;

/** Free bytes on the volume that will hold `path`, which need not exist yet:
 * the nearest existing folder above it is asked. */
export async function freeBytesFor(path: string): Promise<number | null> {
  let p = path;
  for (;;) {
    const free = await freeBytes(p);
    if (free !== null) return free;
    const up = dirname(p);
    if (up === p) return null;
    p = up;
  }
}

/** start_recording's disk check: refuse below MIN_FREE_BYTES, note below
 * LOW_FREE_BYTES, nothing otherwise or when free space cannot be read. Pure. */
export function diskCheck(free: number | null): { refuse?: string; note?: string } {
  if (free === null) return {};
  if (free < MIN_FREE_BYTES) return { refuse: `Only ${formatBytes(free)} free on the output drive.` };
  if (free < LOW_FREE_BYTES) return { note: `Only ${formatBytes(free)} free on the output drive; a long recording may run out of space.` };
  return {};
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
