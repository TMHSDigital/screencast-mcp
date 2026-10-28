/**
 * Lint-style guard for #237: every ffmpeg spawn in a tool must be cancellable
 * (a signal, or the tool's `extra` for runEditJob) and, unless it only touches
 * a single frame or probe, must size its timeout from the input's duration
 * with jobTimeoutMs rather than a fixed number that a long recording outlasts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");
const SPAWN = /\b(runFfmpeg|runCapture|runFfmpegBuffer|runFfmpegFrames|runEditJob)\(/g;

/** Calls whose work is bounded however long the input is (one frame, a still
 * image, a live grab, or a probe), so a fixed timeout is fine. */
const FIXED_OK = [
  /\bbuild(RawFrame|Ssim|Highlight|RawGrab|Screenshot|Tile|Sheet|SampleAtTimestamp|Probe|StepFrame|StepShot)Args\(/,
  /"-frames:v", "1"/,
  /scale=iw\*\$\{scale\}/, // OCR upscale of one still
];

/** The text of the call starting at `start` (the function name), through its
 * closing paren. Skips over string and template literals. */
function callText(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced call at ${start}`);
}

const calls = readdirSync(toolsDir)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((file) => {
    const src = readFileSync(join(toolsDir, file), "utf8");
    // A local named from jobTimeoutMs (normalize_audio reuses one for both passes).
    const scaledLocals = [...src.matchAll(/const (\w+) = jobTimeoutMs\(/g)].map((m) => m[1]);
    return [...src.matchAll(SPAWN)].map((m) => ({
      where: `${file}: ${callText(src, m.index!).replace(/\s+/g, " ").slice(0, 120)}`,
      fn: m[1],
      text: callText(src, m.index!),
      scaledLocals,
    }));
  });

describe("ffmpeg spawn sites in src/tools (#237)", () => {
  it("finds the spawn sites", () => {
    expect(calls.length).toBeGreaterThan(30);
  });

  it("every spawn is cancellable", () => {
    const bad = calls
      .filter((c) => (c.fn === "runEditJob" ? !/\bextra\b/.test(c.text) : !/\bsignal\b/.test(c.text)))
      .map((c) => c.where);
    expect(bad, `spawns without a signal:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every spawn that decodes the input scales its timeout with jobTimeoutMs", () => {
    const bad = calls
      .filter((c) => c.fn !== "runEditJob") // runEditJob sizes its own timeout
      .filter((c) => !/\bjobTimeoutMs\(/.test(c.text))
      .filter((c) => !c.scaledLocals.some((v) => new RegExp(`\\b${v}\\b`).test(c.text)))
      .filter((c) => !FIXED_OK.some((re) => re.test(c.text)))
      .map((c) => c.where);
    expect(bad, `spawns with a fixed timeout over the whole input:\n${bad.join("\n")}`).toEqual([]);
  });
});
