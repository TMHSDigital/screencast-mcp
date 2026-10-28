/**
 * Captions (#120): transcribe speech to SRT with FFmpeg 8's built-in whisper
 * filter (whisper.cpp, runs locally), and burn subtitles into a video.
 *
 * Whisper's SRT needs tidying: it numbers cues from 0 and lets consecutive
 * cues overlap (one starting before the previous ends), which some players
 * render as two stacked lines. normalizeSrt fixes both. Builders and the SRT
 * handling are pure.
 */
import { existsSync } from "node:fs";
import { ScreencastError } from "./errors.js";
import { escapeFilterPath } from "./fonts.js";
import { resolveQuality, type Quality } from "./targets.js";

/** Env var naming the default whisper.cpp model file. */
export const WHISPER_MODEL_ENV = "SCREENCAST_WHISPER_MODEL";

const MODEL_HINT =
  `Download a whisper.cpp model (ggml-base.en.bin is a good start; ggml-tiny.en.bin is fastest) from ` +
  `https://huggingface.co/ggerganov/whisper.cpp and pass its path as model, or set ${WHISPER_MODEL_ENV}.`;

/** The model to use: the argument, else the env var. It must exist. */
export function resolveWhisperModel(arg: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const model = arg ?? env[WHISPER_MODEL_ENV];
  if (!model || model.trim().length === 0) {
    throw new ScreencastError("No whisper model given.", MODEL_HINT);
  }
  if (!existsSync(model)) throw new ScreencastError(`Whisper model not found: ${model}`, MODEL_HINT);
  return model;
}

/** Transcribe the input's audio to an SRT file (whisper wants 16 kHz).
 * `words` asks for one word per cue: max_len=1 makes whisper.cpp compute
 * token timestamps and split segments at every token (#173). */
export function buildTranscribeArgs(input: string, model: string, srtOut: string, language = "auto", words = false): string[] {
  if (!/^[a-z]{2,3}$|^auto$/.test(language)) {
    throw new ScreencastError(`language must be a code like "en" or "auto", got "${language}".`);
  }
  return [
    "-y", "-v", "error", "-i", input, "-vn",
    "-af",
    `aresample=16000,whisper=model=${escapeFilterPath(model)}:language=${language}:format=srt:` +
      `destination=${escapeFilterPath(srtOut)}:use_gpu=false` + (words ? ":max_len=1" : ""),
    "-f", "null", "-",
  ];
}

/** Word-level whisper output gives punctuation its own cue ("demo", "."),
 * often zero-length. Fold each punctuation-only cue into the cue before it
 * (keeping that cue's timing), so every cue is a spoken word. Pure. */
export function mergePunctuation(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && !/[\p{L}\p{N}]/u.test(c.text)) prev.text += c.text.trim();
    else out.push({ ...c });
  }
  return out;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/;
const toSec = (m: RegExpMatchArray) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
function fmt(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** Parse SRT into cues (tolerant of CRLF, 0-based numbering, blank lines). */
export function parseSrt(srt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of srt.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const i = lines.findIndex((l) => l.includes("-->"));
    const header = lines[i];
    if (header === undefined) continue;
    const [a, b] = header.split("-->");
    const sa = a?.match(TIME);
    const sb = b?.match(TIME);
    if (!sa || !sb) continue;
    const text = lines.slice(i + 1).join("\n");
    if (text) cues.push({ start: toSec(sa), end: toSec(sb), text });
  }
  return cues;
}

/** Renumber from 1, sort by start, and end each cue no later than the next
 * one starts, so cues never overlap. Pure. */
export function normalizeCues(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((p, q) => p.start - q.start);
  return sorted
    .map((c, i) => {
      const next = sorted[i + 1];
      const end = next ? Math.min(c.end, next.start) : c.end;
      return { ...c, end };
    })
    .filter((c) => c.end > c.start);
}

export function formatSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join("\n");
}

export type CaptionStyle = "clean" | "social";

/** libass force_style overrides. SRT is laid out on a 288 px-tall canvas, so
 * sizes are relative to that: "clean" is a modest outlined line at the bottom;
 * "social" is large, bold, on a dark box, raised clear of app UI. */
export const CAPTION_STYLES: Record<CaptionStyle, string> = {
  clean: "FontName=Inter,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.5,Shadow=0,MarginV=16",
  social: "FontName=Inter,Bold=1,FontSize=22,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=3,Outline=6,Shadow=0,MarginV=40",
};

/** The subtitles filter; shared by burn_subtitles and pipeline (#244). Pure. */
export function subtitlesFilter(subtitles: string, fontsDir: string, style: CaptionStyle | null = "clean"): string {
  const force = style === null ? null : CAPTION_STYLES[style];
  if (force === undefined) throw new ScreencastError(`Unknown caption style "${style}".`);
  return (
    `subtitles=filename=${escapeFilterPath(subtitles)}:fontsdir=${escapeFilterPath(fontsDir)}` +
    (force ? `:force_style='${force}'` : "")
  );
}

/** Burn an SRT/ASS file into the video with the bundled font. A null style
 * keeps an .ass file's own styling instead of forcing one (#189). */
export function buildBurnSubtitlesArgs(
  input: string,
  subtitles: string,
  output: string,
  fontsDir: string,
  style: CaptionStyle | null = "clean",
  quality: Quality = "standard",
): string[] {
  return [
    "-y", "-i", input,
    "-vf", subtitlesFilter(subtitles, fontsDir, style),
    ...resolveQuality(quality),
    "-c:a", "copy",
    output,
  ];
}
