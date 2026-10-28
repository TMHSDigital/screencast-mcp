import { z } from "zod";
import { extname, resolve } from "node:path";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import {
  buildConcatArgs,
  buildConcatListContent,
  concatCopyBlocker,
  editOutputExt,
  assertEditContainer,
} from "../utils/media.js";
import { buildAssembleArgs, clipLength } from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand, tempPath } from "../utils/paths.js";

const inputSchema = {
  inputs: z
    .array(z.string().min(1))
    .min(2)
    .describe("Two or more video paths to join, in order. Matching inputs are stream-copied; others are re-encoded."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "concat",
    {
      title: "Concatenate Videos",
      description:
        "Concatenate two or more videos into a single file. Matching inputs are " +
        "joined by stream copy (fast, lossless). Inputs that differ in codec, size, " +
        "pixel format, frame rate or audio layout, or that hold frames hidden behind " +
        "an edit list (a trim with exact: false), are re-encoded with hard cuts " +
        "instead, so the result is always a valid file; `mode` in the result says which.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        // The concat demuxer resolves relative list entries against the list
        // file's directory (the OS temp dir), not our cwd, so inputs must be
        // absolute by the time they are written to the list.
        const inputs = args.inputs.map((f) => resolve(f));
        for (const f of inputs) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const infos = await Promise.all(inputs.map((f) => probeMedia(f)));
        const durations = infos.map((i) => clipLength(i));
        const durationSec = durations.every((d) => d !== null) ? durations.reduce((a, d) => a + d!, 0) : null;
        // Mismatched inputs make the concat demuxer write a broken file (#206),
        // and a copy carries any hidden frames along (#203): re-encode then.
        const reason = concatCopyBlocker(inputs, infos);
        if (reason !== null) {
          assertEditContainer(args.output);
          const output = resolveOutput(args.output, subdir("edits"), `concat-${stamp()}-${rand()}${editOutputExt(inputs[0])}`, args.overwrite);
          const first = infos[0];
          const even = (n: number | null) => (n !== null && n >= 2 ? n - (n % 2) : undefined);
          const ffArgs = buildAssembleArgs(
            inputs,
            durations.map((d) => d ?? 0),
            output,
            { transition: "cut", width: even(first.width), height: even(first.height), fps: first.fps ?? undefined },
            infos.map((i) => i.audioCodec !== null),
          );
          await runEditJob(ffArgs, { output, durationSec, extra });
          return okResponse({ outputPath: output, inputCount: inputs.length, mode: "reencode", reason });
        }
        const ext = extname(inputs[0]) || ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `concat-${stamp()}-${rand()}${ext}`, args.overwrite);
        const listFile = tempPath(".txt");
        writeFileSync(listFile, buildConcatListContent(inputs));
        try {
          await runEditJob(buildConcatArgs(listFile, output), { output, durationSec, extra });
        } finally {
          rmSync(listFile, { force: true });
        }
        return okResponse({ outputPath: output, inputCount: inputs.length, mode: "copy" });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
