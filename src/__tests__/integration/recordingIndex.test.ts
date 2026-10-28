/**
 * index_recording + search_recording (#245) end to end through the MCP tool
 * layer, on a lavfi fixture with real ffmpeg: markers, events, and an .srt
 * sidecar are indexed and found with their times; the cache is reused; the
 * index falls back under SCREENCAST_HOME when the video's folder is outside the
 * allowed dirs. The screen-text cases need Windows OCR and skip without it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks } from "../../utils/ffmpeg.js";
import { bundledFontPath } from "../../utils/fonts.js";
import { ocrStatus } from "../../utils/capabilities.js";
import { formatEventsJsonl, type InputEvent } from "../../utils/events.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(process.env.FFPROBE_PATH || "ffprobe");
const OCR = AVAILABLE && process.platform === "win32" && (await ocrStatus()).available;

const SECRET = "ghp_Abc123Def456Ghi789Jkl012";

describe.skipIf(!AVAILABLE)("index_recording + search_recording against real ffmpeg (#245)", { timeout: 300_000 }, () => {
  let dir = "";
  let home = "";
  let video = "";
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "screencast-index-it-"));
    home = mkdtempSync(join(tmpdir(), "screencast-index-home-"));
    process.env.SCREENCAST_HOME = home;
    // 30 s: a title throughout, a secret from 5 s to 9 s, and an error dialog
    // from 21 s (after a 10 s fill keyframe at 20 s, so finding it at 21 s
    // needs the scene cut, not the fill grid).
    copyFileSync(bundledFontPath("bold"), join(dir, "font.ttf"));
    writeFileSync(join(dir, "title.txt"), "Settings Panel");
    writeFileSync(join(dir, "secret.txt"), `TOKEN ${SECRET}`);
    writeFileSync(join(dir, "error.txt"), "Save failed");
    const text = (file: string, y: number, size: number, enable = "") =>
      `drawtext=fontfile=font.ttf:textfile=${file}:fontsize=${size}:fontcolor=white:x=40:y=${y}${enable}`;
    const res = spawnSync(
      FFMPEG,
      [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=c=0x202020:size=640x360:rate=10:duration=30",
        "-vf",
        [
          text("title.txt", 30, 32),
          `drawbox=x=20:y=150:w=600:h=120:color=0x3050a0:t=fill:enable='gte(t,21)'`,
          text("secret.txt", 100, 24, ":enable='between(t,5,9)'"),
          text("error.txt", 190, 44, ":enable='gte(t,21)'"),
        ].join(","),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "rec.mp4",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(res.status, res.stderr).toBe(0);
    video = join(dir, "rec.mp4");
    const events: InputEvent[] = [
      { t: 3, type: "down", x: 120, y: 80, inFrame: true, button: "left" },
      { t: 20.5, type: "key", x: 0, y: 0, inFrame: true, keys: "Ctrl+S" },
    ];
    writeFileSync(join(dir, "rec.events.jsonl"), formatEventsJsonl(events));
    writeFileSync(join(dir, "rec.markers.json"), JSON.stringify({ markers: [{ t: 14, label: "Opened preferences" }] }));
    writeFileSync(join(dir, "rec.srt"), "1\n00:00:17,500 --> 00:00:19,000\nnow I click save\n");

    const { createServer } = await import("../../server.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    client = new Client({ name: "index-it", version: "0" });
    await client.connect(b);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.SCREENCAST_ALLOWED_DIRS;
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    return {
      isError: res.isError === true,
      text,
      images: (res.content as Array<{ type: string }>).filter((c) => c.type === "image").length,
      data: res.structuredContent as Record<string, unknown> | undefined,
    };
  }

  type Hit = { start: number; end: number; t: number; matches: Array<{ source: string; text: string }> };

  it("asks for an index before searching", async () => {
    const res = await call("search_recording", { input: video, query: "anything" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/index_recording/);
  });

  it("indexes next to the video and finds markers, events, and transcript cues with their times", async () => {
    const res = await call("index_recording", { input: video });
    expect(res.isError, res.text).toBe(false);
    const data = res.data!;
    expect(data.indexPath).toBe(join(dir, "rec.index.json"));
    expect(existsSync(join(dir, "rec.index.json"))).toBe(true);
    expect(data.cached).toBe(false);
    expect(data.sources).toMatchObject({ events: 2, markers: 1, transcriptCues: 1 });

    const marker = await call("search_recording", { input: video, query: "preferences" });
    expect(marker.isError, marker.text).toBe(false);
    expect(marker.images).toBe(0);
    const [m] = marker.data!.hits as Hit[];
    expect(m!.t).toBe(14);
    expect(m!.matches[0]!.source).toBe("marker");

    const cue = await call("search_recording", { input: video, query: "click save" });
    expect((cue.data!.hits as Hit[])[0]!.t).toBe(17.5);
    const key = await call("search_recording", { input: video, query: "Ctrl+S" });
    expect((key.data!.hits as Hit[])[0]!.t).toBe(20.5);
  });

  it.skipIf(!OCR)("finds screen text within a second, with secrets masked, and images only when asked", async () => {
    const res = await call("search_recording", { input: video, query: "Save failed" });
    expect(res.isError, res.text).toBe(false);
    expect(res.images).toBe(0);
    const hits = res.data!.hits as Hit[];
    const screen = hits.find((h) => h.matches.some((m) => m.source === "screen"));
    expect(screen, JSON.stringify(hits)).toBeDefined();
    expect(Math.abs(screen!.start - 21)).toBeLessThanOrEqual(1);

    const secret = await call("search_recording", { input: video, query: "ghp_", regex: true });
    const sHits = secret.data!.hits as Hit[];
    expect(sHits.length).toBeGreaterThan(0);
    expect(sHits[0]!.start).toBeGreaterThanOrEqual(4);
    expect(sHits[0]!.start).toBeLessThanOrEqual(6);
    expect(secret.text).not.toContain("Abc123");
    expect(secret.text).toContain("[REDACTED]");
    // The sidecar keeps the raw text, for a secret scan over the whole timeline.
    expect(readFileSync(join(dir, "rec.index.json"), "utf8")).toMatch(/ghp.Abc123/);

    const shown = await call("search_recording", { input: video, query: "Save failed", images: 1 });
    expect(shown.images).toBe(1);
  });

  it("reuses the OCR of an unchanged recording, and re-attaches new markers", async () => {
    writeFileSync(join(dir, "rec.markers.json"), JSON.stringify({ markers: [{ t: 2, label: "Second marker" }] }));
    const res = await call("index_recording", { input: video });
    expect(res.isError, res.text).toBe(false);
    expect(res.data!.cached).toBe(true);
    const hit = await call("search_recording", { input: video, query: "second marker" });
    expect((hit.data!.hits as Hit[])[0]!.t).toBe(2);
    expect(((await call("search_recording", { input: video, query: "preferences" })).data!.hits as Hit[]).length).toBe(0);
  });

  it("writes under SCREENCAST_HOME when the video's folder is outside the allowed dirs", async () => {
    const other = join(dir, "copy.mp4");
    copyFileSync(video, other);
    copyFileSync(join(dir, "rec.events.jsonl"), join(dir, "copy.events.jsonl"));
    process.env.SCREENCAST_ALLOWED_DIRS = home;
    try {
      const res = await call("index_recording", { input: other, maxFrames: 4 });
      expect(res.isError, res.text).toBe(false);
      const path = res.data!.indexPath as string;
      expect(path.startsWith(join(home, "edits", "indexes"))).toBe(true);
      expect(existsSync(join(dir, "copy.index.json"))).toBe(false);
      const found = await call("search_recording", { input: other, query: "Ctrl+S" });
      expect(found.data!.indexPath).toBe(path);
    } finally {
      delete process.env.SCREENCAST_ALLOWED_DIRS;
    }
  });

  it("refuses a transcript file that does not exist", async () => {
    const res = await call("index_recording", { input: video, transcript: join(dir, "nope.srt") });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Transcript not found/);
  });
});
