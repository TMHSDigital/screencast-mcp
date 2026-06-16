import { z } from "zod";
import { extname } from "node:path";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg, runFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { buildMusicBedArgs } from "../utils/produce.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const inputSchema = {
  video: z.string().min(1).describe("Path to the video."),
  music: z.string().min(1).describe("Path to the music audio file (looped/trimmed to the video length)."),
  musicVolume: z.number().nonnegative().optional().describe("Music level 0..1 (default 0.25 over existing audio, 0.8 alone)."),
  fadeIn: z.number().nonnegative().optional().describe("Music fade-in seconds (default 1)."),
  fadeOut: z.number().nonnegative().optional().describe("Music fade-out seconds (default 2)."),
  duck: z.boolean().optional().describe("Duck the music under the original audio via a sidechain (default false)."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits."),
};

export function register(server: McpServer): void {
  server.tool(
    "music_bed",
    "Lay a music track under a video: the music is looped/trimmed to the video " +
      "length, faded in and out, and leveled. When the video already has audio " +
      "the two are mixed, optionally ducking the music under the original. The " +
      "video stream is copied; only audio is re-encoded.",
    inputSchema,
    async (args) => {
      try {
        requireFfmpeg();
        for (const f of [args.video, args.music]) {
          if (!existsSync(f)) throw new ScreencastError(`Input file not found: ${f}`);
        }
        const info = await probeMedia(args.video);
        if (info.durationSec === null) {
          throw new ScreencastError(`Could not read duration of ${args.video}.`);
        }
        const ext = extname(args.video) || ".mp4";
        const output = resolveOutput(args.output, subdir("edits"), `music-${stamp()}-${rand()}${ext}`);
        const ffArgs = buildMusicBedArgs(
          args.video,
          args.music,
          output,
          info.durationSec,
          info.audioCodec !== null,
          {
            musicVolume: args.musicVolume,
            fadeIn: args.fadeIn,
            fadeOut: args.fadeOut,
            duck: args.duck,
          },
        );
        await runFfmpeg(ffArgs, 15 * 60_000);
        return okResponse({ outputPath: output, mixedWithOriginal: info.audioCodec !== null });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
