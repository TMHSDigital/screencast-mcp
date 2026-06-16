import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { bundledFontPath, escapeFilterPath } from "../utils/fonts.js";

describe("escapeFilterPath", () => {
  it("forward-slashes and double-escapes the drive colon for ffmpeg", () => {
    // The value passes through two unescaping stages, so the colon needs `\\:`.
    expect(escapeFilterPath("C:\\Dev\\x.ttf")).toBe("C\\\\:/Dev/x.ttf");
  });
  it("leaves a colon-free posix path with only slash normalization", () => {
    expect(escapeFilterPath("/home/u/x.ttf")).toBe("/home/u/x.ttf");
  });
});

describe("bundledFontPath", () => {
  it("resolves the bundled Inter weights to real files", () => {
    const bold = bundledFontPath("bold");
    const regular = bundledFontPath("regular");
    expect(basename(bold)).toBe("Inter-Bold.ttf");
    expect(basename(regular)).toBe("Inter-Regular.ttf");
    expect(existsSync(bold)).toBe(true);
    expect(existsSync(regular)).toBe(true);
  });
});
