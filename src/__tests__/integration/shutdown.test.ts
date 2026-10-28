/**
 * Edit-job lifecycle against real ffmpeg (#237): analysis passes are
 * cancellable, and a server shutdown cancels running edit jobs and leaves no
 * `.partial` file behind. Its own file because abortEditJobs closes the job
 * registry for the rest of the process. Skipped when ffmpeg is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryWorks, runFfmpegBuffer, runFfmpegFrames } from "../../utils/ffmpeg.js";
import { abortEditJobs, activeEditJobs, partialPath, runEditJob } from "../../utils/jobs.js";

const AVAILABLE = binaryWorks(process.env.FFMPEG_PATH || "ffmpeg") && binaryWorks(process.env.FFPROBE_PATH || "ffprobe");

/** A long lavfi encode that keeps ffmpeg busy until it is killed. */
const slowEncode = (out: string) => [
  "-y", "-f", "lavfi", "-i", "testsrc=duration=600:size=1280x720:rate=30",
  "-c:v", "libx264", "-preset", "veryslow", out,
];
const slowRaw = ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=600:size=320x240:rate=30", "-f", "rawvideo", "-pix_fmt", "gray", "-"];

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!AVAILABLE)("edit-job lifecycle (#237)", { timeout: 60_000 }, () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "screencast-shutdown-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runFfmpegBuffer and runFfmpegFrames stop on a cancelled signal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await expect(runFfmpegBuffer(slowRaw, 30_000, { signal: ac.signal })).rejects.toThrow(/cancelled/);

    const ac2 = new AbortController();
    let frames = 0;
    const run = runFfmpegFrames(slowRaw, 320 * 240, () => {
      if (++frames === 5) ac2.abort();
    }, 30_000, { signal: ac2.signal });
    await expect(run).rejects.toThrow(/cancelled/);
  });

  it("shutdown cancels a running edit job and leaves no .partial file", async () => {
    const out = join(dir, "shutdown.mp4");
    const job = runEditJob(slowEncode(out), { output: out, durationSec: 600 });
    const settled = job.catch((e: unknown) => e);
    // Wait until ffmpeg has actually started writing the partial.
    await waitFor(() => existsSync(partialPath(out)));
    expect(activeEditJobs()).toBe(1);

    expect(await abortEditJobs()).toBe(1);
    expect(existsSync(partialPath(out))).toBe(false);
    expect(existsSync(out)).toBe(false);
    expect(String(await settled)).toMatch(/cancelled/);
    expect(activeEditJobs()).toBe(0);

    // No new edit starts once shutdown has begun.
    const late = join(dir, "late.mp4");
    await expect(runEditJob(slowEncode(late), { output: late, durationSec: 600 })).rejects.toThrow(/shutting down/);
    expect(existsSync(partialPath(late))).toBe(false);
  });
});
