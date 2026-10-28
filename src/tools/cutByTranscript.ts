import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { parseSrt, normalizeCues, formatSrt } from "../utils/captions.js";
import { buildCutIdleArgs, MAX_CUTS } from "../utils/idle.js";
import { planTranscriptCuts, retimeCues } from "../utils/transcriptCut.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video."),
  srt: z.string().min(1).describe("Its .srt (transcribe; words: true for word timing)."),
  remove: z
    .array(z.union([z.number().int().min(1).max(99999), z.string().min(1)]))
    .optional()
    .describe("Cue numbers, or transcript text quoted exactly (must occur once)."),
  fillers: z.boolean().optional().describe("Also cut fillers (um, uh...) that have their own cue."),
  dryRun: z.boolean().optional().describe("Only report the cuts."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "cut_by_transcript",
    {
      title: "Cut By Transcript",
      description:
        "Edit a video by its transcript: cut quoted text, cue numbers, or fillers. Also writes the re-timed .srt.",
      inputSchema,
      outputSchema: looseOutput({ cuts: z.array(z.unknown()), removedSec: z.number() }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        for (const f of [args.input, args.srt]) if (!existsSync(f)) throw new ScreencastError(`File not found: ${f}`);
        if (!args.remove?.length && !args.fillers) throw new ScreencastError("Nothing to cut: pass remove and/or fillers: true.");
        const info = await probeMedia(args.input);
        const duration = info.durationSec;
        if (duration === null || !info.videoCodec) throw new ScreencastError(`Not a readable video: ${args.input}`);
        const cues = normalizeCues(parseSrt(readFileSync(args.srt, "utf8")));
        if (cues.length === 0) throw new ScreencastError(`No cues in ${args.srt}.`);

        const { cuts, skippedFillers } = planTranscriptCuts(cues, { remove: args.remove, fillers: args.fillers });
        if (cuts.length > MAX_CUTS) throw new ScreencastError(`Too many cuts (${cuts.length}, max ${MAX_CUTS}); cut in batches.`);
        const removedSec = Number(cuts.reduce((s, c) => s + Math.min(c.end, duration) - Math.min(c.start, duration), 0).toFixed(2));
        const retimed = retimeCues(cues, cuts);
        const notes = [
          cuts.length === 0 && "Nothing matched; nothing to cut.",
          skippedFillers > 0 && `${skippedFillers} filler(s) inside longer cues were kept; transcribe with words: true to cut them.`,
          cuts.some((c) => !c.exact) && "Some edges were estimated inside a cue; transcribe with words: true for word timing.",
        ].filter(Boolean);
        const summary = {
          cuts,
          removedSec,
          originalSec: Number(duration.toFixed(2)),
          newDurationSec: Number((duration - removedSec).toFixed(2)),
          ...(notes.length ? { note: notes.join(" ") } : {}),
        };
        if (args.dryRun || cuts.length === 0) {
          const text = retimed.map((c) => c.text.replace(/\n/g, " ")).join(" ");
          return okResponse({ ...summary, ...(cuts.length ? { dryRun: true } : {}), text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text });
        }
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input);
        const output = resolveOutput(args.output, subdir("edits"), `cut-transcript-${stamp()}-${rand()}${ext}`, args.overwrite);
        const srtPath = output.replace(/\.[^.\\/]+$/, "") + ".srt";
        if (!args.overwrite && existsSync(srtPath)) throw new ScreencastError(`Output already exists: ${srtPath}. Pass overwrite: true to replace it.`);
        await runEditJob(buildCutIdleArgs(args.input, output, cuts, info.audioCodec !== null), {
          output,
          durationSec: duration - removedSec,
          inputDurationSec: duration,
          extra,
        });
        writeFileSync(srtPath, formatSrt(retimed));
        return okResponse({ outputPath: output, srtPath, ...summary });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
