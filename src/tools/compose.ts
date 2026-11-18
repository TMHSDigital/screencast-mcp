import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { readMarkers } from "../utils/chapters.js";
import { resolveTextFont } from "../utils/fonts.js";
import {
  buildComposeArgs,
  composeDuration,
  COMPOSE_LAYOUTS,
  MAX_COMPOSE_INPUTS,
  MIN_COMPOSE_INPUTS,
  type ComposeSource,
} from "../utils/compose.js";

const inputSchema = {
  inputs: z
    .array(z.object({ path: z.string().min(1), label: z.string().min(1).max(80).optional() }))
    .min(MIN_COMPOSE_INPUTS)
    .max(MAX_COMPOSE_INPUTS)
    .describe('Videos in reading order, each with an optional label (e.g. "Before").'),
  layout: z.enum(COMPOSE_LAYOUTS).optional().describe("side_by_side (default), stack, or grid."),
  alignMarker: z.string().min(1).optional().describe("Line inputs up on this add_marker label."),
  endWith: z.enum(["longest", "shortest"]).optional().describe("longest (default; shorter ones hold their last frame) or shortest."),
  audio: z.union([z.number().int().min(0), z.enum(["mix", "none"])]).optional().describe('Input index whose audio to keep (default 0), "mix", or "none".'),
  output: z.string().optional().describe("Output path; default SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Replace an existing output (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "compose",
    {
      title: "Compose Videos",
      description: "Lay 2-9 videos out side by side, stacked, or in a grid (before/after, app and terminal), labelled and in sync.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      const work = mkdtempSync(join(tmpdir(), "screencast-compose-"));
      try {
        requireFfmpeg();
        const sources: ComposeSource[] = [];
        const warnings: string[] = [];
        for (const [i, inp] of args.inputs.entries()) {
          requireInput(inp.path, `Input ${i}`);
          const info = await probeMedia(inp.path);
          if (!info.width || !info.height || info.durationSec === null) throw new ScreencastError(`Input ${i} has no readable video: ${inp.path}`);
          let skipSec = 0;
          if (args.alignMarker) {
            const m = readMarkers(inp.path).find((k) => k.label === args.alignMarker);
            if (!m) throw new ScreencastError(`Input ${i} has no marker "${args.alignMarker}".`, "Add one with add_marker, or leave alignMarker out.");
            skipSec = m.t;
          }
          let label: ComposeSource["label"];
          if (inp.label) {
            const font = resolveTextFont(inp.label);
            if (font.warning) warnings.push(font.warning);
            const textFile = join(work, `label${i}.txt`);
            writeFileSync(textFile, inp.label);
            label = { textFile, fontFile: font.fontFile };
          }
          sources.push({ path: inp.path, width: info.width, height: info.height, durationSec: info.durationSec, hasAudio: info.audioCodec !== null, skipSec, label });
        }
        // Lined up on the marker: each input starts that far before it.
        if (args.alignMarker) {
          const lead = Math.min(...sources.map((s) => s.skipSec));
          for (const s of sources) s.skipSec -= lead;
        }
        const endWith = args.endWith ?? "longest";
        const audio = args.audio ?? (sources[0]!.hasAudio ? 0 : "none");
        const fps = (await probeMedia(sources[0]!.path)).fps ?? 30;
        const output = editOutput(args.output, "compose", ".mp4", { overwrite: args.overwrite });
        const ffArgs = buildComposeArgs(sources, output, { layout: args.layout ?? "side_by_side", endWith, audio, fps: Math.min(60, Math.round(fps)) });
        const durationSec = composeDuration(sources, endWith);
        await runEditJob(ffArgs, { output, durationSec, extra });
        return okResponse({
          outputPath: output,
          durationSec: Number(durationSec.toFixed(2)),
          layout: args.layout ?? "side_by_side",
          ...(args.alignMarker ? { alignedOn: args.alignMarker, skipSec: sources.map((s) => Number(s.skipSec.toFixed(3))) } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
}
