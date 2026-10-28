/**
 * Files a callout render needs: each text item's text (drawtext reads it from a
 * file, so no escaping is needed) and each arrow rendered to a PNG. Shared by
 * callout and pipeline; the caller owns and removes `workDir`.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { runFfmpeg } from "./ffmpeg.js";
import { buildArrowImageArgs, type Callout, type CalloutAssets } from "./callout.js";
import { bundledFontPath, resolveTextFont } from "./fonts.js";

export interface CalloutFonts {
  /** Per item: the font for a text callout, else null. */
  fontFiles: Array<string | null>;
  /** Text items drawn with a system fallback font instead of Inter (#231). */
  fallbackFonts: Array<{ item: number; fontFile: string }>;
  /** One line per text item with characters that render as boxes. */
  warnings: string[];
}

/** Pick each text callout's font: `fontFile` when given, else Inter or the
 * system font that covers the text (#231). Reads font files, writes nothing. */
export function calloutFonts(items: Callout[], fontFile?: string): CalloutFonts {
  const out: CalloutFonts = { fontFiles: [], fallbackFonts: [], warnings: [] };
  items.forEach((c, i) => {
    if (c.type !== "text") {
      out.fontFiles.push(null);
      return;
    }
    const font = resolveTextFont(c.text, { weight: "bold", fontFile });
    out.fontFiles.push(font.fontFile);
    if (font.fallback) out.fallbackFonts.push({ item: i, fontFile: font.fontFile });
    if (font.warning) out.warnings.push(`Item ${i}: ${font.warning}`);
  });
  return out;
}

export type PreparedCalloutAssets = CalloutAssets & Omit<CalloutFonts, "fontFiles">;

export async function prepareCalloutAssets(
  items: Callout[],
  workDir: string,
  tag = "",
  fontFile?: string,
): Promise<PreparedCalloutAssets> {
  const fonts = calloutFonts(items, fontFile);
  const textFiles = items.map((c, i) => {
    if (c.type !== "text") return null;
    const f = join(workDir, `${tag}text_${i}.txt`);
    writeFileSync(f, c.text);
    return f;
  });
  const arrowFiles: Array<string | null> = [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    if (c.type !== "arrow") {
      arrowFiles.push(null);
      continue;
    }
    const f = join(workDir, `${tag}arrow_${i}.png`);
    await runFfmpeg(buildArrowImageArgs(c, f), 30_000);
    arrowFiles.push(f);
  }
  return { fontFile: bundledFontPath("bold"), textFiles, arrowFiles, ...fonts };
}
