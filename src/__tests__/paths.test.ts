import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tempPath, resolveOutput, sequencePattern, stillOutput } from "../utils/paths.js";

describe("tempPath", () => {
  it("returns a unique scratch path in the OS temp dir with the given suffix", () => {
    const a = tempPath(".txt");
    const b = tempPath(".txt");
    expect(a.startsWith(tmpdir())).toBe(true);
    expect(a.endsWith(".txt")).toBe(true);
    expect(a).toContain("screencast-");
    expect(a).not.toBe(b); // unique per call
  });
  it("works with no suffix", () => {
    expect(tempPath().startsWith(tmpdir())).toBe(true);
  });
});

describe("resolveOutput overwrite guard", () => {
  it("refuses a caller-supplied path that already exists", () => {
    const existing = join(tmpdir(), `sc-out-${Date.now()}.mp4`);
    writeFileSync(existing, "x");
    try {
      expect(() => resolveOutput(existing, tmpdir(), "d.mp4")).toThrow(/overwrite/);
      expect(resolveOutput(existing, tmpdir(), "d.mp4", true)).toBe(existing);
    } finally {
      rmSync(existing, { force: true });
    }
  });
  it("allows a caller-supplied path that does not exist yet", () => {
    const fresh = join(tmpdir(), `sc-out-${Date.now()}-missing.mp4`);
    expect(resolveOutput(fresh, tmpdir(), "d.mp4")).toBe(fresh);
  });
  it("never guards auto-generated default names", () => {
    expect(resolveOutput(undefined, tmpdir(), "d.mp4")).toBe(join(tmpdir(), "d.mp4"));
    expect(resolveOutput("", tmpdir(), "d.mp4")).toBe(join(tmpdir(), "d.mp4"));
  });
});

describe("% in output paths (#238)", () => {
  it("escapes % in a sequence pattern's directory but not its counter", () => {
    expect(sequencePattern(join("C:", "50%1 speed"), "frame_%05d.png")).toBe(join("C:", "50%%1 speed", "frame_%05d.png"));
  });
  it("keeps a single still image's name literal", () => {
    expect(stillOutput("b%dx.png")).toEqual(["-update", "1", "b%dx.png"]);
    expect(stillOutput("shot.JPG")).toEqual(["-update", "1", "shot.JPG"]);
  });
  it("leaves non-image outputs alone", () => {
    expect(stillOutput("out.mp4")).toEqual(["out.mp4"]);
  });
});
