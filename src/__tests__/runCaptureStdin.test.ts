/**
 * #281: short jobs must not inherit an open stdin pipe. A child that waits on
 * stdin (ffmpeg polls it for interactive commands) would otherwise sit until
 * the job timeout. Node stands in for ffmpeg: it exits only once stdin ends.
 */
import { describe, it, expect } from "vitest";
import { runCapture, StallError } from "../utils/ffmpeg.js";

const WAIT_FOR_STDIN_EOF = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";

describe("runCapture stdin (#281)", () => {
  it("gives the child no stdin, so a stdin reader sees EOF and exits", async () => {
    const res = await runCapture(process.execPath, ["-e", WAIT_FOR_STDIN_EOF], 5_000);
    expect(res.code).toBe(0);
  });
});

describe("runCapture stall watchdog (#281)", () => {
  it("stops a child that writes nothing for stallMs", async () => {
    const t0 = Date.now();
    const err = await runCapture(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], 15_000, { stallMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StallError);
    expect((err as Error).message).toMatch(/wrote nothing for 0s/);
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it("lets a child that keeps writing run past stallMs", async () => {
    // ~5 s of output every 250 ms against a 3 s stall limit (wide enough for
    // a slow node start on a loaded machine).
    const script = "process.stderr.write('.'); let n = 1; const t = setInterval(() => { process.stderr.write('.'); if (++n === 20) { clearInterval(t); } }, 250);";
    const res = await runCapture(process.execPath, ["-e", script], 30_000, { stallMs: 3_000 });
    expect(res.code).toBe(0);
    expect(res.stderr).toBe(".".repeat(20));
  }, 30_000);

  it("with progressed, stops a child that keeps talking but never moves on", async () => {
    // Like the arm64 hang: progress lines every 100 ms, out_time never set.
    const script = "setInterval(() => process.stdout.write('frame=0\\nout_time_us=N/A\\nprogress=continue\\n'), 100);";
    const t0 = Date.now();
    const err = await runCapture(process.execPath, ["-e", script], 15_000, {
      stallMs: 1_500,
      progressed: (chunk) => /out_time_us=\d+/.test(chunk),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StallError);
    expect((err as Error).message).toMatch(/made no progress for 2s/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("with progressed, lets a child whose output time advances run past stallMs", async () => {
    const script = "let t = 0; const i = setInterval(() => { process.stdout.write('out_time_us=' + (t += 100000) + '\\n'); if (t >= 3000000) { clearInterval(i); } }, 100);";
    const res = await runCapture(process.execPath, ["-e", script], 30_000, { stallMs: 1_500, progressed: (chunk) => /out_time_us=\d+/.test(chunk) });
    expect(res.code).toBe(0);
  }, 30_000);
});
