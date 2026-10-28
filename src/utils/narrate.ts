/**
 * Offline text-to-speech voiceover (#175).
 *
 * Each line is spoken by the speech engine built into Windows
 * (Windows.Media.SpeechSynthesis, the same WinRT-through-PowerShell pattern as
 * OCR), written to a WAV, and placed on the video's timeline with adelay. The
 * lines are summed (amix normalize=0) into a voice bus padded to the video's
 * length, which is mixed over the original audio, optionally ducking it with
 * sidechaincompress. Nothing leaves the machine: the text travels to a local
 * PowerShell process base64-encoded, and the voices are the installed ones.
 *
 * The PowerShell call is impure; line resolution, placement, the WAV header
 * parser, and the ffmpeg builder are pure.
 */
import { ScreencastError } from "./errors.js";
import { runPowerShell, psTimeoutMs } from "./monitors.js";
import { audioCodecFor } from "./audio.js";
import { isAudioOnlyPath } from "./media.js";
import type { Marker } from "./chapters.js";
import type { Cue } from "./captions.js";

export const MAX_LINES = 200;
export const MAX_LINE_CHARS = 1_000;
/** SpeechSynthesizerOptions.SpeakingRate accepts 0.5..6; past 3 is unintelligible. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 3;

export interface NarrationLineInput {
  /** Video seconds. */
  t?: number;
  /** A marker label (from the video's markers sidecar or embedded chapters). */
  marker?: string;
  text: string;
}

export interface NarrationLine {
  t: number;
  text: string;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Resolve each line's start: `t` as given, or the time of the marker whose
 * label matches (case-insensitive). Sorted by start. Pure. */
export function resolveLines(lines: readonly NarrationLineInput[], markers: readonly Marker[]): NarrationLine[] {
  if (lines.length === 0) throw new ScreencastError("lines is empty: give at least one { t | marker, text }.");
  if (lines.length > MAX_LINES) throw new ScreencastError(`At most ${MAX_LINES} lines are allowed (got ${lines.length}).`);
  const out = lines.map((line, i) => {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) throw new ScreencastError(`lines[${i}] has no text.`);
    if (text.length > MAX_LINE_CHARS) {
      throw new ScreencastError(`lines[${i}] is ${text.length} characters; at most ${MAX_LINE_CHARS} are allowed. Split it.`);
    }
    if (line.t !== undefined && line.marker !== undefined) {
      throw new ScreencastError(`lines[${i}] has both t and marker; give one.`);
    }
    if (line.t !== undefined) {
      if (!Number.isFinite(line.t) || line.t < 0) throw new ScreencastError(`lines[${i}].t must be a non-negative number.`);
      return { t: r3(line.t), text };
    }
    if (line.marker !== undefined) {
      const want = line.marker.trim().toLowerCase();
      const m = markers.find((k) => k.label.trim().toLowerCase() === want);
      if (!m) {
        const known = markers.map((k) => `"${k.label}"`).join(", ");
        throw new ScreencastError(
          `lines[${i}]: no marker labelled "${line.marker}".`,
          known ? `Markers on this video: ${known}.` : "This video has no markers; add_marker stamps one, or give t.",
        );
      }
      return { t: r3(m.t), text };
    }
    throw new ScreencastError(`lines[${i}] needs t (seconds) or marker (a marker label).`);
  });
  return out.sort((a, b) => a.t - b.t);
}

export interface Placement extends NarrationLine {
  /** Spoken length, seconds. */
  durationSec: number;
}

/** Warnings for lines that overrun the next line or the end of the video. Pure. */
export function placementWarnings(placed: readonly Placement[], videoDurationSec: number): string[] {
  const warnings: string[] = [];
  placed.forEach((p, i) => {
    const end = p.t + p.durationSec;
    const next = placed[i + 1];
    const quote = `"${p.text.length > 40 ? `${p.text.slice(0, 40)}...` : p.text}"`;
    if (p.t >= videoDurationSec) {
      warnings.push(`Line at ${p.t}s ${quote} starts after the video ends (${r3(videoDurationSec)}s) and is not heard.`);
    } else if (next && end > next.t + 0.05) {
      warnings.push(
        `Line at ${p.t}s ${quote} runs ${r3(end - next.t)}s past the next line (${next.t}s); they overlap. Move the next line, shorten this one, or raise rate.`,
      );
    } else if (end > videoDurationSec + 0.05) {
      warnings.push(`Line at ${p.t}s ${quote} runs ${r3(end - videoDurationSec)}s past the end of the video and is cut off.`);
    }
  });
  return warnings;
}

/** SRT cues for the spoken lines, clipped so they never overlap or run past
 * the video. Pure. */
export function narrationCues(placed: readonly Placement[], videoDurationSec: number): Cue[] {
  return placed
    .map((p, i) => {
      const next = placed[i + 1];
      const end = Math.min(p.t + p.durationSec, next ? next.t : Infinity, videoDurationSec);
      return { start: p.t, end: r3(end), text: p.text };
    })
    .filter((c) => c.end > c.start);
}

/** Duration of a PCM WAV from its header: data size / byte rate. Pure. */
export function wavDurationSec(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new ScreencastError("The speech engine did not return a WAV file.");
  }
  let byteRate = 0;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt " && off + 16 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
    if (id === "data") {
      if (byteRate <= 0) break;
      // A streamed WAV may leave the size unset (0 or 0xFFFFFFFF): use what is there.
      const available = buf.length - (off + 8);
      const bytes = size === 0 || size === 0xffffffff || size > available ? available : size;
      return bytes / byteRate;
    }
    off += 8 + size + (size % 2);
  }
  throw new ScreencastError("Could not read the WAV header the speech engine wrote.");
}

/**
 * The narration mix: video input 0 (stream-copied), one WAV input per line.
 * Each line is delayed to its start; the lines are summed into a voice bus
 * padded and trimmed to the video's length, then mixed over the original
 * audio (ducked under the voice when `duck`). Pure.
 */
export function buildNarrateArgs(
  video: string,
  wavs: readonly string[],
  output: string,
  placed: readonly Placement[],
  videoDurationSec: number,
  opts: { hasAudio: boolean; duck?: boolean; channels?: number | null },
): string[] {
  if (!Number.isFinite(videoDurationSec) || videoDurationSec <= 0) {
    throw new ScreencastError("video duration must be known and positive.");
  }
  if (wavs.length === 0 || wavs.length !== placed.length) {
    throw new ScreencastError("Every placed line needs its WAV.");
  }
  const D = r3(videoDurationSec);
  const mix = (n: number) => `amix=inputs=${n}:duration=longest:dropout_transition=0:normalize=0`;
  const parts = placed.map((p, i) => {
    const ms = Math.round(p.t * 1000);
    return `[${i + 1}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}[l${i}]`;
  });
  const lines = placed.map((_, i) => `[l${i}]`).join("");
  // The mix keeps a mono original mono; otherwise it is stereo. The voice is
  // copied to both channels with pan rather than aformat, whose mono-to-stereo
  // upmix costs 3 dB (and would cost the original the same).
  const stereo = !(opts.hasAudio && opts.channels === 1);
  const bus = `apad,atrim=end=${D}${stereo ? ",pan=stereo|c0=c0|c1=c0" : ""}`;
  const voice = opts.hasAudio ? "voice" : "aout";
  parts.push(placed.length > 1 ? `${lines}${mix(placed.length)},${bus}[${voice}]` : `[l0]${bus}[${voice}]`);
  if (opts.hasAudio) {
    parts.push(`[0:a]aresample=48000,aformat=channel_layouts=${stereo ? "stereo" : "mono"}[orig]`);
    if (opts.duck ?? true) {
      parts.push("[voice]asplit=2[vo][key]");
      parts.push("[orig][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[bed]");
      parts.push(`[bed][vo]${mix(2)}[aout]`);
    } else {
      parts.push(`[orig][voice]${mix(2)}[aout]`);
    }
  }
  const audioOnly = isAudioOnlyPath(output);
  return [
    "-y",
    "-i", video,
    ...wavs.flatMap((w) => ["-i", w]),
    "-filter_complex", parts.join(";"),
    ...(audioOnly ? [] : ["-map", "0:v?", "-c:v", "copy"]),
    "-map", "[aout]",
    "-t", String(D),
    ...audioCodecFor(output),
    ...(/\.(mp4|mov|m4a)$/i.test(output) ? ["-movflags", "+faststart"] : []),
    output,
  ];
}

export interface Voice {
  name: string;
  language: string;
  gender: string;
}

/** Limit for one synthesis run, plus time per line (#183 pattern). */
export const TTS_TIMEOUT_MS = 30_000;
export const TTS_PER_LINE_MS = 10_000;
/** Limit for one WinRT call inside it. */
export const TTS_STEP_TIMEOUT_MS = 30_000;

interface RawVoice {
  name?: string;
  language?: string;
  gender?: string;
}
interface RawTts {
  error?: string;
  voice?: string;
  voices?: RawVoice[] | RawVoice;
  results?: Array<{ error?: string }> | { error?: string };
}

const asArray = <T>(v: T[] | T | undefined): T[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Parse the shim's JSON into voices. Pure. */
export function parseVoices(raw: RawTts): Voice[] {
  return asArray(raw.voices).map((v) => ({ name: String(v.name ?? ""), language: String(v.language ?? ""), gender: String(v.gender ?? "") }));
}

async function runTts(request: object, timeoutMs: number, signal?: AbortSignal): Promise<RawTts> {
  if (process.platform !== "win32") {
    throw new ScreencastError("narrate uses the speech engine built into Windows and runs on Windows only.");
  }
  const req = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const stdout = await runPowerShell(PS_TTS.replace("__REQ__", req), "speech voices", { timeoutMs, signal });
  try {
    return JSON.parse(stdout) as RawTts;
  } catch (err) {
    throw new ScreencastError(`Could not parse the speech engine's output: ${(err as Error).message}`);
  }
}

/** The installed Windows voices. */
export async function listVoices(signal?: AbortSignal): Promise<Voice[]> {
  const raw = await runTts({ list: true }, psTimeoutMs(15_000), signal);
  if (raw.error) throw new ScreencastError(`Windows speech is unavailable: ${raw.error}`);
  return parseVoices(raw);
}

/** Whether narrate works here, and with which voices. Never throws. */
export async function ttsStatus(): Promise<{ available: boolean; voices: string[]; error?: string }> {
  if (process.platform !== "win32") return { available: false, voices: [], error: "Windows speech is available on Windows only." };
  try {
    const voices = (await listVoices()).map((v) => `${v.name} (${v.language})`);
    return { available: voices.length > 0, voices, ...(voices.length ? {} : { error: "No speech voices are installed." }) };
  } catch (err) {
    return { available: false, voices: [], error: (err as Error).message };
  }
}

/** Speak each text into the matching WAV path, in one PowerShell run. Returns
 * the voice used. */
export async function synthesize(
  items: ReadonlyArray<{ text: string; path: string }>,
  opts: { voice?: string; rate?: number; signal?: AbortSignal },
): Promise<string> {
  const rate = opts.rate ?? 1;
  if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
    throw new ScreencastError(`rate must be between ${MIN_RATE} and ${MAX_RATE} (1 is normal speed).`);
  }
  const raw = await runTts(
    { voice: opts.voice ?? null, rate, items },
    psTimeoutMs(TTS_TIMEOUT_MS + items.length * TTS_PER_LINE_MS),
    opts.signal,
  );
  if (raw.error) {
    const voices = parseVoices(raw);
    if (raw.error === "unknown voice") {
      throw new ScreencastError(
        `No installed voice matches "${opts.voice}".`,
        voices.length ? `Installed voices: ${voices.map((v) => `${v.name} (${v.language})`).join(", ")}.` : "No voices are installed.",
      );
    }
    throw new ScreencastError(
      `Windows speech is unavailable: ${raw.error}`,
      "Install a voice: Settings > Time & language > Speech > Manage voices.",
    );
  }
  asArray(raw.results).forEach((r, i) => {
    if (r.error) throw new ScreencastError(`Could not synthesize line ${i + 1}: ${r.error}`);
  });
  return String(raw.voice ?? "");
}

// Windows PowerShell 5.1 + WinRT. The request (voice, rate, texts, WAV paths)
// arrives base64-encoded JSON, so no quoting is involved.
const PS_TTS = `
$ErrorActionPreference = 'Stop'
function Out($o) { ConvertTo-Json -InputObject $o -Depth 5 -Compress }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime]
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__REQ__')) | ConvertFrom-Json
  $all = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices)
  $voices = @($all | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; language = $_.Language; gender = [string]$_.Gender } })
  if ($req.list) { Out ([pscustomobject]@{ voices = $voices }); return }
  if ($all.Count -eq 0) { Out ([pscustomobject]@{ error = 'No speech voices are installed.'; voices = $voices }); return }
  $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  if ($req.voice) {
    $want = [string]$req.voice
    $v = $all | Where-Object { $_.DisplayName -eq $want -or $_.Id -eq $want } | Select-Object -First 1
    if (-not $v) { $v = $all | Where-Object { $_.DisplayName.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1 }
    if (-not $v) { Out ([pscustomobject]@{ error = 'unknown voice'; voices = $voices }); return }
    $synth.Voice = $v
  }
  $synth.Options.SpeakingRate = [double]$req.rate
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  $results = foreach ($item in @($req.items)) {
    try {
      $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($synth.SynthesizeTextToStreamAsync([string]$item.text)))
      if (-not $task.Wait(${TTS_STEP_TIMEOUT_MS})) { throw "The speech engine did not answer within ${TTS_STEP_TIMEOUT_MS / 1000} s." }
      $stream = $task.Result
      $in = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
      $fs = [System.IO.File]::Create([string]$item.path)
      try { $in.CopyTo($fs) } finally { $fs.Dispose(); $in.Dispose(); $stream.Dispose() }
      [pscustomobject]@{ ok = $true }
    } catch { [pscustomobject]@{ error = $_.Exception.Message } }
  }
  Out ([pscustomobject]@{ voice = $synth.Voice.DisplayName; results = @($results) })
} catch { Out ([pscustomobject]@{ error = $_.Exception.Message }) }
`;
