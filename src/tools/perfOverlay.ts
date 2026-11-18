import { z } from "zod";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editOutput, requireInput, overwriteField, editOutputField } from "../utils/editTool.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { editOutputExt } from "../utils/media.js";
import { resolveTextFont } from "../utils/fonts.js";
import { parsePerfJsonl, perfPath } from "../utils/perf.js";
import { buildPerfOverlayArgs, chartValues, METRIC_LABELS, PERF_CORNERS, PERF_METRICS } from "../utils/perfOverlay.js";

const inputSchema = {
  input: z.string().min(1).describe("A recording made with perf: true."),
  perf: z.string().optional().describe("Its .perf.jsonl (default: next to input)."),
  metric: z.enum(PERF_METRICS).optional().describe("Default cpu (the app's) if sampled, else sysCpu."),
  corner: z.enum(PERF_CORNERS).optional().describe("Default top_right."),
  width: z.number().int().min(80).max(1920).optional().describe("Chart width px (default video/4)."),
  output: editOutputField,
  overwrite: overwriteField,
};

export function register(server: McpServer): void {
  server.registerTool(
    "perf_overlay",
    {
      title: "Performance Overlay",
      description: "Draw a recording's CPU or memory track as a small chart with a moving playhead (spikes in red).",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      const work = mkdtempSync(join(tmpdir(), "screencast-perf-"));
      try {
        requireFfmpeg();
        requireInput(args.input);
        const track = args.perf ?? perfPath(args.input);
        if (!existsSync(track)) throw new ScreencastError(`No performance track at ${track}.`, "Record with start_recording perf: true, or pass perf.");
        const samples = parsePerfJsonl(readFileSync(track, "utf8"));
        if (samples.length === 0) throw new ScreencastError(`${track} has no samples.`);
        const info = await probeMedia(args.input);
        if (!info.width || !info.height || !info.durationSec) throw new ScreencastError(`Could not read the size and length of ${args.input}.`);
        const metric = args.metric ?? (samples.some((s) => s.cpu !== undefined) ? "cpu" : "sysCpu");
        const values = chartValues(samples, metric, info.durationSec);
        if (values.every((v) => v === null)) throw new ScreencastError(`The track has no ${metric} values.`);
        const width = args.width ?? Math.max(160, Math.round(info.width / 4));
        const font = resolveTextFont(METRIC_LABELS[metric]);
        const textFile = join(work, "label.txt");
        writeFileSync(textFile, METRIC_LABELS[metric]);
        const output = editOutput(args.output, "perf", editOutputExt(args.input), { overwrite: args.overwrite });
        const ffArgs = buildPerfOverlayArgs(args.input, output, values, {
          metric,
          corner: args.corner ?? "top_right",
          width,
          height: Math.round(width * 0.4),
          videoWidth: info.width,
          videoHeight: info.height,
          durationSec: info.durationSec,
          label: { textFile, fontFile: font.fontFile },
          hasAudio: info.audioCodec !== null,
        });
        await runEditJob(ffArgs, { output, durationSec: info.durationSec, extra });
        return okResponse({ outputPath: output, metric, samples: samples.length });
      } catch (error) {
        return errorResponse(error);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
}
