/**
 * step_guide (#172): the pure half of turning a recording into a
 * step-by-step how-to, "Steps Recorder for the agent era". The tool
 * (src/tools/stepGuide.ts) grabs a frame per step, OCRs it, and draws the
 * click ring; this module picks the frame times, captions each step from the
 * OCR'd text under the click (secrets masked), groups steps under the
 * recording's markers, builds the ffmpeg filter for each screenshot, and
 * writes guide.md and the self-contained guide.html.
 *
 * Steps come from the input event log through the same builder bug_report
 * uses (steps.ts). The log never holds typed text, so neither does a guide.
 */
import type { Rect } from "./diff.js";
import type { Marker } from "./chapters.js";
import type { OcrLine } from "./ocr.js";
import type { InputStep, StepAction } from "./steps.js";
import { maskSecrets, DEFAULT_SECRET_PATTERN } from "./bugReport.js";
import { formatTimecode } from "./sheet.js";
import { ringSize, DEFAULT_RING_COLOR } from "./zoom.js";

/** Steps written to a guide at most; the rest are counted. */
export const MAX_GUIDE_STEPS = 100;
/** Each screenshot is the frame this long before its step, so it shows the
 * screen as it was when the user reached for the control. */
export const SHOT_LEAD_SEC = 0.1;
/** Screenshots wider than this are scaled down. */
export const SHOT_MAX_WIDTH = 1280;
/** OCR'd labels longer than this fall back to the word under the click. */
const LABEL_MAX = 40;
/** A line this close to the click (video px) can label it. */
const LABEL_REACH_PX = 24;

export const GUIDE_FILES = {
  markdown: "guide.md",
  html: "guide.html",
  images: "images",
  image: (n: number) => `step-${String(n).padStart(2, "0")}.png`,
} as const;

export type GuideFormat = "md" | "html" | "both";

export interface GuideStep {
  /** Step number; gaps are notes, not numbered (0). */
  n: number;
  /** Seconds on the recording's clock. */
  t: number;
  action: StepAction;
  /** The instruction without its target, e.g. "Click", "Press". */
  text: string;
  /** What the instruction acts on (OCR'd under the click, or the shortcut),
   * secrets masked. */
  label?: string;
  /** Click or scroll position in video pixels. */
  x?: number;
  y?: number;
  /** Seconds of the frame its screenshot shows. */
  shotT?: number;
  /** Image file name, relative to the guide folder. */
  image?: string;
  /** The marker heading this step falls under. */
  section?: string;
}

/** The step text and label as one plain line, e.g. "Click Save". */
export function caption(s: Pick<GuideStep, "text" | "label">): string {
  return s.label ? `${s.text} ${s.label}` : s.text;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** When a step's screenshot is taken: SHOT_LEAD_SEC before it, inside the
 * video (the last frame at the latest). Pure. */
export function shotTime(t: number, durationSec: number, fps: number): number {
  const last = Math.max(0, durationSec - 1 / (fps > 0 ? fps : 30));
  return r3(Math.min(Math.max(0, t - SHOT_LEAD_SEC), last));
}

function distance(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/**
 * The text that names what a click hit: the OCR line under (or within
 * LABEL_REACH_PX of) the point, the nearest and then smallest one; a long line
 * (a menu bar, a sentence) gives just the word under the click. Null when
 * nothing readable is there. Pure.
 */
export function labelAt(lines: OcrLine[], x: number, y: number): string | null {
  const near = lines
    .map((line) => ({ line, d: distance(line, x, y) }))
    .filter((c) => c.d <= LABEL_REACH_PX && c.line.text.trim().length > 0)
    .sort((a, b) => a.d - b.d || a.line.width * a.line.height - b.line.width * b.line.height);
  const best = near[0]?.line;
  if (!best) return null;
  let text = best.text.replace(/\s+/g, " ").trim();
  if (text.length > LABEL_MAX) {
    const word = [...best.words].sort((a, b) => distance(a, x, y) - distance(b, x, y))[0];
    text = word ? word.text.trim() : `${text.slice(0, LABEL_MAX - 1).trimEnd()}…`;
  }
  return text.length > 0 ? text : null;
}

function clickVerb(s: InputStep): string {
  const verb = s.action === "double_click" ? "double-click" : "click";
  const b = s.button && s.button !== "left" ? `${s.button.charAt(0).toUpperCase()}${s.button.slice(1)}-${verb}` : verb;
  return b.charAt(0).toUpperCase() + b.slice(1);
}

/**
 * Guide steps from the event-log steps: numbered, captioned, and given a
 * screenshot time (gaps are unnumbered notes without one). `labels` holds
 * the OCR'd label per input step index, when OCR ran; every label has
 * secrets masked with `secretPattern`. Pure.
 */
export function guideSteps(
  steps: InputStep[],
  opts: { durationSec: number; fps: number; labels?: Array<string | null>; secretPattern?: string },
): GuideStep[] {
  const pattern = opts.secretPattern ?? DEFAULT_SECRET_PATTERN;
  const mask = (s: string) => maskSecrets([s], pattern)[0] ?? s;
  let n = 0;
  return steps.map((s, i) => {
    if (s.action === "gap") return { n: 0, t: s.t, action: s.action, text: s.text };
    n++;
    const base: GuideStep = { n, t: s.t, action: s.action, text: s.text, shotT: shotTime(s.t, opts.durationSec, opts.fps) };
    const label = opts.labels?.[i];
    if (s.action === "click" || s.action === "double_click") {
      const verb = clickVerb(s);
      if (s.inFrame === false) return { ...base, text: `${verb} outside the recorded area` };
      return {
        ...base,
        x: s.x,
        y: s.y,
        ...(label ? { text: verb, label: mask(label) } : { text: `${verb} the marked spot` }),
      };
    }
    if (s.action === "scroll") {
      return { ...base, ...(s.inFrame === false ? {} : { x: s.x, y: s.y }), ...(label ? { text: `${s.text} over`, label: mask(label) } : {}) };
    }
    if (s.action === "shortcut") return s.keys ? { ...base, text: "Press", label: s.keys } : base;
    return { ...base, text: "Type text" }; // typing: the keys are never logged
  });
}

/** Give each step the marker heading it falls under: the latest marker at or
 * before it. Steps before the first marker get none. Pure. */
export function assignSections(steps: GuideStep[], markers: readonly Marker[]): GuideStep[] {
  const sorted = [...markers].sort((a, b) => a.t - b.t);
  return steps.map((s) => {
    const m = sorted.filter((k) => k.t <= s.t + 1e-6).at(-1);
    return m ? { ...s, section: m.label } : s;
  });
}

/**
 * The filter that turns one grabbed frame (`[0:v]`) into a step screenshot
 * at `[out]`: secret boxes filled black, a ring around the click (sized like
 * the zoom tool's click rings), and scaled down to SHOT_MAX_WIDTH. Pure.
 */
export function shotFilter(
  size: { width: number; height: number },
  opts: { click?: { x: number; y: number }; boxes?: Rect[]; color?: string },
): string {
  const n = (v: number) => String(Math.round(v));
  const chain: string[] = [];
  for (const b of opts.boxes ?? []) chain.push(`drawbox=x=${n(b.x)}:y=${n(b.y)}:w=${n(b.width)}:h=${n(b.height)}:color=black:t=fill`);
  const scale = `scale=w='min(iw,${SHOT_MAX_WIDTH})':h=-2:flags=lanczos`;
  const base = `[0:v]${chain.length ? chain.join(",") + "," : ""}format=rgba`;
  if (!opts.click) return `${base},${scale},format=rgb24[out]`;
  const D = ringSize(size.width, size.height);
  const c = D / 2;
  const th = Math.max(3, Math.round(D / 10));
  const r = c - th / 2 - 1;
  const color = opts.color ?? DEFAULT_RING_COLOR;
  return (
    `${base}[bg];` +
    `color=c=${color}:s=${D}x${D}:d=1,format=rgba,` +
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(abs(hypot(X-${c},Y-${c})-${r}),${th / 2}),255,0)'[ring];` +
    `[bg][ring]overlay=x=${n(opts.click.x - c)}:y=${n(opts.click.y - c)},${scale},format=rgb24[out]`
  );
}

/** ffmpeg args that grab the frame at `t` from `input` as a PNG. */
export function buildStepFrameArgs(input: string, t: number, output: string): string[] {
  return ["-y", "-v", "error", "-ss", String(t), "-i", input, "-frames:v", "1", output];
}

/** ffmpeg args that render a grabbed frame through shotFilter. */
export function buildStepShotArgs(frame: string, filter: string, output: string): string[] {
  return ["-y", "-v", "error", "-i", frame, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", output];
}

export interface GuideData {
  title: string;
  createdAt: string;
  recording: { durationSec: number; width: number; height: number };
  steps: GuideStep[];
  /** Steps not written (past MAX_GUIDE_STEPS). */
  stepsOmitted?: number;
  /** Why there are no steps, when there are none. */
  stepsNote?: string;
  /** read: OCR captioned and scanned the shots; off: not asked; unavailable. */
  ocr: "read" | "off" | "unavailable";
  /** Secret boxes drawn over the screenshots. */
  redactions: number;
}

/** Markdown inline text: no emphasis, code, link, or HTML characters. */
const md = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/([\\`*_[\]<>#|])/g, "\\$1");

function footer(g: GuideData): string {
  const scan =
    g.ocr === "read"
      ? `Screenshots scanned for secrets with OCR (best-effort); ${g.redactions} region${g.redactions === 1 ? "" : "s"} boxed out.`
      : "Screenshots were not scanned for secrets: review them before sharing.";
  return `${scan} Typed text is never logged, so it never appears here.`;
}

function intro(g: GuideData): string {
  const count = g.steps.filter((s) => s.n > 0).length;
  return `${count} step${count === 1 ? "" : "s"} from a ${formatTimecode(g.recording.durationSec)} recording.`;
}

/** guide.md: numbered steps under marker headings, each with its screenshot
 * from the images folder. Pure. */
export function buildGuideMarkdown(g: GuideData): string {
  const out: string[] = [`# ${md(g.title)}`, "", intro(g), ""];
  if (g.steps.length === 0) out.push(`_${g.stepsNote ?? "No steps in the recording."}_`, "");
  let section: string | undefined;
  for (const s of g.steps) {
    if (s.section !== undefined && s.section !== section) {
      section = s.section;
      out.push(`## ${md(section)}`, "");
    }
    if (s.n === 0) {
      out.push(`> _${md(s.text)}_`, "");
      continue;
    }
    const line = s.label ? `${md(s.text)} **${md(s.label)}**` : md(s.text);
    out.push(`${s.n}. ${line} <sub>${formatTimecode(s.t)}</sub>`, "");
    if (s.image) out.push(`   ![Step ${s.n}](${GUIDE_FILES.images}/${s.image})`, "");
  }
  if (g.stepsOmitted) out.push(`_${g.stepsOmitted} more steps not shown._`, "");
  out.push("<sub>", footer(g), `Generated by screencast-mcp step_guide, ${g.createdAt}.`, "</sub>", "");
  return out.join("\n");
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STYLE = `:root{--bg:#f6f5f2;--card:#fff;--ink:#16161a;--dim:#6b6b74;--line:#e2e0da;--rec:#e5383b}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1b1b1f;--ink:#ececf1;--dim:#9a9aa6;--line:#2c2c33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:40px 16px 64px}
header{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:28px}
.rec{font:600 12px/1 ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:.12em;color:var(--rec);text-transform:uppercase}
.rec::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--rec);margin-right:8px;vertical-align:1px}
h1{font-size:30px;line-height:1.2;margin:10px 0 6px}h2{font-size:20px;margin:40px 0 16px}
.meta{color:var(--dim);margin:0}ol{list-style:none;margin:0;padding:0}
li{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 18px;overflow:hidden}
.cap{display:flex;gap:14px;align-items:baseline;padding:14px 18px}
.n{flex:none;font:700 14px/1 ui-monospace,Consolas,monospace;color:var(--rec);min-width:2.2em}
.t{margin-left:auto;font:12px/1 ui-monospace,Consolas,monospace;color:var(--dim)}
li img{display:block;width:100%;height:auto;border-top:1px solid var(--line)}
.note{color:var(--dim);font-style:italic;margin:0 0 18px;padding-left:18px;border-left:3px solid var(--line)}
footer{color:var(--dim);font-size:13px;margin-top:40px;border-top:1px solid var(--line);padding-top:16px}`;

/** guide.html: one self-contained page; `imageSrc` maps an image file name to
 * its src (a data: URI, so the page needs nothing beside it). Pure. */
export function buildGuideHtml(g: GuideData, imageSrc: (file: string) => string): string {
  const body: string[] = [];
  let section: string | undefined;
  let open = false;
  const close = () => {
    if (open) body.push("</ol>");
    open = false;
  };
  for (const s of g.steps) {
    if (s.section !== undefined && s.section !== section) {
      close();
      section = s.section;
      body.push(`<h2>${html(section)}</h2>`);
    }
    if (s.n === 0) {
      close();
      body.push(`<p class="note">${html(s.text)}</p>`);
      continue;
    }
    if (!open) body.push("<ol>");
    open = true;
    const text = s.label ? `${html(s.text)} <strong>${html(s.label)}</strong>` : html(s.text);
    body.push(
      `<li><div class="cap"><span class="n">${String(s.n).padStart(2, "0")}</span><span>${text}</span>` +
        `<span class="t">${formatTimecode(s.t)}</span></div>` +
        (s.image ? `<img src="${html(imageSrc(s.image))}" alt="Step ${s.n}: ${html(caption(s))}" loading="lazy">` : "") +
        "</li>",
    );
  }
  close();
  if (g.steps.length === 0) body.push(`<p class="note">${html(g.stepsNote ?? "No steps in the recording.")}</p>`);
  if (g.stepsOmitted) body.push(`<p class="note">${g.stepsOmitted} more steps not shown.</p>`);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${html(g.title)}</title><style>${STYLE}</style></head><body><main>`,
    `<header><div class="rec">Step guide</div><h1>${html(g.title)}</h1><p class="meta">${html(intro(g))}</p></header>`,
    ...body,
    `<footer>${html(footer(g))}<br>Generated by screencast-mcp step_guide, ${html(g.createdAt)}.</footer>`,
    "</main></body></html>",
    "",
  ].join("\n");
}
