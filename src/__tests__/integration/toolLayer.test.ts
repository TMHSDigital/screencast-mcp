/**
 * Every non-capture tool through the MCP tool layer on tiny lavfi fixtures
 * (#261): each case calls the tool over an in-memory Client, checks the
 * result is not an error, validates structuredContent against the tool's
 * published outputSchema, and ffprobes every media file the result names.
 *
 * A guard test fails when a registered tool has neither a case here nor an
 * entry in SKIPPED with the reason it cannot run on a fixture (a live desktop
 * capture, typically) and where it is covered instead.
 *
 * Skipped without ffmpeg; REQUIRE_FFMPEG=1 (CI) makes that a failure through
 * the availability check in ffmpeg.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks } from "../../utils/ffmpeg.js";
import { formatEventsJsonl, type InputEvent } from "../../utils/events.js";
import { ocrStatus } from "../../utils/capabilities.js";
import { ttsStatus } from "../../utils/narrate.js";
import { MCP_APPS_EXTENSION, MCP_APP_MIME } from "../../utils/player.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);
const WIN = process.platform === "win32";
const OCR = AVAILABLE && WIN && (await ocrStatus()).available;
const TTS = AVAILABLE && WIN && (await ttsStatus()).available;
const WHISPER = !!process.env.SCREENCAST_WHISPER_MODEL;

/** Tools with no case here, why, and where they are covered instead. */
const SKIPPED: Record<string, string> = {
  start_recording: "live desktop capture: captureSmoke.test.ts (RUN_CAPTURE_SMOKE), argument errors in server.test.ts",
  stop_recording: "needs a live capture: captureSmoke.test.ts; a stopped record in server.test.ts",
  pause_recording: "needs a live capture: captureSmoke.test.ts",
  resume_recording: "needs a live capture: captureSmoke.test.ts",
  screenshot: "live desktop capture: captureSmoke.test.ts, target errors in server.test.ts",
  wait_for_change: "polls a live screen target: target errors in server.test.ts",
  list_targets: "enumerates live desktop windows: server.test.ts and targetList.test.ts with a faked desktop",
};

/** The tools #261 found were never called in a behavior test. */
const ISSUE_261 = [
  "save_replay", "list_sessions", "convert", "overlay", "compress", "extract_audio", "normalize_audio",
  "denoise", "list_audio_devices", "list_video_devices", "xfade_transition", "assemble_highlights",
  "title_card", "music_bed",
];

interface Fx {
  dir: string;
  av: string;
  av2: string;
  v: string;
  png: string;
  png2: string;
  wav: string;
  srt: string;
}

interface Case {
  name: string;
  args: (fx: Fx) => Record<string, unknown>;
  /** "media": the result must name at least one media file ffprobe can read.
   * "ok": a clean, schema-valid result. "error": a clean isError result. */
  expect: "media" | "ok" | "error";
  /** Why an "error" case cannot succeed on a fixture. */
  why?: string;
  /** Run only when this holds (a Windows engine, a whisper model). */
  when?: boolean;
  /** Off Windows, accept a clean isError (a Windows-only device API). */
  winOnly?: boolean;
}

/** Per-call request timeout, inside the describe's 300 s budget (#281). */
const CALL_OPTS = { timeout: 240_000, resetTimeoutOnProgress: true };

const SRT = "1\n00:00:00,200 --> 00:00:01,200\nHello there\n\n2\n00:00:01,500 --> 00:00:02,500\nSecond line\n";

const CASES: Case[] = [
  { name: "get_media_info", args: (f) => ({ input: f.av }), expect: "ok" },
  { name: "trim", args: (f) => ({ input: f.av, start: 0.5, end: 2 }), expect: "media" },
  { name: "concat", args: (f) => ({ inputs: [f.av, f.av2] }), expect: "media" },
  { name: "convert", args: (f) => ({ input: f.v, format: "gif", fps: 8, width: 160 }), expect: "media" },
  { name: "export_gif", args: (f) => ({ input: f.v, fps: 8, width: 160 }), expect: "media" },
  { name: "crop", args: (f) => ({ input: f.v, x: 0, y: 0, width: 160, height: 120 }), expect: "media" },
  { name: "scale", args: (f) => ({ input: f.v, width: 160 }), expect: "media" },
  { name: "speed", args: (f) => ({ input: f.av, factor: 2 }), expect: "media" },
  { name: "overlay", args: (f) => ({ input: f.av, overlay: f.png, x: 10, y: 10, width: 32 }), expect: "media" },
  { name: "callout", args: (f) => ({ input: f.v, items: [{ type: "box", x: 20, y: 20, width: 80, height: 60 }] }), expect: "media" },
  { name: "keystroke_overlay", args: (f) => ({ input: f.av }), expect: "media" },
  { name: "cursor", args: (f) => ({ input: f.av }), expect: "media" },
  { name: "backdrop", args: (f) => ({ input: f.v, padding: 20 }), expect: "media" },
  { name: "compress", args: (f) => ({ input: f.av, level: "heavy" }), expect: "media" },
  { name: "extract_audio", args: (f) => ({ input: f.av, format: "wav" }), expect: "media" },
  { name: "normalize_audio", args: (f) => ({ input: f.av }), expect: "media" },
  { name: "denoise", args: (f) => ({ input: f.av }), expect: "media" },
  { name: "burn_subtitles", args: (f) => ({ input: f.v, subtitles: f.srt }), expect: "media" },
  { name: "chapters", args: (f) => ({ input: f.av, chapters: [{ start: 0, title: "Intro" }, { start: 1.5, title: "Second" }] }), expect: "media" },
  { name: "clip", args: (f) => ({ input: f.av, segments: [{ start: 0, end: 1 }, { start: 1.5, end: 2.5 }] }), expect: "media" },
  { name: "cut_idle", args: (f) => ({ input: f.av, dryRun: true }), expect: "ok" },
  { name: "cut_by_transcript", args: (f) => ({ input: f.av, srt: f.srt, remove: [1] }), expect: "media" },
  { name: "redact_region", args: (f) => ({ input: f.v, regions: [{ x: 0, y: 0, width: 64, height: 48 }] }), expect: "media" },
  { name: "xfade_transition", args: (f) => ({ inputA: f.av, inputB: f.av2, duration: 0.5 }), expect: "media" },
  { name: "assemble_highlights", args: (f) => ({ clips: [f.av, f.av2], width: 320, height: 240, fps: 15 }), expect: "media" },
  { name: "title_card", args: (f) => ({ text: "Release notes", duration: 1, width: 320, height: 240, fps: 15, output: join(f.dir, "title.mp4") }), expect: "media" },
  { name: "music_bed", args: (f) => ({ video: f.av, music: f.wav }), expect: "media" },
  { name: "reframe", args: (f) => ({ input: f.v, aspect: "1:1" }), expect: "media" },
  {
    name: "zoom",
    args: (f) => ({ input: f.v, keyframes: [{ t: 0.5, x: 0, y: 0, width: 160, height: 120 }, { t: 1.5, full: true }] }),
    expect: "media",
  },
  { name: "pipeline", args: (f) => ({ input: f.av, steps: [{ op: "trim", start: 0, end: 2 }, { op: "scale", width: 160 }], quality: "draft" }), expect: "media" },
  { name: "export_preset", args: (f) => ({ input: f.v, platform: "square" }), expect: "media" },
  { name: "sample_frames", args: (f) => ({ input: f.av, timestamps: [0.5, 1.5], returnImages: false }), expect: "media" },
  { name: "contact_sheet", args: (f) => ({ input: f.av, count: 4, returnImage: false }), expect: "media" },
  { name: "screen_diff", args: (f) => ({ a: f.png, b: f.png2, returnImage: false }), expect: "ok" },
  { name: "review_recording", args: (f) => ({ input: f.av }), expect: "ok" },
  { name: "player_frames", args: (f) => ({ input: f.av, maxFrames: 4 }), expect: "ok" },
  { name: "read_events", args: (f) => ({ input: f.av }), expect: "ok" },
  { name: "add_marker", args: (f) => ({ input: f.av, label: "Second step", at: 1.5 }), expect: "ok" },
  { name: "index_recording", args: (f) => ({ input: f.av, maxFrames: 4 }), expect: "ok" },
  { name: "search_recording", args: (f) => ({ input: f.av, query: "Second step" }), expect: "ok" },
  { name: "bug_report", args: (f) => ({ input: f.av, clipSec: 2, redact: false, gif: false }), expect: "media" },
  { name: "step_guide", args: (f) => ({ input: f.av, ocr: false, format: "md" }), expect: "ok" },
  { name: "find_text", args: (f) => ({ input: f.png, returnImage: false }), expect: "ok", when: OCR },
  { name: "transcribe", args: (f) => ({ input: f.av }), expect: "ok", when: WHISPER },
  { name: "narrate", args: (f) => ({ video: f.av, lines: [{ t: 0.2, text: "Hello" }] }), expect: "media", when: TTS },
  { name: "list_sessions", args: () => ({}), expect: "ok" },
  { name: "get_session", args: () => ({ sessionId: "rec-table" }), expect: "ok" },
  {
    name: "save_replay",
    args: () => ({ sessionId: "rec-table" }),
    expect: "error",
    why: "a replay needs a live capture with replayBufferSec (captureSmoke/replay tests); a stopped session must be refused cleanly",
  },
  { name: "list_audio_devices", args: () => ({}), expect: "ok", winOnly: true },
  { name: "list_video_devices", args: () => ({}), expect: "ok", winOnly: true },
  { name: "doctor", args: () => ({}), expect: "ok" },
];

/** Output extensions ffprobe should be able to open. */
const MEDIA_EXT = new Set([".mp4", ".mkv", ".mov", ".webm", ".gif", ".webp", ".png", ".jpg", ".jpeg", ".mp3", ".wav", ".m4a", ".aac", ".opus"]);

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** The JSON Schema subset zod emits for the output schemas: type, required,
 * properties, items, enum, anyOf/oneOf. Returns the violations. */
function violations(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const alts = schema.anyOf ?? schema.oneOf;
  if (alts) {
    const each = alts.map((s) => violations(s, value, path));
    return each.some((v) => v.length === 0) ? [] : [`${path}: matches no alternative (${each.flat().slice(0, 3).join("; ")})`];
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) return [`${path}: ${JSON.stringify(value)} not in enum`];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${path}: expected ${types.join("|")}, got ${t}`];
  }
  const out: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) out.push(`${path}.${key}: required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) out.push(...violations(sub, obj[key], `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => out.push(...violations(schema.items!, v, `${path}[${i}]`)));
  return out;
}

/** Existing media files named anywhere in a result. */
function mediaPaths(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (isAbsolute(value) && MEDIA_EXT.has(extname(value).toLowerCase()) && existsSync(value) && statSync(value).isFile()) found.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) mediaPaths(v, found);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) mediaPaths(v, found);
  }
  return found;
}

/** ffprobe's streams of a file: at least one, with sane dimensions. */
function probeStreams(path: string): Array<{ codec_type: string; width?: number; height?: number }> {
  const res = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", path], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`ffprobe failed on ${path}: ${res.stderr}`);
  return (JSON.parse(res.stdout) as { streams?: Array<{ codec_type: string; width?: number; height?: number }> }).streams ?? [];
}

function ffmpeg(cwd: string, args: string[]): void {
  const res = spawnSync(FFMPEG, ["-y", "-v", "error", ...args], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`fixture ffmpeg failed: ${res.stderr}`);
}

describe("tool-layer case table (#261)", () => {
  it("has a case or a justified skip for every registered tool, and none for unknown tools", () => {
    const declared = (JSON.parse(readFileSync(join(process.cwd(), "mcp-tools.json"), "utf8")) as Array<{ name: string }>).map((t) => t.name);
    const cased = CASES.map((c) => c.name);
    expect(new Set(cased).size, "duplicate cases").toBe(cased.length);
    expect(declared.filter((n) => !cased.includes(n) && !(n in SKIPPED)), "tools with no case and no SKIPPED entry").toEqual([]);
    expect([...cased, ...Object.keys(SKIPPED)].filter((n) => !declared.includes(n)), "cases for tools that are not registered").toEqual([]);
    expect(cased.filter((n) => n in SKIPPED), "tools both cased and skipped").toEqual([]);
    for (const [name, reason] of Object.entries(SKIPPED)) expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    for (const c of CASES) if (c.expect === "error") expect(c.why, `${c.name} expects an error without saying why`).toBeTruthy();
    expect(ISSUE_261.filter((n) => !cased.includes(n))).toEqual([]);
  });

  it("its schema check catches a wrong type, a missing field, and a bad item", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["outputPath"],
      properties: { outputPath: { type: "string" }, frames: { type: "array", items: { type: "number" } } },
    };
    expect(violations(schema, { outputPath: "/x.mp4", frames: [1, 2.5] })).toEqual([]);
    expect(violations(schema, { frames: [] })).toEqual(["$.outputPath: required"]);
    expect(violations(schema, { outputPath: 1 })).toEqual(["$.outputPath: expected string, got integer"]);
    expect(violations(schema, { outputPath: "a", frames: ["x"] })).toEqual(["$.frames[0]: expected number, got string"]);
  });
});

describe.skipIf(!AVAILABLE)("every non-capture tool through the MCP client (#261)", { timeout: 300_000 }, () => {
  let home = "";
  let fx: Fx;
  let client: Client;
  const schemas = new Map<string, JsonSchema | undefined>();

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "sc-tool-layer-"));
    process.env.SCREENCAST_HOME = home;
    const dir = join(home, "fixtures");
    mkdirSync(dir, { recursive: true });
    const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
    ffmpeg(dir, [
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
      ...x264, "-c:a", "aac", "-shortest", "av.mp4",
    ]);
    ffmpeg(dir, [
      "-f", "lavfi", "-i", "smptebars=size=320x240:rate=15:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=3:sample_rate=48000",
      ...x264, "-c:a", "aac", "-shortest", "av2.mp4",
    ]);
    ffmpeg(dir, ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=2", ...x264, "v.mp4"]);
    ffmpeg(dir, ["-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", "logo.png"]);
    ffmpeg(dir, ["-f", "lavfi", "-i", "color=c=blue:size=64x64", "-frames:v", "1", "logo2.png"]);
    ffmpeg(dir, ["-f", "lavfi", "-i", "sine=frequency=220:duration=4:sample_rate=48000", "music.wav"]);
    writeFileSync(join(dir, "subs.srt"), SRT);
    const events: InputEvent[] = [
      { t: 0.3, type: "move", x: 40, y: 40, inFrame: true },
      { t: 0.8, type: "down", x: 120, y: 80, inFrame: true, button: "left" },
      { t: 0.9, type: "up", x: 120, y: 80, inFrame: true, button: "left" },
      { t: 1.4, type: "key", x: 120, y: 80, inFrame: true, keys: "Ctrl+S" },
      { t: 2.2, type: "down", x: 200, y: 160, inFrame: true, button: "left" },
    ];
    writeFileSync(join(dir, "av.events.jsonl"), formatEventsJsonl(events));
    fx = {
      dir,
      av: join(dir, "av.mp4"),
      av2: join(dir, "av2.mp4"),
      v: join(dir, "v.mp4"),
      png: join(dir, "logo.png"),
      png2: join(dir, "logo2.png"),
      wav: join(dir, "music.wav"),
      srt: join(dir, "subs.srt"),
    };

    const { createServer } = await import("../../server.js");
    const { getStore } = await import("../../context.js");
    getStore().create({
      id: "rec-table",
      target: "full",
      outputPath: fx.av,
      fps: 15,
      quality: "standard",
      pid: null,
      status: "stopped",
      startedAt: new Date().toISOString(),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    // An MCP Apps client, so the app-only player_frames is listed too.
    client = new Client(
      { name: "tool-layer", version: "0.0.0" },
      { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } } },
    );
    await client.connect(clientSide);
    // Listing also primes the client's own outputSchema validation of callTool.
    for (let i = 0; i < 50 && !schemas.has("player_frames"); i++) {
      for (const t of (await client.listTools()).tools) schemas.set(t.name, t.outputSchema as JsonSchema | undefined);
      if (!schemas.has("player_frames")) await new Promise((r) => setTimeout(r, 20));
    }
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // A case whose engine this machine lacks (Windows OCR or speech, a whisper
  // model) is reported as skipped, not passed.
  for (const c of CASES) it.skipIf(c.when === false)(c.name, async () => {
    const name = c.name;
    // The client's default 60 s request timeout is shorter than a slow
    // Windows runner with coverage needs for some edits (#281).
    const res = await client.callTool({ name, arguments: c.args(fx) }, undefined, CALL_OPTS);
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (c.expect === "error" || (c.winOnly && !WIN && res.isError)) {
      expect(res.isError, text).toBe(true);
      expect(text.length).toBeGreaterThan(0);
      expect(res.structuredContent).toBeUndefined();
      return;
    }
    expect(res.isError ?? false, text).toBe(false);

    expect(schemas.has(name), `${name} is listed to an MCP Apps client`).toBe(true);
    const schema = schemas.get(name);
    if (schema) {
      expect(res.structuredContent, "a tool with an outputSchema returns structuredContent").toBeDefined();
      expect(violations(schema, res.structuredContent)).toEqual([]);
    }

    if (c.expect === "media") {
      const files = [...mediaPaths(res.structuredContent ?? JSON.parse(text))].filter((p) => !Object.values(fx).includes(p));
      expect(files.length, `no output media named in ${text.slice(0, 300)}`).toBeGreaterThan(0);
      for (const file of files.slice(0, 6)) {
        const streams = probeStreams(file);
        expect(streams.length, file).toBeGreaterThan(0);
        for (const s of streams.filter((x) => x.codec_type === "video")) {
          expect(s.width, file).toBeGreaterThan(0);
          expect(s.height, file).toBeGreaterThan(0);
        }
      }
    }
  });

  it("sample_frames fps mode keeps both runs' frames in a reused outputDir (#283)", async () => {
    const outputDir = join(home, "reused-frames");
    const run = async () => {
      const res = await client.callTool({ name: "sample_frames", arguments: { input: fx.av, fps: 1, outputDir, returnImages: false } }, undefined, CALL_OPTS);
      expect(res.isError ?? false).toBe(false);
      return res.structuredContent as { frameCount: number; frames: string[] };
    };
    const first = await run();
    expect(first.frameCount).toBeGreaterThan(0);
    const firstBytes = first.frames.map((f) => readFileSync(f));
    const second = await run();
    expect(second.frameCount).toBe(first.frameCount);
    expect(second.frames.filter((f) => first.frames.includes(f))).toEqual([]);
    // The first run's frames are still there, unchanged.
    first.frames.forEach((f, i) => expect(readFileSync(f).equals(firstBytes[i]!)).toBe(true));
  });
});
