/** SCREENCAST_HOME usage and free space for doctor (#354). */
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOW_FREE_BYTES, MIN_FREE_BYTES, diskCheck, folderBytes, formatBytes, freeBytes, freeBytesFor, storageUsage } from "../utils/storage.js";

const home = mkdtempSync(join(tmpdir(), "sc-storage-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("storage usage (#354)", () => {
  it("sums files per store folder, nested ones included, and 0 for a missing one", async () => {
    mkdirSync(join(home, "recordings", "a.mp4.parts"), { recursive: true });
    writeFileSync(join(home, "recordings", "a.mp4"), Buffer.alloc(1000));
    writeFileSync(join(home, "recordings", "a.mp4.parts", "part-001.mp4"), Buffer.alloc(500));
    mkdirSync(join(home, "frames"));
    writeFileSync(join(home, "frames", "f.png"), Buffer.alloc(20));
    const u = await storageUsage(home);
    expect(u.bytes).toEqual({ recordings: 1500, edits: 0, screenshots: 0, frames: 20 });
    expect(u.freeBytes).toBeGreaterThan(0);
    expect(await folderBytes(join(home, "nope"))).toBe(0);
    expect(await freeBytes(join(home, "nope", "deeper"))).toBeNull();
  });

  it("start_recording's disk check refuses, notes, or stays quiet (#354)", async () => {
    expect(diskCheck(100 * 1024 ** 2).refuse).toMatch(/100\.0 MB free/);
    expect(diskCheck(MIN_FREE_BYTES + 1).note).toMatch(/may run out of space/);
    expect(diskCheck(LOW_FREE_BYTES + 1)).toEqual({});
    expect(diskCheck(null)).toEqual({});
    // A folder that does not exist yet is checked on the volume above it.
    expect(await freeBytesFor(join(home, "not", "made", "yet"))).toBeGreaterThan(0);
  });

  it("formats sizes for messages", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3.4 * 1024 ** 3)).toBe("3.4 GB");
  });
});
