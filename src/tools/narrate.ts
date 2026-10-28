import { z } from "zod";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { markersOrChapters, readMarkers, writeMarkers } from "../utils/chapters.js";
import { formatSrt } from "../utils/captions.js";
import {
  buildNarrateArgs,
  narrationCues,
  placementWarnings,
  resolveLines,
  synthesize,
  wavDurationSec,
  MAX_RATE,
  MIN_RATE,
  type Placement,
} from "../utils/narrate.js";

const inputSchema = {
  video: z.string().min(1).describe("Path to the video."),
  lines: z
    .array(
      z.object({
        t: z.number().nonnegative().optional().describe("Seconds."),
        marker: z.string().optional().describe("Or a marker label."),
        text: z.string().min(1),
      }),
    )
    .min(1),
  voice: z.string().optional().describe("Voice name or part (doctor lists them)."),
  rate: z.number().min(MIN_RATE).max(MAX_RATE).optional().describe("Default 1."),
  duck: z.boolean().optional().describe("Duck the original audio (default true)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "narrate",
    {
      title: "Narrate",
      description:
        "Offline voiceover with the built-in Windows voices: speaks each line at its time or marker " +
        "over the audio, plus an SRT.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      let work: string | null = null;
      try {
        requireFfmpeg();
        if (!existsSync(args.video)) throw new ScreencastError(`Input file not found: ${args.video}`);
        const info = await probeMedia(args.video);
        if (info.durationSec === null) throw new ScreencastError(`Could not read duration of ${args.video}.`);
        const needsMarkers = args.lines.some((l) => l.marker !== undefined);
        const markers = needsMarkers ? (await markersOrChapters(args.video, extra.signal)).markers : [];
        const lines = resolveLines(args.lines, markers);
        assertEditContainer(args.output);
        const output = resolveOutput(args.output, subdir("edits"), `narrated-${stamp()}-${rand()}${editOutputExt(args.video)}`, args.overwrite);

        work = mkdtempSync(join(tmpdir(), "screencast-tts-"));
        const wavs = lines.map((_, i) => join(work!, `line-${i}.wav`));
        const voice = await synthesize(
          lines.map((l, i) => ({ text: l.text, path: wavs[i]! })),
          { voice: args.voice, rate: args.rate, signal: extra.signal },
        );
        const placed: Placement[] = lines.map((l, i) => ({ ...l, durationSec: wavDurationSec(readFileSync(wavs[i]!)) }));
        const warnings = placementWarnings(placed, info.durationSec);

        const ffArgs = buildNarrateArgs(args.video, wavs, output, placed, info.durationSec, {
          hasAudio: info.audioCodec !== null,
          channels: info.channels,
          duck: args.duck,
        });
        await runEditJob(ffArgs, { output, durationSec: info.durationSec, extra });

        const srtPath = output.replace(/\.[^./\\]+$/, "") + ".srt";
        writeFileSync(srtPath, formatSrt(narrationCues(placed, info.durationSec)));
        // Timing is unchanged, so the input's markers still hold.
        const inputMarkers = readMarkers(args.video);
        if (inputMarkers.length > 0) writeMarkers(output, inputMarkers);

        return okResponse({
          outputPath: output,
          srtPath,
          voice,
          lines: placed.map((p) => ({ t: p.t, durationSec: Math.round(p.durationSec * 100) / 100 })),
          mixedWithOriginal: info.audioCodec !== null,
          ...(warnings.length ? { warnings } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      } finally {
        if (work) rmSync(work, { recursive: true, force: true });
      }
    },
  );
}
