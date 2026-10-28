/**
 * bug_report (#198): the pure half of turning a recording into a paste-ready
 * repro package. The tool (src/tools/bugReport.ts) runs ffmpeg and OCR; this
 * module picks the clip window, turns the input event log into numbered
 * steps, merges the secret scan's redaction boxes, pulls error text out of
 * the OCR'd frames (with any secret in it masked), and writes report.md.
 *
 * Everything here is pure, so it is unit-tested without ffmpeg or Windows.
 */
import { ScreencastError } from "./errors.js";
import type { InputEvent, GapReason } from "./events.js";
import { findMatches, normalizeForMatch, regexRanges, type OcrLine } from "./ocr.js";
import type { TimedRect } from "./ocrScan.js";
import { formatTimecode } from "./sheet.js";

/** Seconds of the recording's end the clip keeps by default. */
export const DEFAULT_CLIP_SEC = 30;
export const MAX_CLIP_SEC = 600;
/** Default secret-scan interval, in seconds. */
export const DEFAULT_SCAN_EVERY_SEC = 1;
/** Steps written to the report at most; the rest are counted. */
export const MAX_STEPS = 100;
/** Distinct error lines kept at most. */
export const MAX_ERROR_LINES = 20;

/** Token shapes and labelled values that should never reach a shared report:
 * provider API keys (OpenAI, GitHub, Slack, AWS, Google, Stripe), JWTs, and a
 * `password:`, `token=`, `api key` label with the value after it. Matched
 * case-insensitively and with `_`/`-` swapped (OCR misreads, #236). */
export const DEFAULT_SECRET_PATTERN = [
  "\\b(?:sk|pk|rk)-[a-z0-9_-]{8,}",
  "\\bgh[pousr]_[a-z0-9]{10,}",
  "\\bgithub_pat_[a-z0-9_]{10,}",
  "\\bxox[abprs]-[a-z0-9-]{8,}",
  "\\bAKIA[0-9A-Z]{12,}",
  "\\bAIza[0-9a-z_-]{20,}",
  "\\beyJ[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}",
  "(?:api.?key|secret|token|passw(?:or)?d|bearer|authorization)\\s*[:=]?\\s*\\S+",
].join("|");

/** Lines worth quoting as the failure: errors, exceptions, and the usual
 * dialog wording for something that went wrong. */
export const DEFAULT_ERROR_PATTERN =
  "error|exception|fail(?:ed|ure)?|fatal|crash|denied|refused|not found|cannot|can't|unable|invalid|" +
  "timed? ?out|traceback|panic|unhandled|warning";

/** The file names written into the report folder. */
export const REPORT_FILES = {
  markdown: "report.md",
  json: "report.json",
  clip: "clip.mp4",
  contactSheet: "contact-sheet.png",
  gif: (format: "gif" | "webp") => `repro.${format}`,
} as const;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The part of the recording the clip keeps: start..end when given, else the
 * last `clipSec` seconds (the failure is usually at the end). Pure. */
export function clipWindow(
  durationSec: number,
  opts: { start?: number; end?: number; clipSec?: number } = {},
): { start: number; end: number } {
  if (!(durationSec > 0)) throw new ScreencastError("Could not read the recording's duration.");
  const end = Math.min(opts.end ?? durationSec, durationSec);
  const clipSec = opts.clipSec ?? DEFAULT_CLIP_SEC;
  const start = opts.start ?? Math.max(0, end - clipSec);
  if (start >= durationSec) {
    throw new ScreencastError(`start ${start}s is past the end of the ${r3(durationSec)}s recording.`);
  }
  if (!(end > start)) throw new ScreencastError("end must be after start.");
  if (end - start > MAX_CLIP_SEC) {
    throw new ScreencastError(`The clip would be ${r3(end - start)}s; at most ${MAX_CLIP_SEC}s. Narrow start/end.`);
  }
  return { start: r3(start), end: r3(end) };
}

export type StepAction = "click" | "double_click" | "shortcut" | "typing" | "scroll" | "gap";

export interface ReproStep {
  /** Seconds on the recording's clock. */
  t: number;
  action: StepAction;
  /** One line a person can follow. */
  text: string;
  x?: number;
  y?: number;
}

/** Two presses this close (s, px) with the same button read as a double-click. */
const DOUBLE_CLICK_SEC = 0.5;
const DOUBLE_CLICK_PX = 6;
/** Wheel notches this close together (s) are one scroll. */
const SCROLL_JOIN_SEC = 1;

const GAP_WHY: Record<GapReason, string> = {
  input_not_seen: "input went to an elevated window or the lock screen, or the hook was removed",
  helper_stalled: "the event logger paused",
  helper_stopped: "the event logger stopped",
};

function clickText(button: string | undefined, double: boolean, e: InputEvent): string {
  const verb = double ? "double-click" : "click";
  const which = button && button !== "left" ? `${button.charAt(0).toUpperCase()}${button.slice(1)} ${verb}` : `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  return e.inFrame ? `${which} at (${e.x}, ${e.y})` : `${which} outside the recorded area`;
}

/**
 * Numbered repro steps from an input event log (#118): clicks (with
 * double-clicks folded), shortcuts, typing bursts (the text is never logged),
 * scrolls joined into one step, and gaps where events may be missing. Cursor
 * moves and button releases are not steps. Pure.
 */
export function reconstructSteps(events: InputEvent[]): ReproStep[] {
  const steps: ReproStep[] = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  let lastDown: { e: InputEvent; step: ReproStep } | null = null;
  let scroll: { step: ReproStep; axis: "vertical" | "horizontal"; notches: number; last: number } | null = null;
  const scrollText = (axis: "vertical" | "horizontal", notches: number) => {
    const dir = axis === "vertical" ? (notches >= 0 ? "up" : "down") : notches >= 0 ? "right" : "left";
    const n = Math.abs(notches);
    return `Scroll ${dir} ${n} notch${n === 1 ? "" : "es"}`;
  };
  for (const e of sorted) {
    if (e.type === "move" || e.type === "up") continue;
    if (e.type !== "wheel") scroll = null;
    if (e.type === "down") {
      const prev = lastDown;
      if (
        prev &&
        prev.e.button === e.button &&
        e.t - prev.e.t <= DOUBLE_CLICK_SEC &&
        Math.abs(e.x - prev.e.x) <= DOUBLE_CLICK_PX &&
        Math.abs(e.y - prev.e.y) <= DOUBLE_CLICK_PX &&
        prev.step.action === "click" &&
        steps.at(-1) === prev.step
      ) {
        prev.step.action = "double_click";
        prev.step.text = clickText(e.button, true, prev.e);
        lastDown = null;
        continue;
      }
      const step: ReproStep = { t: e.t, action: "click", text: clickText(e.button, false, e), x: e.x, y: e.y };
      steps.push(step);
      lastDown = { e, step };
      continue;
    }
    lastDown = null;
    if (e.type === "wheel") {
      const axis = e.axis ?? "vertical";
      const delta = e.delta ?? 0;
      if (scroll && scroll.axis === axis && e.t - scroll.last <= SCROLL_JOIN_SEC && Math.sign(delta) === Math.sign(scroll.notches)) {
        scroll.notches += delta;
        scroll.last = e.t;
        scroll.step.text = scrollText(axis, scroll.notches);
        continue;
      }
      const step: ReproStep = { t: e.t, action: "scroll", text: scrollText(axis, delta), x: e.x, y: e.y };
      steps.push(step);
      scroll = { step, axis, notches: delta, last: e.t };
    } else if (e.type === "key") {
      steps.push({ t: e.t, action: "shortcut", text: `Press ${e.keys ?? "a shortcut"}` });
    } else if (e.type === "typing") {
      const d = e.durationSec ?? 0;
      steps.push({ t: e.t, action: "typing", text: `Type${d > 0 ? ` for ${r3(d)} s` : ""} (keys are not logged)` });
    } else if (e.type === "gap") {
      const why = GAP_WHY[e.reason ?? "input_not_seen"];
      steps.push({ t: e.t, action: "gap", text: `Input may be missing for ${r3(e.durationSec ?? 0)} s (${why})` });
    }
  }
  return steps;
}

/** True when two rectangles overlap by at least half of the smaller one. */
function mostlyOverlap(a: TimedRect, b: TimedRect): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return false;
  return w * h >= 0.5 * Math.min(a.width * a.height, b.width * b.height);
}

/**
 * Fold the scan's per-sample boxes into fewer, longer ones: a secret that
 * stays on screen gives one box per sample, each overlapping the next in time
 * and place. Boxes that mostly overlap and whose windows touch become their
 * union (covering more, never less). Pure.
 */
export function mergeRedactions(regions: TimedRect[]): TimedRect[] {
  const out: TimedRect[] = [];
  for (const r of [...regions].sort((a, b) => a.start - b.start)) {
    const into = out.find((o) => r.start <= o.end && mostlyOverlap(o, r));
    if (!into) {
      out.push({ ...r });
      continue;
    }
    const x = Math.min(into.x, r.x);
    const y = Math.min(into.y, r.y);
    into.width = Math.max(into.x + into.width, r.x + r.width) - x;
    into.height = Math.max(into.y + into.height, r.y + r.height) - y;
    into.x = x;
    into.y = y;
    into.start = Math.min(into.start, r.start);
    into.end = Math.max(into.end, r.end);
  }
  return out;
}

export const MASK = "[REDACTED]";

/** Replace whatever `pattern` (a regex) matches in each text with
 * [REDACTED], so OCR'd text quoted in the report cannot leak a secret. Pure. */
export function maskSecrets(texts: string[], pattern: string): string[] {
  if (texts.length === 0) return [];
  const ranges = regexRanges(texts, pattern);
  return texts.map((text, i) => {
    const spans = [...(ranges[i] ?? [])].sort((a, b) => a[0] - b[0]);
    let out = "";
    let at = 0;
    for (const [s, e] of spans) {
      if (e <= at) continue;
      out += text.slice(at, Math.max(at, s)) + (s >= at ? MASK : "");
      at = e;
    }
    return out + text.slice(at);
  });
}

export interface ErrorFinding {
  /** The OCR'd line, with secrets masked. */
  text: string;
  /** First and last sample it was seen on, in seconds from the clip start. */
  firstSeen: number;
  lastSeen: number;
}

/**
 * The distinct OCR'd lines that look like an error (errorPattern), in the
 * order they first appeared, each with when it was on screen. Secrets in them
 * are masked with secretPattern. The lines still showing on the last sample
 * come first, since that is usually the failure. Pure.
 */
export function errorFindings(
  frames: Array<{ t: number; lines: OcrLine[] }>,
  errorPattern: string,
  secretPattern: string | null,
): ErrorFinding[] {
  const found = new Map<string, ErrorFinding>();
  for (const frame of frames) {
    const hitLines = new Set(findMatches(frame.lines, errorPattern, true).map((m) => m.line));
    for (const line of hitLines) {
      const key = normalizeForMatch(line);
      const seen = found.get(key);
      if (seen) seen.lastSeen = frame.t;
      else found.set(key, { text: line, firstSeen: frame.t, lastSeen: frame.t });
    }
  }
  const lastT = frames.at(-1)?.t;
  const list = [...found.values()].sort(
    (a, b) => Number(b.lastSeen === lastT) - Number(a.lastSeen === lastT) || a.firstSeen - b.firstSeen,
  ).slice(0, MAX_ERROR_LINES);
  if (!secretPattern) return list;
  const masked = maskSecrets(list.map((f) => f.text), secretPattern);
  return list.map((f, i) => ({ ...f, text: masked[i] ?? f.text }));
}

export interface BugReportData {
  title: string;
  expected?: string;
  actual?: string;
  createdAt: string;
  clip: { start: number; end: number; recordingDurationSec: number; width: number; height: number };
  /** Names of the files in the report folder. */
  files: { clip: string; gif?: string; contactSheet?: string };
  gif?: { format: "gif" | "webp"; sizeBytes: number; withinBudget: boolean };
  steps: ReproStep[];
  /** Steps not written (past MAX_STEPS). */
  stepsOmitted?: number;
  /** Why there are no steps, when there are none. */
  stepsNote?: string;
  errors: ErrorFinding[];
  /** read: OCR ran; unavailable: no Windows OCR here. */
  ocr: "read" | "unavailable";
  redaction: {
    scanned: boolean;
    everySec?: number;
    framesScanned?: number;
    /** Boxes from the secret scan, after merging. */
    found: number;
    /** Boxes the caller passed. */
    manual: number;
  };
  /** Ordered label -> value rows for the Environment table. */
  environment: Array<[string, string]>;
}

/** Inline code that survives any text: backticks become quotes. */
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\s+/g, " ").trim()}\``;
/** A table cell: no pipes or line breaks. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** report.md: ready for `gh issue create --body-file`. Pure. */
export function buildReportMarkdown(r: BugReportData): string {
  const out: string[] = [`# ${r.title.replace(/\s*\n\s*/g, " ")}`, ""];
  const span = `${formatTimecode(r.clip.start)}-${formatTimecode(r.clip.end)}`;
  out.push(
    `Recorded repro: ${r.clip.width}x${r.clip.height}, clip ${span} of a ${formatTimecode(r.clip.recordingDurationSec)} recording.`,
    "",
  );
  if (r.actual || r.expected) {
    if (r.actual) out.push("**Actual:** " + r.actual.trim(), "");
    if (r.expected) out.push("**Expected:** " + r.expected.trim(), "");
  }

  out.push("## Steps to reproduce", "");
  if (r.steps.length === 0) {
    out.push(`_${r.stepsNote ?? "No input events in the recording."} Add the steps by hand._`, "");
  } else {
    out.push("From the recording's input event log; times are on the recording's clock, positions in video pixels.", "");
    r.steps.forEach((s, i) => out.push(`${i + 1}. \`${formatTimecode(s.t)}\` ${s.text}`));
    if (r.stepsOmitted) out.push("", `_${r.stepsOmitted} more steps not shown (see report.json)._`);
    out.push("");
  }

  out.push("## Error text on screen", "");
  if (r.ocr !== "read") {
    out.push("_Not read: Windows OCR is unavailable here._", "");
  } else if (r.errors.length === 0) {
    out.push("_None found by OCR in the clip._", "");
  } else {
    out.push("Read by OCR (best-effort, may contain misreads); times from the clip start.", "");
    for (const e of r.errors) {
      const when = e.firstSeen === e.lastSeen ? formatTimecode(e.firstSeen) : `${formatTimecode(e.firstSeen)}-${formatTimecode(e.lastSeen)}`;
      out.push(`- \`${when}\` ${code(e.text)}`);
    }
    out.push("");
  }

  out.push("## Recording", "");
  if (r.files.gif) {
    out.push(
      "<!-- GitHub does not upload local files from --body-file: drag the GIF and clip into the issue, " +
        "or replace these links with the uploaded URLs. -->",
      `![Repro](${r.files.gif})`,
      "",
    );
  }
  out.push(`- Clip: [${r.files.clip}](${r.files.clip}) (${r3(r.clip.end - r.clip.start)} s)`);
  if (r.files.gif && r.gif) {
    const mb = (r.gif.sizeBytes / 1_000_000).toFixed(1);
    out.push(`- ${r.gif.format === "gif" ? "GIF" : "WebP"}: [${r.files.gif}](${r.files.gif}) (${mb} MB${r.gif.withinBudget ? "" : ", over the size budget"})`);
  }
  if (r.files.contactSheet) out.push(`- Contact sheet: [${r.files.contactSheet}](${r.files.contactSheet})`);
  out.push("");

  out.push("## Environment", "", "| | |", "|---|---|");
  for (const [k, v] of r.environment) out.push(`| ${cell(k)} | ${cell(v)} |`);
  out.push("");

  const red = r.redaction;
  const boxes = red.found + red.manual;
  out.push(
    "<sub>",
    red.scanned
      ? `Secret scan: OCR every ${red.everySec} s over ${red.framesScanned} frames; ${boxes} region${boxes === 1 ? "" : "s"} boxed out of the media. ` +
          "OCR is best-effort: review the clip before posting."
      : `Not scanned for secrets${red.manual > 0 ? ` (${red.manual} region${red.manual === 1 ? "" : "s"} boxed out by hand)` : ""}: review the clip before posting.`,
    `Generated by screencast-mcp bug_report, ${r.createdAt}.`,
    "</sub>",
    "",
  );
  return out.join("\n");
}
