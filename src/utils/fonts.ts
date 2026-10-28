/**
 * Bundled font resolution and filtergraph path escaping.
 *
 * title_card renders text with ffmpeg's drawtext, which needs a real font file.
 * Rather than guess at a system font, the package ships two static Inter weights
 * (SIL Open Font License) under assets/fonts/. The path is resolved relative to
 * the package root so it works the same from dist/ at runtime and from src/
 * under tests, and is escaped for ffmpeg's filtergraph parser.
 *
 * Inter covers Latin, Greek and Cyrillic only, and drawtext has no fallback, so
 * CJK, emoji, Arabic and the rest rendered as tofu boxes (#231). resolveTextFont
 * checks the text against the font's cmap and, when Inter lacks a character,
 * moves on to the Windows system font that covers the script, reporting any
 * character no font can draw instead of rendering it silently as a box.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScreencastError } from "./errors.js";
import { missingChars, parseCoverage, type ByteReader, type Coverage } from "./fontCoverage.js";

export type FontWeight = "regular" | "bold";

const FONT_FILES: Record<FontWeight, string> = {
  regular: "Inter-Regular.ttf",
  bold: "Inter-Bold.ttf",
};

/** Absolute path to a bundled Inter weight. The compiled file lives at
 * dist/utils/fonts.js, so ../../assets/fonts is the package root. */
export function bundledFontPath(weight: FontWeight = "bold"): string {
  return fileURLToPath(
    new URL(`../../assets/fonts/${FONT_FILES[weight]}`, import.meta.url),
  );
}

/** Escape a filesystem path for an ffmpeg filtergraph option value (e.g. a
 * drawtext fontfile / textfile). The value passes through two unescaping
 * stages, so on Windows the drive colon must be double-escaped: forward slashes
 * and `\\:`, turning `C:\Fonts\x.ttf` into `C\\:/Fonts/x.ttf`. This is the
 * documented Windows incantation and is verified against ffmpeg.
 *
 * The same two stages apply to the other specials a real path can contain
 * (#87): a quote needs `\\\'` (option-level `\'`, whose backslash the graph
 * level also escapes), and the graph delimiters `, ; [ ]` need one backslash.
 * Without this, a Windows username like O'Brien (temp dir, npx cache) broke
 * title_card. */
export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\\\:")
    .replace(/'/g, "\\\\\\'")
    .replace(/([,;[\]])/g, "\\$1");
}

/** A system font family drawtext can fall back to: file names to try in
 * order per weight (Windows has shipped some under other names). */
export interface FallbackFamily {
  name: string;
  regular: string[];
  bold: string[];
}

/** Windows system fonts by script (#231). drawtext opens face 0 of a .ttc,
 * which for each of these is the face wanted (verified against ffmpeg). Emoji
 * render in monochrome: drawtext draws the outlines, not the colour layers. */
export const FALLBACK_FAMILIES = {
  // Arabic, Hebrew, Armenian, Georgian and extended Latin/Greek/Cyrillic.
  segoe: { name: "Segoe UI", regular: ["segoeui.ttf"], bold: ["segoeuib.ttf", "segoeui.ttf"] },
  japanese: {
    name: "Yu Gothic",
    regular: ["YuGothM.ttc", "meiryo.ttc", "msgothic.ttc"],
    bold: ["YuGothB.ttc", "meiryob.ttc", "YuGothM.ttc", "msgothic.ttc"],
  },
  chineseSimplified: { name: "Microsoft YaHei", regular: ["msyh.ttc", "simsun.ttc"], bold: ["msyhbd.ttc", "msyh.ttc", "simsun.ttc"] },
  chineseTraditional: { name: "Microsoft JhengHei", regular: ["msjh.ttc", "mingliub.ttc"], bold: ["msjhbd.ttc", "msjh.ttc"] },
  korean: { name: "Malgun Gothic", regular: ["malgun.ttf"], bold: ["malgunbd.ttf", "malgun.ttf"] },
  indic: { name: "Nirmala UI", regular: ["Nirmala.ttc", "Nirmala.ttf"], bold: ["NirmalaB.ttf", "Nirmala.ttc", "Nirmala.ttf"] },
  thai: { name: "Leelawadee UI", regular: ["LeelawUI.ttf", "tahoma.ttf"], bold: ["LeelaUIb.ttf", "LeelawUI.ttf", "tahomabd.ttf"] },
  ethiopic: { name: "Ebrima", regular: ["ebrima.ttf"], bold: ["ebrimabd.ttf", "ebrima.ttf"] },
  emoji: { name: "Segoe UI Emoji", regular: ["seguiemj.ttf"], bold: ["seguiemj.ttf"] },
  symbol: { name: "Segoe UI Symbol", regular: ["seguisym.ttf"], bold: ["seguisym.ttf"] },
} satisfies Record<string, FallbackFamily>;

type FallbackKey = keyof typeof FALLBACK_FAMILIES;

const DEFAULT_ORDER: readonly FallbackKey[] = [
  "segoe", "japanese", "chineseSimplified", "chineseTraditional", "korean",
  "indic", "thai", "ethiopic", "emoji", "symbol",
];

/** Fallback families to try for `text`, best first. Chinese and Japanese fonts
 * both carry Han characters but draw them differently, so the script around
 * them decides: kana means Japanese, Hangul means Korean, Han alone means
 * (simplified) Chinese. Pure. */
export function fallbackOrder(text: string): FallbackFamily[] {
  const front: FallbackKey[] = [];
  if (/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/u.test(text)) front.push("japanese");
  if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text)) front.push("korean");
  if (/\p{Script=Han}/u.test(text)) front.push("chineseSimplified");
  return [...front, ...DEFAULT_ORDER.filter((k) => !front.includes(k))].map((k) => FALLBACK_FAMILIES[k]);
}

export interface FontCandidate {
  path: string;
  coverage: Coverage;
}

export interface FontChoice {
  fontFile: string;
  /** Characters the chosen font still lacks (they render as boxes). */
  missing: string[];
}

/** The first candidate that draws every character of `text`; failing that,
 * the one missing the fewest (earliest on a tie). Pure. */
export function chooseFont(text: string, candidates: FontCandidate[]): FontChoice | null {
  let best: FontChoice | null = null;
  for (const c of candidates) {
    const missing = missingChars(text, c.coverage);
    if (missing.length === 0) return { fontFile: c.path, missing };
    if (!best || missing.length < best.missing.length) best = { fontFile: c.path, missing };
  }
  return best;
}

/** The Windows font directory (%WINDIR%\Fonts). */
export function systemFontsDir(): string {
  return join(process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows", "Fonts");
}

const coverageCache = new Map<string, Coverage | null>();

/** A font file's cmap coverage, read with a few small positioned reads (a CJK
 * collection runs to 20 MB) and cached per path. null when the file is not a
 * font this reader understands. */
export function fontCoverage(path: string): Coverage | null {
  const cached = coverageCache.get(path);
  if (cached !== undefined) return cached;
  let cov: Coverage | null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const handle = fd;
    const read: ByteReader = (offset, length) => {
      const b = Buffer.alloc(length);
      return b.subarray(0, readSync(handle, b, 0, length, offset));
    };
    cov = parseCoverage(read);
  } catch {
    cov = null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  coverageCache.set(path, cov);
  return cov;
}

/** Resolve a caller's fontFile: an existing path, or a bare file name in the
 * Windows font directory (e.g. "msyh.ttc"). */
export function resolveFontFileArg(fontFile: string): string {
  if (existsSync(fontFile) && statSync(fontFile).isFile()) return fontFile;
  if (!isAbsolute(fontFile) && basename(fontFile) === fontFile) {
    const sys = join(systemFontsDir(), fontFile);
    if (existsSync(sys)) return sys;
  }
  throw new ScreencastError(
    `Font file not found: ${fontFile}`,
    "Pass a path to a .ttf, .otf or .ttc file, or the file name of a font in C:\\Windows\\Fonts.",
  );
}

export interface ResolvedFont extends FontChoice {
  /** True when a system font replaced the bundled Inter. */
  fallback: boolean;
  /** Set when some characters will render as boxes (or, for an explicit font,
   * when its coverage could not be read). */
  warning?: string;
}

function excerpt(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `"${one.length > 40 ? `${one.slice(0, 39)}…` : one}"`;
}

/** The font drawtext should use for `text` (#231). An explicit fontFile is used
 * as given and checked; otherwise the bundled Inter weight when it covers the
 * text, else the first system fallback that does, else the one covering the
 * most. Characters no font draws come back in `missing` with a warning. */
export function resolveTextFont(
  text: string,
  opts: { weight?: FontWeight; fontFile?: string; fontsDir?: string } = {},
): ResolvedFont {
  if (opts.fontFile) {
    const fontFile = resolveFontFileArg(opts.fontFile);
    const cov = fontCoverage(fontFile);
    if (!cov) {
      return {
        fontFile,
        missing: [],
        fallback: false,
        warning: `Could not read the character map of ${basename(fontFile)}; glyph coverage of ${excerpt(text)} was not checked.`,
      };
    }
    const missing = missingChars(text, cov);
    if (missing.length === 0) return { fontFile, missing, fallback: false };
    return {
      fontFile,
      missing,
      fallback: false,
      warning: `${basename(fontFile)} has no glyph for ${missing.join(" ")} in ${excerpt(text)}; they render as empty boxes.`,
    };
  }
  const weight = opts.weight ?? "bold";
  const bundled = bundledFontPath(weight);
  const inter = fontCoverage(bundled);
  if (inter && missingChars(text, inter).length === 0) return { fontFile: bundled, missing: [], fallback: false };

  // Read fallbacks lazily, best first, and stop at the first full cover.
  const dir = opts.fontsDir ?? systemFontsDir();
  const candidates: FontCandidate[] = inter ? [{ path: bundled, coverage: inter }] : [];
  for (const fam of fallbackOrder(text)) {
    // One file per family: the first one present.
    for (const file of fam[weight]) {
      const path = join(dir, file);
      const coverage = existsSync(path) ? fontCoverage(path) : null;
      if (!coverage) continue;
      if (missingChars(text, coverage).length === 0) return { fontFile: path, missing: [], fallback: true };
      candidates.push({ path, coverage });
      break;
    }
  }
  const pick = chooseFont(text, candidates) ?? { fontFile: bundled, missing: [] };
  if (pick.missing.length === 0) return { ...pick, fallback: pick.fontFile !== bundled };
  return {
    ...pick,
    fallback: pick.fontFile !== bundled,
    warning:
      `No available font draws ${pick.missing.join(" ")} in ${excerpt(text)}; they render as empty boxes ` +
      `(drawn with ${basename(pick.fontFile)}). Pass fontFile with a font that covers them.`,
  };
}
