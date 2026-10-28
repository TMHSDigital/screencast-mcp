import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  bundledFontPath,
  escapeFilterPath,
  chooseFont,
  fallbackOrder,
  fontCoverage,
  resolveFontFileArg,
  resolveTextFont,
  systemFontsDir,
  FALLBACK_FAMILIES,
} from "../utils/fonts.js";
import { bufferReader, covers, missingChars, needsGlyph, parseCoverage } from "../utils/fontCoverage.js";

describe("escapeFilterPath", () => {
  it("forward-slashes and double-escapes the drive colon for ffmpeg", () => {
    // The value passes through two unescaping stages, so the colon needs `\\:`.
    expect(escapeFilterPath("C:\\Dev\\x.ttf")).toBe("C\\\\:/Dev/x.ttf");
  });
  it("leaves a colon-free posix path with only slash normalization", () => {
    expect(escapeFilterPath("/home/u/x.ttf")).toBe("/home/u/x.ttf");
  });
  it("escapes a quote at both unescaping levels (#87)", () => {
    expect(escapeFilterPath("/Users/O'Brien/t.txt")).toBe("/Users/O\\\\\\'Brien/t.txt");
  });
  it("turns a UNC path into forward slashes with nothing else to escape (#107 fixture table)", () => {
    expect(escapeFilterPath("\\\\server\\share\\fonts\\x.ttf")).toBe("//server/share/fonts/x.ttf");
  });
  it("escapes the filtergraph delimiters and leaves spaces alone", () => {
    expect(escapeFilterPath("/a,b;c[d] e/t.txt")).toBe("/a\\,b\\;c\\[d\\] e/t.txt");
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

type Ranges = Array<[number, number]>;

/** A minimal sfnt holding only a cmap: a (3,10) format 12 subtable mapping
 * each [first, last] range to real glyphs, or a (3,1) format 4 one. */
function fakeFont(ranges: Ranges, format: 4 | 12 = 12): Buffer {
  let sub: Buffer;
  if (format === 12) {
    sub = Buffer.alloc(16 + ranges.length * 12);
    sub.writeUInt16BE(12, 0);
    sub.writeUInt32BE(sub.length, 4);
    sub.writeUInt32BE(ranges.length, 12);
    let glyph = 1;
    ranges.forEach(([a, b], i) => {
      sub.writeUInt32BE(a, 16 + i * 12);
      sub.writeUInt32BE(b, 20 + i * 12);
      sub.writeUInt32BE(glyph, 24 + i * 12);
      glyph += b - a + 1;
    });
  } else {
    // Segments plus the required 0xFFFF terminator, all mapped by idDelta.
    const segs: Ranges = [...ranges, [0xffff, 0xffff]];
    const n = segs.length;
    sub = Buffer.alloc(16 + n * 8);
    sub.writeUInt16BE(4, 0);
    sub.writeUInt16BE(sub.length, 2);
    sub.writeUInt16BE(n * 2, 6);
    let glyph = 1;
    segs.forEach(([a, b], i) => {
      sub.writeUInt16BE(b, 14 + i * 2);
      sub.writeUInt16BE(a, 16 + n * 2 + i * 2);
      sub.writeUInt16BE(a === 0xffff ? 1 : (glyph - a) & 0xffff, 16 + n * 4 + i * 2);
      glyph += b - a + 1;
    });
  }
  const cmap = Buffer.concat([Buffer.alloc(12), sub]);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(format === 12 ? 10 : 1, 6);
  cmap.writeUInt32BE(12, 8);
  const head = Buffer.alloc(28);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(1, 4);
  head.write("cmap", 12, "latin1");
  head.writeUInt32BE(28, 20);
  head.writeUInt32BE(cmap.length, 24);
  return Buffer.concat([head, cmap]);
}

/** Wrap sfnt fonts into a TrueType collection, shifting their table offsets. */
function fakeCollection(fonts: Buffer[]): Buffer {
  const header = Buffer.alloc(12 + fonts.length * 4);
  header.write("ttcf", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(fonts.length, 8);
  let at = header.length;
  const parts = fonts.map((f, i) => {
    const copy = Buffer.from(f);
    header.writeUInt32BE(at, 12 + i * 4);
    copy.writeUInt32BE(copy.readUInt32BE(20) + at, 20);
    at += copy.length;
    return copy;
  });
  return Buffer.concat([header, ...parts]);
}

describe("parseCoverage (#231)", () => {
  const ranges: Ranges = [[0x20, 0x7e], [0x3040, 0x309f], [0x4e00, 0x9fff]];

  it("reads format 12 and format 4 cmaps to the same ranges", () => {
    expect(parseCoverage(bufferReader(fakeFont(ranges, 12)))).toEqual(ranges);
    expect(parseCoverage(bufferReader(fakeFont(ranges, 4)))).toEqual(ranges);
  });

  it("merges adjacent groups and reads astral code points", () => {
    const cov = parseCoverage(bufferReader(fakeFont([[0x41, 0x42], [0x43, 0x5a], [0x1f389, 0x1f389]])));
    expect(cov).toEqual([[0x41, 0x5a], [0x1f389, 0x1f389]]);
    expect(covers(cov, 0x1f389)).toBe(true);
    expect(covers(cov, 0x1f388)).toBe(false);
  });

  it("reads the requested face of a collection", () => {
    const ttc = fakeCollection([fakeFont([[0x41, 0x5a]]), fakeFont([[0x3040, 0x309f]])]);
    expect(parseCoverage(bufferReader(ttc))).toEqual([[0x41, 0x5a]]);
    expect(parseCoverage(bufferReader(ttc), 1)).toEqual([[0x3040, 0x309f]]);
    expect(() => parseCoverage(bufferReader(ttc), 2)).toThrow(/out of range/);
  });

  it("rejects files that are not fonts", () => {
    expect(() => parseCoverage(bufferReader(Buffer.from("not a font at all")))).toThrow();
    expect(() => parseCoverage(bufferReader(Buffer.alloc(4)))).toThrow(/Truncated/);
  });

  it("finds Inter's Latin and Cyrillic but not CJK or emoji", () => {
    const cov = fontCoverage(bundledFontPath("bold"))!;
    expect(missingChars("Hello, Привет 100%", cov)).toEqual([]);
    expect(missingChars("日本語 🎉", cov)).toEqual(["日", "本", "語", "🎉"]);
  });
});

describe("missingChars", () => {
  const cov: Ranges = [[0x20, 0x7e]];
  it("lists each missing character once, in order", () => {
    expect(missingChars("a日b日本", cov)).toEqual(["日", "本"]);
  });
  it("ignores controls and invisible format characters", () => {
    // Newline, tab, ZWJ, VS16, BOM: drawtext lays these out or drops them.
    expect(missingChars("a\nb\tc‍️﻿", cov)).toEqual([]);
    expect(needsGlyph(0x0a)).toBe(false);
    expect(needsGlyph(0x41)).toBe(true);
  });
});

describe("font fallback choice (#231)", () => {
  const names = (t: string) => fallbackOrder(t).map((f) => f.name);

  it("orders CJK fonts by the script around the Han characters", () => {
    expect(names("日本語のテスト")[0]).toBe("Yu Gothic");
    expect(names("中文字体")[0]).toBe("Microsoft YaHei");
    expect(names("한국어")[0]).toBe("Malgun Gothic");
    expect(names("مرحبا")[0]).toBe("Segoe UI");
    // Every family is still tried exactly once.
    expect(new Set(names("日本語")).size).toBe(Object.keys(FALLBACK_FAMILIES).length);
  });

  it("chooses the first full cover, else the fewest missing", () => {
    const latin = { path: "latin", coverage: [[0x20, 0x7e]] as Ranges };
    const cjk = { path: "cjk", coverage: [[0x20, 0x7e], [0x3040, 0x30ff], [0x4e00, 0x9fff]] as Ranges };
    const emoji = { path: "emoji", coverage: [[0x20, 0x7e], [0x1f300, 0x1faff]] as Ranges };
    expect(chooseFont("Hi", [latin, cjk])).toEqual({ fontFile: "latin", missing: [] });
    expect(chooseFont("日本語のテスト", [latin, cjk, emoji])).toEqual({ fontFile: "cjk", missing: [] });
    expect(chooseFont("日本 🎉", [latin, emoji, cjk])).toEqual({ fontFile: "cjk", missing: ["🎉"] });
    expect(chooseFont("x", [])).toBeNull();
  });
});

describe("resolveTextFont (#231)", () => {
  let dir = "";
  beforeAll(() => {
    // A stand-in system font folder: a Japanese collection and a Latin+Hebrew font.
    dir = mkdtempSync(join(tmpdir(), "screencast-fonts-"));
    writeFileSync(join(dir, "segoeuib.ttf"), fakeFont([[0x20, 0x7e], [0x5d0, 0x5ea]]));
    writeFileSync(join(dir, "YuGothB.ttc"), fakeCollection([fakeFont([[0x20, 0x7e], [0x3040, 0x30ff], [0x4e00, 0x9fff]])]));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps Inter when it covers the text", () => {
    expect(resolveTextFont("Click here: 100%", { fontsDir: dir })).toEqual({
      fontFile: bundledFontPath("bold"),
      missing: [],
      fallback: false,
    });
  });

  it("falls back to the system font that covers the script", () => {
    expect(resolveTextFont("日本語のテスト", { fontsDir: dir })).toMatchObject({
      fontFile: join(dir, "YuGothB.ttc"),
      fallback: true,
      missing: [],
    });
    expect(resolveTextFont("שלום", { fontsDir: dir }).fontFile).toBe(join(dir, "segoeuib.ttf"));
  });

  it("warns, naming the characters, when no font covers everything", () => {
    const r = resolveTextFont("日本 🎉", { fontsDir: dir });
    expect(r.fontFile).toBe(join(dir, "YuGothB.ttc"));
    expect(r.missing).toEqual(["🎉"]);
    expect(r.warning).toMatch(/No available font draws 🎉/);
  });

  it("uses an explicit font as given and warns about its gaps", () => {
    const r = resolveTextFont("日本", { fontsDir: dir, fontFile: bundledFontPath("regular") });
    expect(r.fontFile).toBe(bundledFontPath("regular"));
    expect(r.fallback).toBe(false);
    expect(r.warning).toMatch(/Inter-Regular\.ttf has no glyph for 日 本/);
    expect(() => resolveTextFont("x", { fontFile: join(dir, "nope.ttf") })).toThrow(/Font file not found/);
  });

  it.runIf(existsSync(join(systemFontsDir(), "arial.ttf")))("finds a bare file name in the Windows font folder", () => {
    expect(resolveFontFileArg("arial.ttf")).toBe(join(systemFontsDir(), "arial.ttf"));
  });
});
