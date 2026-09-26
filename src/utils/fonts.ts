/**
 * Bundled font resolution and filtergraph path escaping.
 *
 * title_card renders text with ffmpeg's drawtext, which needs a real font file.
 * Rather than guess at a system font, the package ships two static Inter weights
 * (SIL Open Font License) under assets/fonts/. The path is resolved relative to
 * the package root so it works the same from dist/ at runtime and from src/
 * under tests, and is escaped for ffmpeg's filtergraph parser.
 */
import { fileURLToPath } from "node:url";

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
