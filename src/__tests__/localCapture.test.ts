/**
 * Local capture regression harness (NOT run in CI).
 *
 * CI runs on headless Linux with no display and no gdigrab, so it can only
 * prove build + unit logic. These tests drive the BUILT server over real stdio
 * and exercise the gdigrab capture path end to end on a Windows desktop. They
 * are gated behind RUN_LOCAL_CAPTURE_TESTS so `npm test` stays green everywhere
 * else.
 *
 *   npm run build
 *   RUN_LOCAL_CAPTURE_TESTS=1 npm test
 *
 * The window-capture cases are the BUG-1 regression guard: window: must capture
 * the window's on-screen rectangle (real pixels), never a blank gdigrab
 * `title=` surface. A near-black average luma fails the test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RUN = !!process.env.RUN_LOCAL_CAPTURE_TESTS;
const SERVER = join(process.cwd(), "dist", "index.js");

interface Probe { ok: boolean; durationSec: number; width?: number; height?: number; vcodec?: string }
function ffprobe(path: string): Probe {
  const r = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, durationSec: NaN };
  const j = JSON.parse(r.stdout);
  const v = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === "video");
  return { ok: true, durationSec: Number(j.format?.duration ?? NaN), width: v?.width, height: v?.height, vcodec: v?.codec_name };
}
/** Average luma (0-255) of an image; ~0 means a blank/black capture. */
function meanLuma(path: string): number {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1024 });
  return r.stdout && r.stdout.length > 0 ? r.stdout[0] : -1;
}
function openWindows(): string[] {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | ForEach-Object { $_.MainWindowTitle }"], { encoding: "utf8" });
  return (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("local gdigrab capture (RUN_LOCAL_CAPTURE_TESTS)", () => {
  let home: string;
  let client: Client;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "screencast-verify-"));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER],
      env: { ...process.env, SCREENCAST_HOME: home }, stderr: "pipe",
    });
    client = new Client({ name: "regress", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)?.map((c) => c.text).join("\n") ?? "";
    // The parsed JSON shape varies per tool; this test helper handles all of them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { isError: !!res.isError, text, json };
  }

  it("exposes exactly the tools declared in mcp-tools.json", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const declared = (JSON.parse(readFileSync(join(process.cwd(), "mcp-tools.json"), "utf8")) as Array<{ name: string }>)
      .map((t) => t.name).sort();
    expect(tools).toEqual(declared);
  });

  it("records a region, stops gracefully, and leaves a non-truncated mp4", async () => {
    const start = await call("start_recording", { target: "region:0,0,640,480", quality: "draft", fps: 15 });
    expect(start.isError).toBe(false);
    await sleep(3500);
    const stop = await call("stop_recording", { sessionId: start.json.sessionId });
    expect(stop.json.finalizedGracefully).toBe(true);
    const p = ffprobe(start.json.outputPath);
    expect(p.ok).toBe(true);
    expect(p.width).toBe(640);
    expect(p.durationSec).toBeGreaterThan(1.5);
  }, 30_000);

  it("samples viewable frames from a recording", async () => {
    const rec = await call("start_recording", { target: "region:0,0,400,300", quality: "draft", fps: 12 });
    await sleep(2500);
    await call("stop_recording", { sessionId: rec.json.sessionId });
    const sf = await call("sample_frames", { input: rec.json.outputPath, timestamps: [0.5, 1.5] });
    expect(sf.json.frameCount).toBe(2);
    for (const f of sf.json.frames) expect(existsSync(f)).toBe(true);
  }, 30_000);

  it("monitor:0 captures physical pixels, matching full on a single-monitor host (#39)", async () => {
    // DPI-scaled displays exposed the bug: monitor:N used logical (scaled)
    // bounds, so it captured a cropped slice. On a single-monitor host the
    // primary monitor should equal the whole desktop in physical pixels.
    const multi = await call("screenshot", { target: "monitor:1" });
    if (!multi.isError) return; // more than one monitor; skip the single-monitor invariant
    const full = await call("screenshot", { target: "full" });
    const m0 = await call("screenshot", { target: "monitor:0" });
    expect(m0.isError).toBe(false);
    const f = ffprobe(full.json.outputPath);
    const m = ffprobe(m0.json.outputPath);
    expect(m.width).toBe(f.width);
    expect(m.height).toBe(f.height);
  }, 30_000);

  it("BUG-1: window: captures real window pixels, not a blank surface", async () => {
    const title = openWindows()[0];
    if (!title) return; // no titled window available in this environment
    const shot = await call("screenshot", { target: `window:${title}` });
    expect(shot.isError).toBe(false);
    expect(existsSync(shot.json.outputPath)).toBe(true);
    expect(shot.json.region.width).toBeGreaterThan(0);
    // The old gdigrab title= path returned a uniform black/white frame.
    expect(meanLuma(shot.json.outputPath)).toBeGreaterThan(8);
  }, 30_000);

  it("reaps a live orphaned ffmpeg on startup", async () => {
    const h = mkdtempSync(join(tmpdir(), "screencast-reap-"));
    mkdirSync(join(h, "recordings"), { recursive: true });
    const out = join(h, "recordings", "orphan.mp4");
    const ff = spawn("ffmpeg", ["-y", "-f", "gdigrab", "-framerate", "5", "-offset_x", "0", "-offset_y", "0", "-video_size", "200x150", "-i", "desktop", "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov", out], { detached: true, stdio: "ignore", windowsHide: true });
    ff.unref();
    await sleep(1500);
    const wasAlive = spawnSync("tasklist", ["/FI", `PID eq ${ff.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout.includes("ffmpeg");
    expect(wasAlive).toBe(true);
    writeFileSync(join(h, "sessions.json"), JSON.stringify([{ id: "rec-orphan", target: "region:0,0,200,150", outputPath: out, fps: 5, quality: "draft", pid: ff.pid, status: "recording", startedAt: "2026-01-01T00:00:00.000Z" }]));
    const tr = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, SCREENCAST_HOME: h }, stderr: "pipe" });
    const c2 = new Client({ name: "reap", version: "0.0.0" }, { capabilities: {} });
    await c2.connect(tr);
    await sleep(1200);
    const stillAlive = spawnSync("tasklist", ["/FI", `PID eq ${ff.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout.includes("ffmpeg");
    const sess = await c2.callTool({ name: "get_session", arguments: { sessionId: "rec-orphan" } });
    const status = JSON.parse((sess.content as Array<{ text: string }>)[0].text).status;
    await c2.close();
    rmSync(h, { recursive: true, force: true });
    expect(stillAlive).toBe(false);
    expect(status).toBe("orphaned");
  }, 30_000);
});
