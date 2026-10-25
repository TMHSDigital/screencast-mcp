/**
 * Files a callout render needs: each text item's text (drawtext reads it from a
 * file, so no escaping is needed) and each arrow rendered to a PNG. Shared by
 * callout and pipeline; the caller owns and removes `workDir`.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { runFfmpeg } from "./ffmpeg.js";
import { buildArrowImageArgs, type Callout, type CalloutAssets } from "./callout.js";
import { bundledFontPath } from "./fonts.js";

export async function prepareCalloutAssets(items: Callout[], workDir: string, tag = ""): Promise<CalloutAssets> {
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
  return { fontFile: bundledFontPath("bold"), textFiles, arrowFiles };
}
