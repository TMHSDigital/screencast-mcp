import { z } from "zod";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import {
  groupBadges,
  buildKeystrokeArgs,
  DEFAULT_LINGER_SEC,
  type BadgePlanOptions,
  keystrokeOptionsSchema,
  loadBadges,
  prepareKeystrokeAssets,
} from "../utils/keystrokes.js";
import { editOutputExt } from "../utils/media.js";
import { fontFileSchema } from "../utils/callout.js";

const o = keystrokeOptionsSchema;

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
        requireInput(args.input);
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
        const info = await probeMedia(args.input);
        if (!info.height) throw new ScreencastError(`Could not read the size of ${args.input}.`);
        const output = editOutput(args.output, "keys", editOutputExt(args.input), { overwrite: args.overwrite });
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
