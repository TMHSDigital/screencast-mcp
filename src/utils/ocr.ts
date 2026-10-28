/**
 * On-screen text recognition with the OCR engine built into Windows
 * (Windows.Media.Ocr), so no model or package is installed (#117).
 *
 * The engine misses small text and, notably, drops ALL_CAPS words joined by
 * underscores (an env-var name like OPENAI_API_KEY, and anything glued to it
 * with `=`) at ordinary sizes. Measured on 18 px UI text: missing at 1x-3x,
 * recovered at 4x. So recognition runs two passes (2x and 4x upscales) in one
 * PowerShell process and merges them, and matching tolerates the engine's
 * usual confusions (`_` read as `-`, `I` as `l`).
 *
 * The PowerShell/WinRT call is impure; parsing, merging, and matching are pure.
 */
import { runInNewContext } from "node:vm";
import { ScreencastError } from "./errors.js";
import { runPowerShell, psTimeoutMs } from "./monitors.js";
import type { Rect } from "./diff.js";

/** Upscale factors for the two recognition passes. */
export const OCR_SCALES = [2, 4];
/** Windows.Media.Ocr refuses images larger than this on either side. */
export const OCR_MAX_DIMENSION = 10_000;

export interface OcrWord extends Rect {
  text: string;
}
export interface OcrLine extends Rect {
  text: string;
  words: OcrWord[];
}

/** Recognise every image in `paths` (already upscaled by `scales[i]`) in one
 * PowerShell run. Paths travel base64-encoded, so no quoting is involved. */
export async function recognize(paths: string[], scales: number[]): Promise<OcrLine[][]> {
  if (process.platform !== "win32") {
    throw new ScreencastError("find_text uses the Windows OCR engine and runs on Windows only.");
  }
  const list = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  // The limit grows with the image count, so a whole-clip scan gets the time it needs.
  const stdout = await runPowerShell(PS_OCR.replace("__PATHS__", list), "text (OCR)", {
    timeoutMs: psTimeoutMs(OCR_TIMEOUT_MS + Math.max(0, paths.length - 2) * OCR_PER_IMAGE_MS),
  });
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    throw new ScreencastError(`Could not parse OCR output: ${(err as Error).message}`);
  }
  const passes = Array.isArray(raw) ? raw : [raw];
  return passes.map((p, i) => parseOcrPass(p, scales[i] ?? 1));
}

interface RawPass {
  error?: string;
  lines?: Array<{ text?: string; words?: Array<{ text?: string; x?: number; y?: number; width?: number; height?: number }> }>;
}

/** Turn one pass's JSON into lines in ORIGINAL image pixels (dividing out the
 * upscale), each with a bounding box around its words. Pure. */
export function parseOcrPass(raw: unknown, scale: number): OcrLine[] {
  const pass = (raw ?? {}) as RawPass;
  if (pass.error) {
    if (/language|recognizer/i.test(pass.error)) {
      throw new ScreencastError(
        `Windows OCR is unavailable: ${pass.error}`,
        "Install an OCR language: Settings > Time & language > Language > (your language) > Options > Optical character recognition.",
      );
    }
    throw new ScreencastError(`OCR failed: ${pass.error}`);
  }
  const lines: OcrLine[] = [];
  for (const l of pass.lines ?? []) {
    const words = (Array.isArray(l.words) ? l.words : l.words ? [l.words] : []).map((w) => ({
      text: String(w.text ?? ""),
      x: Math.round((w.x ?? 0) / scale),
      y: Math.round((w.y ?? 0) / scale),
      width: Math.max(1, Math.round((w.width ?? 0) / scale)),
      height: Math.max(1, Math.round((w.height ?? 0) / scale)),
    }));
    if (words.length === 0) continue;
    lines.push({ text: String(l.text ?? words.map((w) => w.text).join(" ")), words, ...unionRect(words) });
  }
  return lines;
}

export function unionRect(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function overlapRatio(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

/** Merge recognition passes: start from the first, then add lines a later pass
 * found that overlap nothing already kept; where they overlap, keep the
 * longer reading. Result is in reading order. Pure. */
export function mergePasses(passes: OcrLine[][]): OcrLine[] {
  const kept: OcrLine[] = [];
  for (const pass of passes) {
    for (const line of pass) {
      const i = kept.findIndex((k) => overlapRatio(k, line) > 0.5);
      const match = kept[i];
      if (!match) kept.push(line);
      else if (line.text.length > match.text.length) kept[i] = line;
    }
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Fold the engine's usual confusions so a query still matches a misread:
 * case, `-`/`_`/space, `l`/`I`/`1`/`|`, and `O`/`0`. Pure. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, "_").replace(/[l1|]/g, "i").replace(/0/g, "o");
}

export interface TextMatch extends Rect {
  /** The recognised text of the matching words. */
  text: string;
  line: string;
}

/** Longest query findMatches accepts (#185). */
export const MAX_QUERY_LENGTH = 500;
/** Time budget for running a regex query over every line (#185). */
export const REGEX_BUDGET_MS = 1_000;

/** Match ranges for `re` in each text, also trying `_` and `-` swapped either
 * way: the engine often reads one as the other, and a secret pattern like
 * `ghp_` must still match `ghp-` (#236). Same length, so offsets map to words
 * as is. Runs inside a vm context so the caller can bound it with a timeout. */
const REGEX_SCAN = `JSON.stringify(texts.map((text) => {
  const re = new RegExp(query, "gi");
  const seen = new Set();
  const ranges = [];
  for (const variant of [text, text.replace(/-/g, "_"), text.replace(/_/g, "-")]) {
    for (const m of variant.matchAll(re)) {
      const key = m.index + ":" + m[0].length;
      if (m[0].length > 0 && !seen.has(key)) {
        seen.add(key);
        ranges.push([m.index, m.index + m[0].length]);
      }
    }
  }
  return ranges;
}))`;

/** Run a user regex over the texts within REGEX_BUDGET_MS, so a pattern that
 * backtracks catastrophically, like `(a+)+$`, fails the call instead of
 * freezing the server (#185). */
export function regexRanges(texts: string[], query: string, budgetMs = REGEX_BUDGET_MS): Array<Array<[number, number]>> {
  try {
    new RegExp(query, "gi");
  } catch (err) {
    throw new ScreencastError(`Invalid regex: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(runInNewContext(REGEX_SCAN, { texts, query }, { timeout: budgetMs }) as string);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new ScreencastError(
        `The regex took longer than ${budgetMs / 1000} s to run and was stopped.`,
        "Simplify it: nested quantifiers such as (a+)+ backtrack catastrophically.",
      );
    }
    throw err;
  }
}

/** Find `query` (plain text, or a regular expression when `regex`) in the
 * lines. Plain queries also match through normalizeForMatch. Each hit is
 * boxed around the words it spans. Pure. */
export function findMatches(lines: OcrLine[], query: string, regex = false): TextMatch[] {
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ScreencastError(`The query is ${query.length} characters; at most ${MAX_QUERY_LENGTH} are allowed.`);
  }
  // Rebuild each line from its words so character offsets map to words.
  const rebuilt = lines.map((line) => {
    const spans: Array<{ start: number; end: number; word: OcrWord }> = [];
    let text = "";
    for (const w of line.words) {
      if (text) text += " ";
      spans.push({ start: text.length, end: text.length + w.text.length, word: w });
      text += w.text;
    }
    return { line, spans, text };
  });
  const regexHits = regex ? regexRanges(rebuilt.map((r) => r.text), query) : null;
  const out: TextMatch[] = [];
  rebuilt.forEach(({ line, spans }, i) => {
    let ranges: Array<[number, number]> = [];
    if (regexHits) {
      ranges = regexHits[i] ?? [];
    } else {
      // normalizeForMatch keeps string length except for collapsing runs of
      // separators, so search the normalized text and map back word by word.
      const needle = normalizeForMatch(query);
      if (!needle) return;
      const hay = spans.map((s) => normalizeForMatch(s.word.text)).join("_");
      let from = 0;
      for (let at = hay.indexOf(needle, from); at !== -1; at = hay.indexOf(needle, from)) {
        ranges.push(normalizedRangeToText(spans, at, at + needle.length));
        from = at + needle.length;
      }
    }
    const boxed = new Set<OcrWord>();
    for (const [start, end] of ranges) {
      const words = spans.filter((s) => s.start < end && s.end > start).map((s) => s.word);
      if (words.length === 0 || words.every((w) => boxed.has(w))) continue;
      words.forEach((w) => boxed.add(w));
      out.push({ text: words.map((w) => w.text).join(" "), line: line.text, ...unionRect(words) });
    }
  });
  return out;
}

/** Map a range in the `_`-joined normalized word string back to a range in
 * the space-joined text (both join words with one character). */
function normalizedRangeToText(
  spans: Array<{ start: number; end: number; word: OcrWord }>,
  start: number,
  end: number,
): [number, number] {
  let pos = 0;
  let textStart = -1;
  let textEnd = -1;
  for (const s of spans) {
    const len = normalizeForMatch(s.word.text).length;
    if (textStart === -1 && start < pos + len) textStart = s.start;
    if (end <= pos + len + 1) {
      textEnd = s.end;
      break;
    }
    pos += len + 1;
  }
  return [textStart === -1 ? 0 : textStart, textEnd === -1 ? (spans.at(-1)?.end ?? 0) : textEnd];
}

/** Padded rectangles for redact_region, clamped to the frame. Pure. */
export function redactionRects(matches: Rect[], frame: { width: number; height: number }, pad = 4): Rect[] {
  return matches.map((m) => {
    const x = Math.max(0, m.x - pad);
    const y = Math.max(0, m.y - pad);
    return {
      x,
      y,
      width: Math.min(frame.width, m.x + m.width + pad) - x,
      height: Math.min(frame.height, m.y + m.height + pad) - y,
    };
  });
}

/** The scales actually used for an image of this size: each OCR_SCALES entry,
 * capped so the upscaled image stays within the engine's limit. Pure. */
export function passScales(width: number, height: number): number[] {
  const cap = OCR_MAX_DIMENSION / Math.max(width, height);
  const scales = OCR_SCALES.map((s) => Math.min(s, Math.floor(cap * 100) / 100)).filter((s) => s >= 1);
  return [...new Set(scales.length ? scales : [Math.min(1, cap)])];
}

/** Limit for one OCR run (all passes of all images) (#183). */
export const OCR_TIMEOUT_MS = 60_000;
/** Extra time per image beyond the first two (a whole-clip scan, #204). */
export const OCR_PER_IMAGE_MS = 5_000;
/** Limit for one WinRT call inside it (open, decode, recognise). */
export const OCR_STEP_TIMEOUT_MS = 20_000;

// Windows PowerShell 5.1 + WinRT: decode each image, recognise it with the
// user's profile languages, and print one JSON object per image.
const PS_OCR = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); if (-not $task.Wait(${OCR_STEP_TIMEOUT_MS})) { throw "The OCR engine did not answer within ${OCR_STEP_TIMEOUT_MS / 1000} s." }; $task.Result }
$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATHS__')) | ConvertFrom-Json
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$out = foreach ($p in $paths) {
  try {
    if ($null -eq $engine) { throw 'No OCR recognizer language is installed.' }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
    [pscustomobject]@{ lines = @(foreach ($l in $result.Lines) {
      [pscustomobject]@{ text = $l.Text; words = @(foreach ($w in $l.Words) {
        [pscustomobject]@{ text = $w.Text; x = $w.BoundingRect.X; y = $w.BoundingRect.Y; width = $w.BoundingRect.Width; height = $w.BoundingRect.Height } }) } }) }
  } catch { [pscustomobject]@{ error = $_.Exception.Message } }
}
ConvertTo-Json -InputObject @($out) -Depth 6 -Compress
`;
