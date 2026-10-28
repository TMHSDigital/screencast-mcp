import { z } from "zod";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { eventPaths, parseEventsJsonl } from "../utils/events.js";
import { resolveTextFont } from "../utils/fonts.js";
import {
  planBadges,
  groupBadges,
  buildKeystrokeArgs,
  BADGE_POSITIONS,
  DEFAULT_LINGER_SEC,
  type Badge,
  type BadgePlanOptions,
  type KeystrokeAssets,
} from "../utils/keystrokes.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { fontFileSchema } from "./callout.js";

/** Keystroke overlay options, undescribed: the pipeline step reuses them
 * as-is, which keeps tools/list small (#214). */
export const keystrokeOptionsSchema = {
  events: z.string().optional(),
  clicks: z.boolean().optional(),
  typing: z.boolean().optional(),
  keys: z.enum(["shortcuts", "masked"]).optional(),
  lingerSec: z.number().positive().max(10).optional(),
  position: z.enum(BADGE_POSITIONS).optional(),
  size: z.number().min(8).max(400).optional(),
  color: z.string().optional(),
  fontFile: z.string().min(1).optional(),
};
const o = keystrokeOptionsSchema;

/** Badges from a recording's event log, on the source's clock. */
export function loadBadges(input: string, events: string | undefined, opts: BadgePlanOptions): { badges: Badge[]; shortcutsLogged: number; path: string } {
  const path = events ?? eventPaths(input).jsonl;
  if (!existsSync(path)) {
    throw new ScreencastError(
      `No event log for ${input} (looked for ${path}). Record with start_recording events: true ` +
        '(keys: "shortcuts" to name shortcuts), or pass events: <path to .events.jsonl>.',
    );
  }
  const log = parseEventsJsonl(readFileSync(path, "utf8"));
  return { badges: planBadges(log, opts), shortcutsLogged: log.filter((e) => e.type === "key").length, path };
}

export interface PreparedKeystrokeAssets extends KeystrokeAssets {
  fallbackFont?: string;
  warnings: string[];
}

/** One font that covers every label (Inter, else a system fallback, #231),
 * and a text file per label in `workDir` (none when `dryRun`). */
export function prepareKeystrokeAssets(labels: string[], workDir: string | null, tag = "", fontFile?: string): PreparedKeystrokeAssets {
  const font = resolveTextFont(labels.join(" "), { weight: "bold", fontFile });
  const textFiles: Record<string, string> = {};
  labels.forEach((label, i) => {
    if (workDir === null) {
      textFiles[label] = `<badge ${i}>`;
      return;
    }
    const f = join(workDir, `${tag}badge_${i}.txt`);
    writeFileSync(f, label);
    textFiles[label] = f;
  });
  return {
    fontFile: font.fontFile,
    textFiles,
    ...(font.fallback && { fallbackFont: font.fontFile }),
    warnings: font.warning ? [font.warning] : [],
  };
}

const inputSchema = {
  input: z.string().min(1).describe("Path to the recording."),
  events: o.events.describe("Event log (default: the input's .events.jsonl)."),
  clicks: o.clicks.describe("Show clicks (default true)."),
  typing: o.typing.describe('Show typing as "Typing…" (default true).'),
  keys: o.keys.describe("shortcuts (default): the chord (Ctrl + S); masked: modifiers only (Ctrl + …)."),
  lingerSec: o.lingerSec.describe(`Seconds a badge stays up (default ${DEFAULT_LINGER_SEC}).`),
  position: o.position.describe("Default bottom (centred)."),
  size: o.size.describe("Font px (default 4.5% of the frame height)."),
  color: o.color.describe("Text color (default white)."),
  fontFile: fontFileSchema,
  dryRun: z.boolean().optional().describe("Return the planned badges; write nothing."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "keystroke_overlay",
    {
      title: "Keystroke Overlay",
      description:
        "Burn keycast-style badges for shortcuts, clicks, and typing from the recording's input event log " +
        "(start_recording events: true). Never shows typed text: the log has none.",
      inputSchema,
      outputSchema: looseOutput({ badges: z.number().int() }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        const plan: BadgePlanOptions = { clicks: args.clicks, typing: args.typing, keys: args.keys, lingerSec: args.lingerSec };
        const { badges, shortcutsLogged } = loadBadges(args.input, args.events, plan);
        const note =
          shortcutsLogged === 0
            ? 'The log names no shortcuts (recorded with keys: "masked"), so only clicks and typing can show.'
            : undefined;
        if (badges.length === 0) {
          return okResponse({ badges: 0, note: "Nothing to show: the log has no clicks, shortcuts, or typing; nothing written." });
        }
        const groups = groupBadges(badges);
        if (args.dryRun) {
          const assets = prepareKeystrokeAssets(groups.map((g) => g.label), null, "", args.fontFile);
          return okResponse({
            dryRun: true,
            badges: badges.length,
            plan: badges,
            ...(assets.fallbackFont && { fallbackFont: assets.fallbackFont }),
            ...(assets.warnings.length > 0 && { warnings: assets.warnings }),
            ...(note && { note }),
          });
        }
        assertEditContainer(args.output);
        const info = await probeMedia(args.input);
        if (!info.height) throw new ScreencastError(`Could not read the size of ${args.input}.`);
        const output = resolveOutput(args.output, subdir("edits"), `keys-${stamp()}-${rand()}${editOutputExt(args.input)}`, args.overwrite);
        const work = mkdtempSync(join(tmpdir(), "screencast-keys-"));
        try {
          const assets = prepareKeystrokeAssets(groups.map((g) => g.label), work, "", args.fontFile);
          const style = { position: args.position, size: args.size, color: args.color };
          const ffArgs = buildKeystrokeArgs(args.input, output, groups, assets, style, { height: info.height });
          await runEditJob(ffArgs, { output, durationSec: info.durationSec, extra });
          return okResponse({
            outputPath: output,
            badges: badges.length,
            labels: groups.map((g) => g.label),
            ...(assets.fallbackFont && { fallbackFont: assets.fallbackFont }),
            ...(assets.warnings.length > 0 && { warnings: assets.warnings }),
            ...(note && { note }),
          });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
