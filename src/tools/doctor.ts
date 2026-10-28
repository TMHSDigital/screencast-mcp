import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { detectFfmpeg, hasFilter, wgcAvailable, type FfmpegTools } from "../utils/ffmpeg.js";
import { homeRoot } from "../utils/paths.js";
import {
  FFMPEG_FEATURE_MAJOR,
  KEY_FILTERS,
  devicesText,
  envSettings,
  locate,
  ocrStatus,
  parseDevices,
  parseFfmpegVersion,
  versionText,
} from "../utils/capabilities.js";

const { version: serverVersion } = createRequire(import.meta.url)("../../package.json") as { version: string };

const binary = z.looseObject({
  found: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  major: z.number().nullable(),
});

const outputSchema = looseOutput({
  ok: z.boolean(),
  problems: z.array(z.string()),
  server: z.looseObject({ version: z.string(), node: z.string(), platform: z.string() }),
  ffmpeg: binary.extend({ meetsFfmpeg8: z.boolean().nullable() }),
  ffprobe: binary,
  filters: z.record(z.string(), z.boolean()),
  devices: z.looseObject({ gdigrab: z.boolean(), dshow: z.boolean() }),
  wgc: z.looseObject({ available: z.boolean() }),
  ocr: z.looseObject({ available: z.boolean(), language: z.string().nullable(), languages: z.array(z.string()) }),
  storage: z.looseObject({ home: z.string(), homeExists: z.boolean() }),
  env: z.record(z.string(), z.string().nullable()),
});

/** An error's message and hint on one line. */
function errorText(err: unknown): string {
  const first = errorResponse(err).content[0];
  return first.type === "text" ? first.text.replace(/\s*\n+\s*/g, " ") : String(err);
}

function describeBinary(bin: string) {
  const text = versionText(bin);
  const parsed = parseFfmpegVersion(text ?? "");
  return {
    found: text !== null,
    path: text !== null ? locate(bin) : null,
    version: parsed.version,
    major: parsed.major,
    ...(parsed.inferred ? { majorInferred: true } : {}),
  };
}

export function register(server: McpServer): void {
  server.registerTool(
    "doctor",
    {
      title: "Check Setup",
      description:
        "Report what this machine can do before a tool call fails: the ffmpeg and ffprobe in use (path, " +
        `version, whether it is FFmpeg ${FFMPEG_FEATURE_MAJOR}+), the optional filters that gate tools ` +
        "(whisper for transcribe, gfxcapture for backend wgc, subtitles/libass for burn_subtitles, drawtext, " +
        "...), the gdigrab and dshow capture devices, the Windows OCR engine (find_text), SCREENCAST_HOME, " +
        "and the environment settings in effect. `problems` lists what is missing and how to fix it. " +
        "Call it once on first use or when a tool reports a missing feature.",
      inputSchema: {},
      outputSchema,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const problems: string[] = [];
        let tools: FfmpegTools | null = null;
        try {
          tools = detectFfmpeg();
        } catch (err) {
          // Names the missing binary and carries the install hint.
          problems.push(errorText(err));
        }
        const ffmpeg = describeBinary(tools?.ffmpeg ?? (process.env.FFMPEG_PATH?.trim() || "ffmpeg"));
        const ffprobe = describeBinary(tools?.ffprobe ?? (process.env.FFPROBE_PATH?.trim() || "ffprobe"));
        const meetsFfmpeg8 = ffmpeg.major === null ? null : ffmpeg.major >= FFMPEG_FEATURE_MAJOR;
        if (tools && meetsFfmpeg8 === false) {
          problems.push(
            `FFmpeg ${ffmpeg.version} is older than ${FFMPEG_FEATURE_MAJOR}: transcribe and backend "wgc" need FFmpeg ${FFMPEG_FEATURE_MAJOR}+. ` +
              "Windows: `winget install Gyan.FFmpeg`.",
          );
        }

        const filters: Record<string, boolean> = {};
        let devices = { gdigrab: false, dshow: false };
        if (tools) {
          for (const f of KEY_FILTERS) {
            filters[f.filter] = f.filter === "gfxcapture" ? wgcAvailable() : hasFilter(f.filter);
            if (!filters[f.filter] && !(f.filter === "gfxcapture" && process.platform !== "win32")) {
              problems.push(`No ${f.filter} filter: ${f.tools} unavailable (needs ${f.why}).`);
            }
          }
          const names = parseDevices(devicesText(tools.ffmpeg) ?? "");
          devices = { gdigrab: names.includes("gdigrab"), dshow: names.includes("dshow") };
          if (process.platform === "win32" && !devices.gdigrab) {
            problems.push("This ffmpeg has no gdigrab device: screenshot and start_recording cannot capture the screen.");
          }
        }
        if (process.platform !== "win32") {
          problems.push("Not Windows: capture (screenshot, start_recording, list_targets) and OCR are unavailable; the watch and edit tools work.");
        }

        const ocr = await ocrStatus();
        if (process.platform === "win32" && !ocr.available) {
          problems.push(`Windows OCR unavailable: find_text cannot read the screen. ${ocr.error ?? "Install an OCR language (Settings > Time & language > Language)."}`);
        }

        const env = envSettings();
        const model = env.SCREENCAST_WHISPER_MODEL;
        if (model && !existsSync(model)) problems.push(`SCREENCAST_WHISPER_MODEL points at a missing file: ${model}`);
        const home = homeRoot();

        return okResponse({
          ok: problems.length === 0,
          problems,
          server: { version: serverVersion, node: process.version, platform: process.platform },
          ffmpeg: { ...ffmpeg, meetsFfmpeg8 },
          ffprobe,
          filters,
          devices,
          wgc: { available: filters.gfxcapture === true },
          ocr,
          storage: {
            home,
            homeExists: existsSync(home),
            recordings: join(home, "recordings"),
            screenshots: join(home, "screenshots"),
            edits: join(home, "edits"),
          },
          env,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
