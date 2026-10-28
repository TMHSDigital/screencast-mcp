/**
 * Which characters a font can draw (#231).
 *
 * drawtext renders with exactly one font file and has no fallback: a character
 * the font lacks becomes a tofu box and ffmpeg still exits 0. To catch that up
 * front, read the font's cmap (the table mapping code points to glyphs) and
 * check the text against it. Handles plain sfnt files (.ttf / .otf) and
 * collections (.ttc, face 0 by default, which is the face FreeType and so
 * drawtext opens), cmap formats 4, 12 and 13.
 *
 * Parsing is pure over a byte reader, so tests drive it with a Buffer and the
 * caller can read only the few tables it needs from a 20 MB CJK collection.
 */

/** Sorted, non-overlapping inclusive [first, last] code point ranges. */
export type Coverage = ReadonlyArray<readonly [number, number]>;

/** Read `length` bytes at `offset` (short reads past the end are fine). */
export type ByteReader = (offset: number, length: number) => Buffer;

export function bufferReader(buf: Buffer): ByteReader {
  return (offset, length) => buf.subarray(offset, offset + length);
}

function need(b: Buffer, n: number, what: string): Buffer {
  if (b.length < n) throw new Error(`Truncated font: ${what}.`);
  return b;
}

/** Offset of face `faceIndex`'s sfnt header: 0 for a plain font, or the entry
 * in a TrueType collection's table. */
function faceOffset(read: ByteReader, faceIndex: number): number {
  const head = need(read(0, 12), 12, "header");
  if (head.toString("latin1", 0, 4) !== "ttcf") {
    if (faceIndex !== 0) throw new Error("Not a font collection; only face 0 exists.");
    return 0;
  }
  const count = head.readUInt32BE(8);
  if (faceIndex < 0 || faceIndex >= count) throw new Error(`Face ${faceIndex} is out of range (collection has ${count}).`);
  return need(read(12 + faceIndex * 4, 4), 4, "collection offsets").readUInt32BE(0);
}

/** Merge consecutive covered code points into ranges. Input must be ascending. */
class RangeBuilder {
  readonly ranges: Array<[number, number]> = [];
  add(first: number, last: number): void {
    const prev = this.ranges[this.ranges.length - 1];
    if (prev && first <= prev[1] + 1) prev[1] = Math.max(prev[1], last);
    else this.ranges.push([first, last]);
  }
}

/** Format 4 (BMP, segmented): a code point maps to glyph 0 (missing) unless
 * its segment's delta or glyph array gives a real glyph, so walk each one. */
function parseFormat4(t: Buffer): Coverage {
  const segX2 = need(t, 14, "cmap format 4").readUInt16BE(6);
  const ends = 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  need(t, rangeOffsets + segX2, "cmap format 4 segments");
  // Segments are sorted by end code, so code points arrive ascending.
  const out = new RangeBuilder();
  for (let s = 0; s < segX2 / 2; s++) {
    const end = t.readUInt16BE(ends + s * 2);
    const start = t.readUInt16BE(starts + s * 2);
    const delta = t.readUInt16BE(deltas + s * 2);
    const ro = t.readUInt16BE(rangeOffsets + s * 2);
    if (start > end) continue;
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (ro === 0) glyph = (c + delta) & 0xffff;
      else {
        // idRangeOffset is relative to its own slot in the array.
        const at = rangeOffsets + s * 2 + ro + (c - start) * 2;
        glyph = at + 2 <= t.length ? t.readUInt16BE(at) : 0;
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(c, c);
    }
  }
  return out.ranges;
}

/** Formats 12 (segmented coverage) and 13 (many-to-one): groups of
 * (first, last, glyph). A group starting at glyph 0 maps its first code point
 * to the missing glyph; format 13 maps the whole group to that one glyph. */
function parseGroups(t: Buffer, format: 12 | 13): Coverage {
  const n = need(t, 16, `cmap format ${format}`).readUInt32BE(12);
  need(t, 16 + n * 12, `cmap format ${format} groups`);
  const groups: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    let first = t.readUInt32BE(16 + i * 12);
    const last = Math.min(t.readUInt32BE(20 + i * 12), 0x10ffff);
    const glyph = t.readUInt32BE(24 + i * 12);
    if (glyph === 0) {
      if (format === 13) continue;
      first++;
    }
    if (first <= last) groups.push([first, last]);
  }
  groups.sort((a, b) => a[0] - b[0]);
  const out = new RangeBuilder();
  for (const [a, b] of groups) out.add(a, b);
  return out.ranges;
}

/** Preference among cmap subtables: full-Unicode Windows (3,10) or Unicode
 * (0,4/0,6) first, then BMP Windows (3,1) or Unicode (0,0-3). Symbol (3,0) and
 * legacy encodings are not Unicode, so they are not used. */
function subtableRank(platform: number, encoding: number): number {
  if (platform === 3 && encoding === 10) return 0;
  if (platform === 0 && (encoding === 4 || encoding === 6)) return 1;
  if (platform === 3 && encoding === 1) return 2;
  if (platform === 0 && encoding <= 3) return 3;
  return -1;
}

/** The Unicode code points face `faceIndex` of a font maps to real glyphs.
 * Throws on a file that is not a TrueType/OpenType font or has no usable cmap. */
export function parseCoverage(read: ByteReader, faceIndex = 0): Coverage {
  const base = faceOffset(read, faceIndex);
  const sfnt = need(read(base, 12), 12, "sfnt header");
  const tag = sfnt.toString("latin1", 0, 4);
  if (tag !== "\u0000\u0001\u0000\u0000" && tag !== "OTTO" && tag !== "true") {
    throw new Error("Not a TrueType/OpenType font.");
  }
  const numTables = sfnt.readUInt16BE(4);
  const dir = need(read(base + 12, numTables * 16), numTables * 16, "table directory");
  let cmapAt = -1;
  for (let i = 0; i < numTables; i++) {
    if (dir.toString("latin1", i * 16, i * 16 + 4) === "cmap") cmapAt = dir.readUInt32BE(i * 16 + 8);
  }
  if (cmapAt < 0) throw new Error("Font has no cmap table.");
  const cmapHead = need(read(cmapAt, 4), 4, "cmap header");
  const n = cmapHead.readUInt16BE(2);
  const recs = need(read(cmapAt + 4, n * 8), n * 8, "cmap records");
  // Several records may share one subtable; try them best first.
  const candidates: Array<{ rank: number; offset: number }> = [];
  for (let i = 0; i < n; i++) {
    const rank = subtableRank(recs.readUInt16BE(i * 8), recs.readUInt16BE(i * 8 + 2));
    if (rank >= 0) candidates.push({ rank, offset: cmapAt + recs.readUInt32BE(i * 8 + 4) });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  for (const { offset } of candidates) {
    const fmtHead = read(offset, 8);
    if (fmtHead.length < 8) continue;
    const format = fmtHead.readUInt16BE(0);
    if (format === 4) return parseFormat4(read(offset, fmtHead.readUInt16BE(2)));
    if (format === 12 || format === 13) return parseGroups(read(offset, fmtHead.readUInt32BE(4)), format);
  }
  throw new Error("Font has no Unicode cmap subtable this reader understands (formats 4, 12, 13).");
}

export function covers(cov: Coverage, cp: number): boolean {
  let lo = 0;
  let hi = cov.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < cov[mid][0]) hi = mid - 1;
    else if (cp > cov[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Code points that never need a glyph: controls (drawtext lays out newlines
 * and tabs itself) and the invisible format characters a shaper drops (joiners,
 * variation selectors, bidi marks, BOM, tags). */
export function needsGlyph(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return false;
  if (cp === 0xad || cp === 0x34f || cp === 0x61c || cp === 0xfeff) return false;
  if (cp >= 0x200b && cp <= 0x200f) return false;
  if (cp >= 0x202a && cp <= 0x202e) return false;
  if (cp >= 0x2060 && cp <= 0x206f) return false;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return false;
  if (cp >= 0xe0000 && cp <= 0xe0fff) return false;
  return true;
}

/** The distinct characters of `text` (in first-seen order) that need a glyph
 * and that `cov` lacks. Empty means the font draws all of it. */
export function missingChars(text: string, cov: Coverage): string[] {
  const seen = new Set<number>();
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (seen.has(cp)) continue;
    seen.add(cp);
    if (needsGlyph(cp) && !covers(cov, cp)) out.push(ch);
  }
  return out;
}
