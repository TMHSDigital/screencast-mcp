import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireInput, overwriteField } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE } from "../utils/toolSpec.js";
import { assertOutputAllowed, assertOverwriteAllowed } from "../utils/paths.js";
import { applyTranslations, formatSrt, parseSrt, translatedSrtPath, MAX_TRANSLATED_CUE } from "../utils/captions.js";

/** Most cues one call hands out or takes back. */
const MAX_CUES = 2000;

const inputSchema = {
  input: z.string().min(1).describe("The .srt to translate (e.g. from transcribe)."),
  language: z.string().regex(/^[a-z]{3}$/).optional().describe('With translations: ISO 639-2 code, e.g. "spa".'),
  translations: z
    .array(z.string().max(MAX_TRANSLATED_CUE))
    .max(MAX_CUES)
    .optional()
    .describe("One translated string per cue, in order. Omit to get the cues to translate."),
  output: z.string().optional().describe("Default: <input>.<language>.srt."),
  overwrite: overwriteField,
};

export function register(server: McpServer): void {
  server.registerTool(
    "translate_subtitles",
    {
      title: "Translate Subtitles",
      description:
        "Translate an SRT without breaking its timing: call once for the numbered cues, translate them, " +
        "then call with translations to write <input>.<language>.srt for chapters' subtitleTracks.",
      inputSchema,
      annotations: WRITES_FILE,
    },
    async (args) => {
      try {
        requireInput(args.input, "Subtitle file");
        if (!/\.srt$/i.test(args.input)) throw new ScreencastError("input must be an .srt file.");
        const cues = parseSrt(readFileSync(args.input, "utf8"));
        if (cues.length === 0) throw new ScreencastError(`No cues in ${args.input}.`);
        if (cues.length > MAX_CUES) throw new ScreencastError(`${cues.length} cues; at most ${MAX_CUES} per file.`);
        if (!args.translations) {
          return okResponse({
            input: args.input,
            count: cues.length,
            cues: cues.map((c, i) => `${i + 1}. ${c.text.replace(/\s*\n\s*/g, " / ")}`),
            next: `Translate each cue's text (keep " / " as a line break), then call again with language and translations: ${cues.length} strings, in order.`,
          });
        }
        if (!args.language) throw new ScreencastError("translations needs language (ISO 639-2, e.g. \"spa\").");
        const translated = applyTranslations(cues, args.translations.map((t) => t.replace(/\s+\/\s+/g, "\n")));
        const output = args.output ?? translatedSrtPath(args.input, args.language);
        if (!/\.srt$/i.test(output)) throw new ScreencastError("output must end in .srt.");
        assertOutputAllowed(output);
        if (existsSync(output)) {
          if (!args.overwrite) throw new ScreencastError(`${output} already exists.`, "Pass overwrite: true to replace it.");
          assertOverwriteAllowed(output);
        }
        writeFileSync(output, formatSrt(translated));
        return okResponse({ outputPath: output, language: args.language, count: translated.length });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
