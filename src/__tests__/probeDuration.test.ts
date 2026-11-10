/** The one probeDuration (#310): never throws, null when it cannot probe. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDuration } from "../utils/ffmpeg.js";
import { probeDuration as fromJobs } from "../utils/jobs.js";

describe("probeDuration (#310)", () => {
  it("is the same function the edit tools import from jobs", () => {
    expect(fromJobs).toBe(probeDuration);
  });

  it("returns null for a missing file without running ffprobe", async () => {
    expect(await probeDuration(join(tmpdir(), "no-such-file-310.mp4"), { ffprobe: "no-such-ffprobe-310" })).toBeNull();
  });

  it("returns null instead of throwing when ffprobe cannot run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-probe-"));
    try {
      const file = join(dir, "x.mp4");
      writeFileSync(file, "not a video");
      expect(await probeDuration(file, { ffprobe: join(dir, "no-such-ffprobe.exe") })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
