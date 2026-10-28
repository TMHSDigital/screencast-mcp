import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { defined } from "./testUtils.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { InputEvent } from "../utils/events.js";
import type { OcrLine } from "../utils/ocr.js";
import { buildSampleByFpsArgs } from "../utils/media.js";
import { sampleWindow, scanMatches } from "../utils/ocrScan.js";
import {
  DEFAULT_ERROR_PATTERN,
  DEFAULT_SECRET_PATTERN,
  MASK,
  buildReportMarkdown,
  clipWindow,
  errorFindings,
  maskSecrets,
  mergeRedactions,
  reconstructSteps,
  type BugReportData,
} from "../utils/bugReport.js";

const ev = (t: number, type: InputEvent["type"], extra: Partial<InputEvent> = {}): InputEvent => ({
  t,
  type,
  x: 100,
  y: 50,
  inFrame: true,
  ...extra,
});

/** One OCR line of space-separated words, 10 px per character. */
function line(text: string, y = 0, x = 0): OcrLine {
  let at = x;
  const words = text.split(" ").map((w) => {
    const word = { text: w, x: at, y, width: w.length * 10, height: 12 };
    at += w.length * 10 + 10;
    return word;
  });
  return { text, words, x, y, width: at - 10 - x, height: 12 };
}

describe("clipWindow (#198)", () => {
  it("keeps the last 30 s by default, or the whole recording when shorter", () => {
    expect(clipWindow(100)).toEqual({ start: 70, end: 100 });
    expect(clipWindow(12)).toEqual({ start: 0, end: 12 });
  });
  it("honours start/end and clipSec, capping end at the duration", () => {
    expect(clipWindow(100, { start: 10, end: 20 })).toEqual({ start: 10, end: 20 });
    expect(clipWindow(100, { end: 50, clipSec: 5 })).toEqual({ start: 45, end: 50 });
    expect(clipWindow(100, { start: 90, end: 500 })).toEqual({ start: 90, end: 100 });
  });
  it("rejects an empty, inverted, or too-long window", () => {
    expect(() => clipWindow(10, { start: 12 })).toThrow(/past the end/);
    expect(() => clipWindow(10, { start: 5, end: 4 })).toThrow(/after start/);
    expect(() => clipWindow(4000, { start: 0 })).toThrow(/at most/);
    expect(() => clipWindow(0)).toThrow(/duration/);
  });
});

describe("reconstructSteps (#198)", () => {
  it("turns clicks, shortcuts, typing, and gaps into steps, skipping moves and releases", () => {
    const steps = reconstructSteps([
      ev(0.2, "move"),
      ev(1, "down", { button: "left" }),
      ev(1.1, "up", { button: "left" }),
      ev(2, "key", { keys: "Ctrl+S" }),
      ev(3, "typing", { durationSec: 1.5 }),
      ev(4, "down", { button: "right", inFrame: false, x: -5 }),
      ev(5, "gap", { durationSec: 2, reason: "input_not_seen" }),
    ]);
    expect(steps.map((s) => s.text)).toEqual([
      "Click at (100, 50)",
      "Press Ctrl+S",
      "Type for 1.5 s (keys are not logged)",
      "Right click outside the recorded area",
      expect.stringMatching(/^Input may be missing for 2 s/),
    ]);
    expect(steps.map((s) => s.t)).toEqual([1, 2, 3, 4, 5]);
  });

  it("folds a double-click and joins a scroll into one step", () => {
    const steps = reconstructSteps([
      ev(1, "down", { button: "left" }),
      ev(1.2, "down", { button: "left", x: 102 }),
      ev(3, "wheel", { delta: -1, axis: "vertical" }),
      ev(3.3, "wheel", { delta: -2, axis: "vertical" }),
      ev(6, "wheel", { delta: 1, axis: "vertical" }),
    ]);
    expect(steps.map((s) => [s.action, s.text])).toEqual([
      ["double_click", "Double-click at (100, 50)"],
      ["scroll", "Scroll down 3 notches"],
      ["scroll", "Scroll up 1 notch"],
    ]);
  });

  it("does not fold presses far apart in time or place", () => {
    const steps = reconstructSteps([ev(1, "down", { button: "left" }), ev(2, "down", { button: "left" }), ev(2.1, "down", { button: "left", x: 300 })]);
    expect(steps.map((s) => s.action)).toEqual(["click", "click", "click"]);
  });
});

describe("secret scan helpers (#198)", () => {
  it("the default secret pattern catches common tokens and labelled values, not plain prose", () => {
    const texts = [
      "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "key sk-proj-abcdefghij1234567890",
      "Password: hunter22",
      "AKIAABCDEFGHIJKLMNOP",
      "Click Save to continue",
    ];
    const masked = maskSecrets(texts, DEFAULT_SECRET_PATTERN);
    expect(masked.slice(0, 4).every((t) => t.includes(MASK))).toBe(true);
    expect(masked[0]).not.toContain("ghp_abc");
    expect(masked[1]).toBe(`key ${MASK}`);
    expect(masked[4]).toBe("Click Save to continue");
  });

  it("masks overlapping ranges once", () => {
    expect(maskSecrets(["a token=ghp_abcdefghijklmnop b"], DEFAULT_SECRET_PATTERN)).toEqual([`a ${MASK} b`]);
  });

  it("rejects an invalid regex", () => {
    expect(() => maskSecrets(["x"], "(")).toThrow(/Invalid regex/);
  });

  it("boxes the whole matching line, timed from the previous sample to the next", () => {
    const frames = [
      { t: 0, width: 400, height: 300, path: "a.png", lines: [line("hello")] },
      { t: 1, width: 400, height: 300, path: "b.png", lines: [line("token = abc123", 40, 20), line("ok", 80)] },
    ];
    const byLine = scanMatches({ frames, step: 1, end: 2 }, DEFAULT_SECRET_PATTERN, true, "line");
    expect(byLine.matches).toHaveLength(1);
    expect(byLine.redactRegions).toEqual([{ x: 16, y: 36, width: 148, height: 20, start: 0, end: 2 }]);
    const byMatch = scanMatches({ frames, step: 1, end: 2 }, "abc", false);
    expect(defined(byMatch.redactRegions[0]).x).toBeGreaterThan(16);
    expect(sampleWindow(5, 2, 6)).toEqual({ start: 3, end: 6 });
  });

  it("merges a box that stays on screen across samples, keeping separate ones apart", () => {
    const merged = mergeRedactions([
      { x: 10, y: 10, width: 100, height: 20, start: 0, end: 2 },
      { x: 12, y: 10, width: 100, height: 20, start: 1, end: 3 },
      { x: 10, y: 200, width: 100, height: 20, start: 1, end: 3 },
      { x: 10, y: 10, width: 100, height: 20, start: 10, end: 12 },
    ]);
    expect(merged).toEqual([
      { x: 10, y: 10, width: 102, height: 20, start: 0, end: 3 },
      { x: 10, y: 200, width: 100, height: 20, start: 1, end: 3 },
      { x: 10, y: 10, width: 100, height: 20, start: 10, end: 12 },
    ]);
  });

  it("finds error lines once each, still-visible ones first, with secrets masked", () => {
    const found = errorFindings(
      [
        { t: 0, lines: [line("Request failed: token=ghp_abcdefghijklmnop"), line("Welcome")] },
        { t: 1, lines: [line("Request failed: token=ghp_abcdefghijklmnop")] },
        { t: 2, lines: [line("Error: disk full")] },
      ],
      DEFAULT_ERROR_PATTERN,
      DEFAULT_SECRET_PATTERN,
    );
    expect(found).toEqual([
      { text: "Error: disk full", firstSeen: 2, lastSeen: 2 },
      { text: `Request failed: ${MASK}`, firstSeen: 0, lastSeen: 1 },
    ]);
  });
});

describe("buildSampleByFpsArgs range (#198)", () => {
  it("seeks the input to the range", () => {
    const args = buildSampleByFpsArgs("in.mp4", 1, "out_%05d.png", 30, false, { start: 5, duration: 10 });
    expect(args.slice(0, 7)).toEqual(["-y", "-ss", "5", "-t", "10", "-i", "in.mp4"]);
    expect(buildSampleByFpsArgs("in.mp4", 1, "o_%05d.png").slice(0, 3)).toEqual(["-y", "-i", "in.mp4"]);
  });
});

describe("buildReportMarkdown (#198)", () => {
  const base: BugReportData = {
    title: "Save | fails",
    actual: "Nothing happens",
    expected: "The file saves",
    createdAt: "2026-10-27T00:00:00.000Z",
    clip: { start: 70, end: 100, recordingDurationSec: 100, width: 1280, height: 720 },
    files: { clip: "clip.mp4", gif: "repro.gif", contactSheet: "contact-sheet.png" },
    gif: { format: "gif", sizeBytes: 2_500_000, withinBudget: true },
    steps: [{ t: 72.5, action: "click", text: "Click at (10, 20)" }],
    errors: [{ text: "Error: `x` failed", firstSeen: 28, lastSeen: 30 }],
    ocr: "read",
    redaction: { scanned: true, everySec: 1, framesScanned: 30, found: 2, manual: 0 },
    environment: [["OS", "Windows 11 | Pro"], ["ffmpeg", "8.0"]],
  };

  it("writes every section, with relative attachment links and escaped cells", () => {
    const md = buildReportMarkdown(base);
    expect(md.startsWith("# Save | fails\n")).toBe(true);
    expect(md).toContain("**Actual:** Nothing happens");
    expect(md).toContain("**Expected:** The file saves");
    expect(md).toContain("1. `1:12.5` Click at (10, 20)");
    expect(md).toContain("`0:28.0-0:30.0` `Error: 'x' failed`");
    expect(md).toContain("![Repro](repro.gif)");
    expect(md).toContain("[clip.mp4](clip.mp4) (30 s)");
    expect(md).toContain("(2.5 MB)");
    expect(md).toContain("| OS | Windows 11 \\| Pro |");
    expect(md).toContain("2 regions boxed out");
  });

  it("says why steps, errors, or the scan are missing", () => {
    const md = buildReportMarkdown({
      ...base,
      files: { clip: "clip.mp4" },
      steps: [],
      stepsNote: "The recording has no input event log.",
      errors: [],
      ocr: "unavailable",
      redaction: { scanned: false, found: 0, manual: 1 },
    });
    expect(md).toContain("_The recording has no input event log. Add the steps by hand._");
    expect(md).toContain("Windows OCR is unavailable");
    expect(md).toContain("Not scanned for secrets (1 region boxed out by hand)");
    expect(md).not.toContain("![Repro]");
  });
});

// The tool layer: argument and setup errors come back before any ffmpeg work.
vi.mock("../utils/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg-not-called", ffprobe: "ffprobe-not-called" }),
}));

describe("bug_report tool errors (#198)", () => {
  const home = mkdtempSync(join(tmpdir(), "sc-bug-"));
  let client: Client;
  beforeAll(async () => {
    process.env.SCREENCAST_HOME = home;
    const { createServer } = await import("../server.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    client = new Client({ name: "bug-test", version: "0" });
    await client.connect(b);
  });
  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "bug_report", arguments: args });
    return { isError: res.isError === true, text: (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n") };
  };

  it("needs exactly one of input and sessionId", async () => {
    expect((await call({})).text).toMatch(/exactly one/);
    expect((await call({ input: "a.mp4", sessionId: "rec-1" })).text).toMatch(/exactly one/);
  });

  it("reports a missing file or session", async () => {
    expect((await call({ input: join(home, "missing.mp4") })).text).toMatch(/not found/);
    expect((await call({ sessionId: "rec-nope" })).text).toMatch(/No session/);
  });

  it("refuses a recording that is still running", async () => {
    const { getStore } = await import("../context.js");
    const out = join(home, "live.mp4");
    writeFileSync(out, "");
    getStore().create({ id: "rec-live", target: "full", outputPath: out, fps: 30, quality: "standard", pid: process.pid, status: "recording", startedAt: new Date().toISOString() });
    expect((await call({ sessionId: "rec-live" })).text).toMatch(/still running/);
  });
});
