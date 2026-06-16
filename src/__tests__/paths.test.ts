import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { tempPath } from "../utils/paths.js";

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
