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
  }, 90_000); // a cold, loaded host can take a while to boot node + probe ffmpeg

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const blocks = (res.content as Array<{ type: string; text?: string; mimeType?: string }>) ?? [];
    const text = blocks.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const images = blocks.filter((c) => c.type === "image");
    // The parsed JSON shape varies per tool; this test helper handles all of them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { isError: !!res.isError, text, json, images };
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
    // #79: the frames also come back inline for the model to view.
    expect(sf.json.inlineImages).toBe(2);
    expect(sf.images.map((i) => i.mimeType)).toEqual(["image/jpeg", "image/jpeg"]);
    const noImg = await call("sample_frames", { input: rec.json.outputPath, timestamps: [0.5], returnImages: false });
    expect(noImg.images).toHaveLength(0);
    // #80: a rate that would exceed maxFrames is lowered, and says so.
    const capped = await call("sample_frames", { input: rec.json.outputPath, fps: 30, maxFrames: 5, returnImages: false });
    expect(capped.json.frameCount).toBeLessThanOrEqual(5);
    expect(capped.json.requestedFps).toBe(30);
    expect(capped.json.capNote).toMatch(/maxFrames \(5\)/);
    const tooMany = await call("sample_frames", { input: rec.json.outputPath, timestamps: [0, 1, 2], maxFrames: 2 });
    expect(tooMany.isError).toBe(true);
  }, 30_000);

  it("a finished recording is readable as a session resource with a JPEG poster (#126)", async () => {
    const rec = await call("start_recording", { target: "region:0,0,320,240", quality: "draft", fps: 10 });
    await sleep(2000);
    await call("stop_recording", { sessionId: rec.json.sessionId });
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain(`screencast://sessions/${rec.json.sessionId}`);
    const poster = await client.readResource({ uri: `screencast://sessions/${rec.json.sessionId}/poster` });
    const c = poster.contents[0] as { mimeType?: string; blob?: string };
    expect(c.mimeType).toBe("image/jpeg");
    expect(Buffer.from(c.blob!, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
  }, 30_000);

  it("screenshot returns the image inline by default (#79)", async () => {
    const shot = await call("screenshot", { target: "region:0,0,320,200" });
    expect(shot.isError).toBe(false);
    expect(shot.json.inlineImages).toBe(1);
    expect(shot.images).toHaveLength(1);
    expect(shot.images[0].mimeType).toBe("image/jpeg");
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

  it("start_recording reports which window it matched, and exactTitle refuses substrings (#89)", async () => {
    const title = openWindows()[0];
    if (!title) return;
    const rec = await call("start_recording", { target: `window:${title}`, quality: "draft", fps: 5, exactTitle: true });
    expect(rec.isError).toBe(false);
    expect(rec.json.matchedWindow).toBe(title);
    expect(rec.json.matchKind).toBe("exact");
    expect(rec.json.region.width).toBeGreaterThan(0);
    await call("stop_recording", { sessionId: rec.json.sessionId });
    const sess = await call("get_session", { sessionId: rec.json.sessionId });
    expect(sess.json.matchedWindow).toBe(title);

    // A strict prefix of the title is only a substring match: refused when exact.
    const partial = title.slice(0, Math.max(1, title.length - 1));
    if (partial.toLowerCase() !== title.toLowerCase()) {
      const strict = await call("screenshot", { target: `window:${partial}`, exactTitle: true, returnImage: false });
      expect(strict.isError).toBe(true);
      expect(strict.text).toMatch(/titled exactly/);
    }
  }, 30_000);

  it("wait_for_change sees a window repaint, then settles (#116)", async () => {
    // A small topmost window at a fixed spot that turns from red to blue after
    // 3 s. The watched region sits well inside it even at 150% DPI scaling.
    const ps = spawn("powershell", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$f=New-Object Windows.Forms.Form;$f.StartPosition='Manual';$f.Location='60,60';$f.Size='320,240';" +
      "$f.TopMost=$true;$f.FormBorderStyle='None';$f.BackColor='Red';" +
      "$t=New-Object Windows.Forms.Timer;$t.Interval=3000;$t.Add_Tick({$f.BackColor='Blue';$t.Stop()});$t.Start();" +
      "$f.ShowDialog()"], { windowsHide: false });
    const isRed = async () => {
      const s = await call("screenshot", { target: "region:110,110,120,80", returnImage: false });
      const [r, g, b] = [...spawnSync("ffmpeg", ["-v", "error", "-i", s.json.outputPath, "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"]).stdout];
      return r > 200 && g < 60 && b < 60;
    };
    try {
      // PowerShell + WinForms startup time varies; wait until the window is
      // actually up and red rather than sleeping a fixed time.
      for (let i = 0; i < 40 && !(await isRed()); i++) await sleep(100);
      const changed = await call("wait_for_change", { target: "region:110,110,120,80", timeoutSec: 10, returnImage: false });
      expect(changed.isError).toBe(false);
      expect(changed.json.outcome).toBe("changed");
      expect(changed.json.elapsedSec).toBeLessThan(5);
      expect(changed.json.regions.length).toBeGreaterThan(0);
      const settled = await call("wait_for_change", { target: "region:110,110,120,80", mode: "settle", settleSec: 0.75, timeoutSec: 10 });
      expect(settled.json.outcome).toBe("settled");
      expect(settled.images).toHaveLength(1);
    } finally {
      ps.kill();
    }
  }, 30_000);

  it("find_text locates secrets with Windows OCR, and redacting them removes them (#117)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screencast-ocr-it-"));
    try {
      const txt = join(dir, "t.txt");
      writeFileSync(txt, "Settings  >  API keys\nOPENAI_API_KEY=sk-proj-Abc123XyZ987\nghp_9f8e7d6c5b4a3210fedcba\n");
      const font = join(process.cwd(), "assets", "fonts", "Inter-Regular.ttf");
      const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\\\:");
      const img = join(dir, "secret.png");
      const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=640x120", "-vf",
        `drawtext=fontfile=${esc(font)}:textfile=${esc(txt)}:fontsize=18:fontcolor=0x222222:x=10:y=10:line_spacing=8`, "-frames:v", "1", img]);
      expect(r.status).toBe(0);
      const found = await call("find_text", { input: img, query: "sk-|ghp_", regex: true, redact: true, returnImage: false });
      expect(found.isError).toBe(false);
      expect(found.json.matchCount).toBe(2);
      const env = await call("find_text", { input: img, query: "OPENAI_API_KEY", returnImage: false });
      expect(env.json.matchCount).toBe(1);
      const redacted = await call("redact_region", { input: img, regions: found.json.redactRegions, output: join(dir, "r.png") });
      expect(redacted.isError).toBe(false);
      const after = await call("find_text", { input: join(dir, "r.png"), query: "sk-|ghp_", regex: true, returnImage: false });
      expect(after.json.matchCount).toBe(0);
      expect(after.json.text).toContain("Settings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("backend 'wgc' captures a window's own pixels even when another window covers it (#113)", async () => {
    // Target: a lime window. Cover: a topmost magenta window fully over it.
    const ps = spawn("powershell", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$f=New-Object Windows.Forms.Form;$f.Text='SC-WGC-TARGET';$f.StartPosition='Manual';$f.Location='100,100';$f.Size='400,300';$f.BackColor='Lime';" +
      "$c=New-Object Windows.Forms.Form;$c.Text='SC-WGC-COVER';$c.StartPosition='Manual';$c.Location='80,80';$c.Size='460,360';$c.BackColor='Magenta';$c.TopMost=$true;" +
      "$f.Show();$c.Show();[Windows.Forms.Application]::Run($c)"], { windowsHide: false });
    const meanRgb = (path: string) => [...spawnSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"]).stdout];
    try {
      await sleep(2000);
      const wgc = await call("screenshot", { target: "window:SC-WGC-TARGET", exactTitle: true, backend: "wgc", returnImage: false });
      const probe = spawnSync("ffmpeg", ["-hide_banner", "-h", "filter=gfxcapture"], { encoding: "utf8" });
      if (!/gfxcapture AVOptions/.test(probe.stdout)) {
        expect(wgc.isError).toBe(true); // older ffmpeg: a clear error, not a hang
        return;
      }
      expect(wgc.isError).toBe(false);
      expect(wgc.json.backend).toBe("wgc");
      const [r, g, b] = meanRgb(wgc.json.outputPath);
      expect(g).toBeGreaterThan(200); // lime: the covered window itself
      expect(r + b).toBeLessThan(80);
      const gdi = await call("screenshot", { target: "window:SC-WGC-TARGET", exactTitle: true, returnImage: false });
      const [r2, , b2] = meanRgb(gdi.json.outputPath);
      expect(r2 + b2).toBeGreaterThan(400); // gdigrab sees the magenta cover
      const region = await call("screenshot", { target: "region:0,0,50,50", backend: "wgc" });
      expect(region.isError).toBe(true);
      expect(region.text).toMatch(/window:<title>/);
    } finally {
      ps.kill();
    }
  }, 40_000);

  it("matches a non-ASCII window title exactly, and OCR survives non-ASCII text", async () => {
    // PowerShell used to write its OEM code page: "é" came back as U+FFFD and
    // "•"/"→" as control bytes, breaking title matches and OCR JSON parsing.
    const title = "SC-TÉST — ünï 日本";
    const ps = spawn("powershell", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms;" +
      `$f=New-Object Windows.Forms.Form;$f.Text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(title).toString("base64")}'));` +
      "$f.StartPosition='Manual';$f.Location='120,120';$f.Size='520,200';$f.TopMost=$true;$f.BackColor='White';" +
      "$l=New-Object Windows.Forms.Label;$l.AutoSize=$true;$l.Font=New-Object Drawing.Font('Segoe UI',20);$l.Location='20,40';" +
      `$l.Text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from("Café • next → done").toString("base64")}'));` +
      "$f.Controls.Add($l);[Windows.Forms.Application]::Run($f)"], { windowsHide: false });
    try {
      await sleep(2500);
      const shot = await call("screenshot", { target: `window:${title}`, exactTitle: true, returnImage: false });
      expect(shot.isError).toBe(false);
      expect(shot.json.matchedWindow).toBe(title);
      const ocr = await call("find_text", { input: shot.json.outputPath, returnImage: false });
      expect(ocr.isError).toBe(false);
      expect(ocr.json.text).toMatch(/Caf/);
    } finally {
      ps.kill();
    }
  }, 40_000);

  it("screen_diff reports identical screenshots as unchanged (#116)", async () => {
    const a = await call("screenshot", { target: "region:0,0,64,64", returnImage: false });
    const d = await call("screen_diff", { a: a.json.outputPath, b: a.json.outputPath, returnImage: false });
    expect(d.isError).toBe(false);
    expect(d.json.identical).toBe(true);
    expect(d.json.ssim).toBeCloseTo(1, 5);
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

  it("maxDurationSec ends a recording on its own with a playable file (#82)", async () => {
    const start = await call("start_recording", { target: "region:0,0,64,64", quality: "draft", fps: 5, maxDurationSec: 2 });
    expect(start.json.maxDurationSec).toBe(2);
    // Poll rather than sleep a fixed time: a loaded host is slow to spin up ffmpeg.
    let got = await call("get_session", { sessionId: start.json.sessionId });
    for (const t0 = Date.now(); got.json.status === "recording" && Date.now() - t0 < 30_000; ) {
      await sleep(500);
      got = await call("get_session", { sessionId: start.json.sessionId });
    }
    expect(got.json.status).toBe("stopped");
    expect(got.json.endReason).toBe("max_duration");
    const p = ffprobe(start.json.outputPath);
    expect(p.ok).toBe(true);
    expect(p.durationSec).toBeCloseTo(2, 0);
  }, 60_000);

  it("a client disconnect finalizes the recording and the server + ffmpeg exit (#76)", async () => {
    // Raw stdio (not StdioClientTransport, whose close() kills the child and
    // would hide the bug): end the server's stdin like a client going away.
    const h = mkdtempSync(join(tmpdir(), "screencast-disconnect-"));
    const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, SCREENCAST_HOME: h }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let errBuf = "";
    srv.stdout.on("data", (d) => (buf += d));
    srv.stderr.on("data", (d) => (errBuf += d));
    const send = (m: object) => srv.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "disconnect", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_recording", arguments: { target: "region:0,0,64,64", quality: "draft", fps: 5 } } });
    const t0 = Date.now();
    while (!buf.includes('"id":2') && Date.now() - t0 < 45_000) await sleep(100);
    const line = buf.split("\n").find((l) => l.includes('"id":2'));
    expect(line, `start_recording never answered. stdout: ${buf.slice(0, 400)} stderr: ${errBuf.slice(0, 400)}`).toBeDefined();
    const started = JSON.parse(JSON.parse(line!).result.content[0].text);
    await sleep(1500);

    const exited = new Promise<void>((r) => srv.once("exit", () => r()));
    srv.stdin.end();
    await Promise.race([exited, sleep(30_000)]);

    const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const serverAlive = srv.exitCode === null && srv.signalCode === null;
    const ffmpegAlive = isAlive(started.pid);
    if (serverAlive) srv.kill();
    if (ffmpegAlive) spawnSync("taskkill", ["/PID", String(started.pid), "/F"]);
    const p = ffprobe(started.outputPath);
    const reg = JSON.parse(readFileSync(join(h, "sessions.json"), "utf8")) as Array<{ id: string; status: string; endReason?: string }>;
    rmSync(h, { recursive: true, force: true });

    expect(serverAlive).toBe(false);
    expect(ffmpegAlive).toBe(false);
    expect(p.ok).toBe(true);
    expect(reg.find((r) => r.id === started.sessionId)).toMatchObject({ status: "stopped", endReason: "shutdown" });
  }, 120_000);
});
