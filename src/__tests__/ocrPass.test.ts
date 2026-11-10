/** One ffmpeg per frame for every OCR pass (#291). */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOcrPassArgs } from "../utils/ocrScan.js";
import { binaryWorks } from "../utils/ffmpeg.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

describe("buildOcrPassArgs (#291)", () => {
  it("scales a single pass with -vf, uncompressed", () => {
    expect(buildOcrPassArgs("f.png", [2], ["p0.png"])).toEqual([
      "-y", "-v", "error", "-i", "f.png", "-vf", "scale=iw*2:ih*2:flags=lanczos", "-compression_level", "0", "p0.png",
    ]);
  });

  it("splits once and writes one output per scale", () => {
    const a = buildOcrPassArgs("f.png", [2, 4], ["p0.png", "p1.png"]);
    const graph = a[a.indexOf("-filter_complex") + 1];
    expect(graph).toBe("[0:v]split=2[s0][s1];[s0]scale=iw*2:ih*2:flags=lanczos[o0];[s1]scale=iw*4:ih*4:flags=lanczos[o1]");
    expect(a.slice(a.indexOf("-filter_complex") + 2)).toEqual([
      "-map", "[o0]", "-compression_level", "0", "p0.png",
      "-map", "[o1]", "-compression_level", "0", "p1.png",
    ]);
  });

  it("refuses mismatched scales and outputs", () => {
    expect(() => buildOcrPassArgs("f.png", [2, 4], ["p0.png"])).toThrow();
    expect(() => buildOcrPassArgs("f.png", [], [])).toThrow();
  });

  it.skipIf(!binaryWorks(FFMPEG) || !binaryWorks(FFPROBE))("produces both upscaled frames in one ffmpeg run", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-ocrpass-"));
    try {
      const src = join(dir, "f.png");
      spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90", "-frames:v", "1", src]);
      const outs = [join(dir, "p0.png"), join(dir, "p1.png")];
      const res = spawnSync(FFMPEG, buildOcrPassArgs(src, [2, 4], outs), { encoding: "utf8" });
      expect(res.status, res.stderr).toBe(0);
      const size = (f: string) =>
        spawnSync(FFPROBE, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim();
      expect(outs.every(existsSync)).toBe(true);
      expect(size(outs[0]!)).toBe("320,180");
      expect(size(outs[1]!)).toBe("640,360");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
