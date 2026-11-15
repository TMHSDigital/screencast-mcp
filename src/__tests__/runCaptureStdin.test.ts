/**
 * #281: short jobs must not inherit an open stdin pipe. A child that waits on
 * stdin (ffmpeg polls it for interactive commands) would otherwise sit until
 * the job timeout. Node stands in for ffmpeg: it exits only once stdin ends.
 */
import { describe, it, expect } from "vitest";
import { runCapture } from "../utils/ffmpeg.js";

const WAIT_FOR_STDIN_EOF = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";

describe("runCapture stdin (#281)", () => {
  it("gives the child no stdin, so a stdin reader sees EOF and exits", async () => {
    const res = await runCapture(process.execPath, ["-e", WAIT_FOR_STDIN_EOF], 5_000);
    expect(res.code).toBe(0);
  });
});
