/**
 * Eval tasks (#223): what a user asks for, the tool(s) a good agent picks, the
 * calls an oracle makes, and checks on what comes out. Prompts say what the
 * user wants, never which tool to use.
 */
import { lastOk, outputOf, type CheckResult, type EvalContext, type EvalTask, type ToolCallRecord } from "./harness.js";
import { BUTTON_RECT, SECRET_RECT, fileSize, maxLuma, meanLuma, probe, regionPixels } from "./fixtures.js";

function check(name: string, pass: boolean, detail?: string): CheckResult {
  return detail === undefined ? { name, pass } : { name, pass, detail };
}

/** Probe the output of the last good call to `tools`, or a failed check. */
function outputProbe(ctx: EvalContext, calls: ToolCallRecord[], tools: string[]) {
  const path = outputOf(calls, tools);
  if (path === undefined) return { path, info: undefined, fail: check("produced an output", false, `no ${tools.join("/")} output`) };
  try {
    return { path, info: probe(path, ctx.ffprobe), fail: undefined };
  } catch (err) {
    return { path, info: undefined, fail: check("output is readable media", false, err instanceof Error ? err.message : String(err)) };
  }
}

function near(name: string, actual: number | null | undefined, expected: number, tol: number): CheckResult {
  const ok = typeof actual === "number" && Math.abs(actual - expected) <= tol;
  return check(name, ok, `got ${actual ?? "none"}, want ${expected}±${tol}`);
}

/** In model mode the answer must mention every needle; oracle mode has no answer. */
function answerMentions(answer: string | null, needles: RegExp[]): CheckResult[] {
  if (answer === null) return [];
  return needles.map((n) => check(`answer mentions ${n.source}`, n.test(answer)));
}

export const TASKS: EvalTask[] = [
  {
    id: "repro-gif-under-2mb",
    prompt: (c) => `Make a repro GIF from ${c.fixtures.demo} that I can paste into a GitHub issue. It has to stay under 2 MB.`,
    expectTools: ["export_gif"],
    oracle: (c) => [{ name: "export_gif", args: { input: c.fixtures.demo, maxBytes: 2_000_000 } }],
    check: (c, calls) => {
      const o = outputProbe(c, calls, ["export_gif"]);
      if (o.fail || !o.path || !o.info) return [o.fail ?? check("output", false)];
      return [
        check("is a GIF", o.info.format.includes("gif"), o.info.format),
        check("under 2 MB", fileSize(o.path) <= 2_000_000, `${fileSize(o.path)} bytes`),
      ];
    },
  },
  {
    id: "cut-dead-air",
    prompt: (c) => `${c.fixtures.idle} has a long stretch in the middle where nothing happens. Cut the dead air out.`,
    expectTools: ["cut_idle"],
    oracle: (c) => [{ name: "cut_idle", args: { input: c.fixtures.idle } }],
    check: (c, calls) => {
      const o = outputProbe(c, calls, ["cut_idle"]);
      if (o.fail || !o.info) return [o.fail ?? check("output", false)];
      const d = o.info.durationSec ?? 99;
      return [check("at least 2 s shorter than the 8 s input", d <= 6, `${d.toFixed(2)} s`), check("keeps audio", o.info.hasAudio)];
    },
  },
  {
    id: "redact-api-key",
    prompt: (c) => {
      const r = SECRET_RECT;
      return (
        `An API key shows up in ${c.fixtures.secret} from 0:03 onward, inside the box at x=${r.x}, y=${r.y}, ` +
        `${r.width}x${r.height} px. Make a copy where it can't be read or recovered.`
      );
    },
    expectTools: ["redact_region"],
    oracle: (c) => [{ name: "redact_region", args: { input: c.fixtures.secret, regions: [{ ...SECRET_RECT }] } }],
    check: (c, calls) => {
      const o = outputProbe(c, calls, ["redact_region"]);
      if (o.fail || !o.path || !o.info) return [o.fail ?? check("output", false)];
      const inside = maxLuma(regionPixels(o.path, 4.5, SECRET_RECT, c.ffmpeg));
      const outside = meanLuma(regionPixels(o.path, 4.5, { x: 0, y: 0, width: 320, height: 60 }, c.ffmpeg));
      return [
        // The key is drawn white (255) on 128 gray: any surviving stroke is bright.
        check("no bright text left in the key's box", inside >= 0 && inside < 150, `max luma ${inside}`),
        check("rest of the frame untouched", Math.abs(outside - 128) < 12, `mean luma ${outside.toFixed(0)}`),
        near("duration kept", o.info.durationSec, 6, 0.25),
      ];
    },
  },
  {
    id: "verify-button-green",
    prompt: (c) =>
      `${c.fixtures.before} is the settings screen before I clicked Save and ${c.fixtures.after} is after. ` +
      `Did the button change (it should have turned green)? Tell me where on screen the change is.`,
    expectTools: ["screen_diff"],
    oracle: (c) => [{ name: "screen_diff", args: { a: c.fixtures.before, b: c.fixtures.after } }],
    check: (_c, calls, answer) => {
      const d = lastOk(calls, ["screen_diff"])?.data;
      if (!d) return [check("screen_diff result", false, "no successful screen_diff")];
      const regions = Array.isArray(d.regions) ? (d.regions as Array<Record<string, unknown>>) : [];
      const b = BUTTON_RECT;
      const hit = regions.some((r) => {
        const x = Number(r.x), y = Number(r.y), w = Number(r.width ?? r.w), h = Number(r.height ?? r.h);
        return x < b.x + b.width && x + w > b.x && y < b.y + b.height && y + h > b.y;
      });
      return [
        check("reports a change", d.identical === false),
        check("a changed region overlaps the button", hit, JSON.stringify(regions).slice(0, 120)),
        ...answerMentions(answer, [/green|chang/i]),
      ];
    },
  },
  {
    id: "keep-first-3s",
    prompt: (c) => `Keep only the first 3 seconds of ${c.fixtures.demo}.`,
    expectTools: ["trim", "clip"],
    oracle: (c) => [{ name: "trim", args: { input: c.fixtures.demo, start: 0, end: 3 } }],
    check: (c, calls) => {
      const o = outputProbe(c, calls, ["trim"]);
      const clip = lastOk(calls, ["clip"])?.data?.outputs;
      const path = o.path ?? (Array.isArray(clip) && typeof clip[0] === "string" ? clip[0] : undefined);
      if (path === undefined) return [o.fail ?? check("output", false)];
      return [near("3 s long", probe(path, c.ffprobe).durationSec, 3, 0.2)];
    },
  },
  {
    id: "media-info",
    prompt: (c) => `How long is ${c.fixtures.demo}, and what resolution is it?`,
    expectTools: ["get_media_info"],
    forbidTools: ["sample_frames", "contact_sheet"],
    oracle: (c) => [{ name: "get_media_info", args: { input: c.fixtures.demo } }],
    check: (_c, calls, answer) => {
      const d = lastOk(calls, ["get_media_info"])?.data;
      return [
        check("probed 320x240", d?.width === 320 && d?.height === 240, `${String(d?.width)}x${String(d?.height)}`),
        ...answerMentions(answer, [/\b6(\.0+)?\s*(s|sec)/i, /320\s*[x×]\s*240/i]),
      ];
    },
  },
  {
    id: "overview-image",
    prompt: (c) => `Give me a single image that shows what happens over the course of ${c.fixtures.demo}.`,
    expectTools: ["contact_sheet"],
    oracle: (c) => [{ name: "contact_sheet", args: { input: c.fixtures.demo } }],
    check: (c, calls) => {
      const o = outputProbe(c, calls, ["contact_sheet"]);
      if (o.fail || !o.info) return [o.fail ?? check("output", false)];
      return [check("is one image wider than a frame", (o.info.width ?? 0) > 320, `${String(o.info.width)} px wide`)];
    },
  },
  {
    id: "pull-audio",
    prompt: (c) => `I only need the sound from ${c.fixtures.demo}. Save it as an mp3.`,
    expectTools: ["extract_audio"],
    oracle: (c) => [{ name: "extract_audio", args: { input: c.fixtures.demo, format: "mp3" } }],
    check: (c, calls) => {
      const o = outputProbe(c, calls, ["extract_audio"]);
      if (o.fail || !o.path || !o.info) return [o.fail ?? check("output", false)];
      return [
        check("audio only", o.info.hasAudio && !o.info.hasVideo),
        check("mp3", o.path.toLowerCase().endsWith(".mp3"), o.path),
      ];
    },
  },
  {
    id: "two-highlights",
    prompt: (c) => `From ${c.fixtures.demo}, save 1-2 s and 4-5 s as two separate clips.`,
    expectTools: ["clip"],
    oracle: (c) => [{ name: "clip", args: { input: c.fixtures.demo, segments: [{ start: 1, end: 2 }, { start: 4, end: 5 }] } }],
    check: (c, calls) => {
      const outs = lastOk(calls, ["clip"])?.data?.outputs;
      const paths = Array.isArray(outs) ? outs.filter((p): p is string => typeof p === "string") : [];
      return [
        check("two files", paths.length === 2, `${paths.length}`),
        ...paths.map((p, i) => near(`clip ${i + 1} is 1 s`, probe(p, c.ffprobe).durationSec, 1, 0.15)),
      ];
    },
  },
  {
    id: "double-speed",
    prompt: (c) => `Play ${c.fixtures.demo} back twice as fast.`,
    expectTools: ["speed"],
    oracle: (c) => [{ name: "speed", args: { input: c.fixtures.demo, factor: 2 } }],
    check: (c, calls) => {
      const o = outputProbe(c, calls, ["speed"]);
      if (o.fail || !o.info) return [o.fail ?? check("output", false)];
      return [near("half the length", o.info.durationSec, 3, 0.2)];
    },
  },
];
