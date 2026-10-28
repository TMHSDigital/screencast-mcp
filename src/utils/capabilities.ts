/**
 * The environment report behind the doctor tool (#195): which ffmpeg the server
 * found and what it can do, whether Windows capture and OCR work here, and the
 * settings in effect, so a missing feature shows up before a tool call fails.
 *
 * Parsing is pure; the probes (spawning ffmpeg, PowerShell) are thin wrappers.
 */
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { runPowerShell, psTimeoutMs } from "./monitors.js";

/** FFmpeg major version that transcribe (whisper) and backend "wgc" (gfxcapture) need. */
export const FFMPEG_FEATURE_MAJOR = 8;

export interface FfmpegVersion {
  /** The version string as printed, e.g. "8.0-full_build-www.gyan.dev". */
  version: string | null;
  /** Major release, from the version string or (for git builds) libavutil. */
  major: number | null;
  /** True when the major release was inferred from libavutil (git builds). */
  inferred: boolean;
}

/** Parse `ffmpeg -version` / `ffprobe -version` output. Pure. */
export function parseFfmpegVersion(text: string): FfmpegVersion {
  const version = /^ff(?:mpeg|probe) version (\S+)/m.exec(text)?.[1] ?? null;
  const release = version ? /^n?(\d+)\.\d+/.exec(version) : null;
  if (release) return { version, major: Number(release[1]), inferred: false };
  // Git snapshots ("N-118000-g...", "2025-03-10-git-...") carry no release
  // number; libavutil's major tracks it (58 = FFmpeg 6, 59 = 7, 60 = 8).
  const avutil = /^\s*libavutil\s+(\d+)\./m.exec(text);
  if (avutil && Number(avutil[1]) >= 56) return { version, major: Number(avutil[1]) - 52, inferred: true };
  return { version, major: null, inferred: false };
}

/** Device names from `ffmpeg -devices` (e.g. gdigrab, dshow, lavfi). Pure. */
export function parseDevices(text: string): string[] {
  const out = new Set<string>();
  const body = text.split(/^\s*---\s*$/m).slice(1).join("\n") || text;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s{0,2}[D ][E ]\s?[d ]?\s+([a-z0-9_,]+)\s/i.exec(line);
    if (m) for (const name of m[1].split(",")) out.add(name);
  }
  return [...out];
}

function run(bin: string, args: string[]): string | null {
  try {
    const res = spawnSync(bin, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (res.status !== 0) return null;
    return `${res.stdout ?? ""}${res.stderr ?? ""}`;
  } catch {
    return null;
  }
}

/** `bin -version` output, or null when it does not run. */
export function versionText(bin: string): string | null {
  return run(bin, ["-version"]);
}

/** `ffmpeg -devices` output, or null when it does not run. */
export function devicesText(ffmpeg: string): string | null {
  return run(ffmpeg, ["-hide_banner", "-devices"]);
}

/** Where a binary name resolves on PATH (an absolute path is returned as is). */
export function locate(bin: string): string | null {
  if (isAbsolute(bin)) return bin;
  const out = run(process.platform === "win32" ? "where" : "which", [bin]);
  return out?.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? null;
}

export interface OcrStatus {
  available: boolean;
  /** The recognizer language find_text would use. */
  language: string | null;
  /** Every installed OCR language. */
  languages: string[];
  error?: string;
}

const PS_OCR_STATUS = `
$ErrorActionPreference = 'Stop'
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
[pscustomobject]@{ available = ($null -ne $e); language = $(if ($e) { $e.RecognizerLanguage.LanguageTag } else { $null }); languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) } | ConvertTo-Json -Compress
`;

/** Whether the Windows OCR engine (find_text) works here. Never throws. */
export async function ocrStatus(): Promise<OcrStatus> {
  if (process.platform !== "win32") {
    return { available: false, language: null, languages: [], error: "The Windows OCR engine is available on Windows only." };
  }
  try {
    const raw = JSON.parse(await runPowerShell(PS_OCR_STATUS, "OCR languages", { timeoutMs: psTimeoutMs(15_000) })) as {
      available?: boolean;
      language?: string | null;
      languages?: string[] | string;
    };
    const languages = Array.isArray(raw.languages) ? raw.languages : raw.languages ? [raw.languages] : [];
    return { available: raw.available === true, language: raw.language ?? null, languages };
  } catch (err) {
    return { available: false, language: null, languages: [], error: (err as Error).message };
  }
}

/** Environment variables the server reads. */
export const ENV_SETTINGS = [
  "SCREENCAST_HOME",
  "FFMPEG_PATH",
  "FFPROBE_PATH",
  "SCREENCAST_WHISPER_MODEL",
  "SCREENCAST_MAX_RECORDING_SEC",
  "SCREENCAST_JOB_TIMEOUT_MS",
  "SCREENCAST_PS_TIMEOUT_MS",
  "SCREENCAST_RETENTION_DAYS",
] as const;

/** The set ones, with their values; unset ones as null. Pure. */
export function envSettings(env: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  return Object.fromEntries(
    ENV_SETTINGS.map((name) => {
      const value = env[name];
      return [name, value && value.trim().length > 0 ? value : null];
    }),
  );
}

/** Optional ffmpeg filters, and the tools that need them. */
export const KEY_FILTERS: Array<{ filter: string; tools: string; why: string }> = [
  { filter: "whisper", tools: "transcribe", why: `FFmpeg ${FFMPEG_FEATURE_MAJOR}+ built with whisper.cpp` },
  { filter: "gfxcapture", tools: 'backend: "wgc" (screenshot, start_recording, find_text)', why: `FFmpeg ${FFMPEG_FEATURE_MAJOR}+ on Windows` },
  { filter: "subtitles", tools: "burn_subtitles", why: "libass" },
  { filter: "drawtext", tools: "title_card, callout, contact_sheet labels, produce", why: "libfreetype" },
  { filter: "afftdn", tools: "denoise", why: "a standard build" },
  { filter: "loudnorm", tools: "normalize_audio", why: "a standard build" },
  { filter: "xfade", tools: "xfade_transition, assemble_highlights", why: "FFmpeg 4.3+" },
];
