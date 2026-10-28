import { z } from "zod";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { OUTPUT_PATH, WRITES_FILE } from "../utils/toolSpec.js";
import { requireFfmpeg, runCapture, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob, jobTimeoutMs } from "../utils/jobs.js";
import { buildDenoiseArgs, buildNoiseFloorArgs, parseNoiseFloor, type DenoiseStrength } from "../utils/audio.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video or audio file."),
  strength: z
    .enum(["light", "medium", "strong"])
    .optional()
    .describe("How hard to reduce noise: light (6 dB), medium (12 dB, default), strong (20 dB)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "denoise",
    {
      title: "Denoise Audio",
      description:
        "Reduce steady background noise (fan, hum, hiss) in a recording's audio with an " +
        "adaptive FFT denoiser. Video is copied untouched. Returns the output path.",
      inputSchema,
      outputSchema: OUTPUT_PATH,
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) {
          throw new ScreencastError(`Input file not found: ${args.input}`);
        }
        const info = await probeMedia(args.input);
        if (!info.audioCodec) throw new ScreencastError(`Input has no audio stream: ${args.input}`);
        const strength = (args.strength as DenoiseStrength | undefined) ?? "medium";
        assertEditContainer(args.output);
        const ext = editOutputExt(args.input, { audio: true });
        const output = resolveOutput(args.output, subdir("edits"), `denoise-${stamp()}-${rand()}${ext}`, args.overwrite);
        // Measure the noise floor first: afftdn only works when told roughly how
        // loud the noise is.
        const scan = await runCapture(requireFfmpeg().ffmpeg, buildNoiseFloorArgs(args.input), jobTimeoutMs(info.durationSec), {
          signal: extra.signal,
        });
        const floor = parseNoiseFloor(scan.stdout);
        await runEditJob(buildDenoiseArgs(args.input, output, strength, floor), {
          output,
          durationSec: info.durationSec,
          extra,
        });
        return okResponse({
          outputPath: output,
          strength,
          noiseFloorDb: floor === null ? null : Number(floor.toFixed(1)),
          note: "Works best on steady noise (fans, hum, hiss); it does little for intermittent sounds.",
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
