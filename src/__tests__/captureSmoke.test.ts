/**
 * Capture smoke test for the Windows CI leg (#192): a full-desktop screenshot
 * and a short gdigrab recording, through the MCP handlers with real ffmpeg.
 * Hosted Windows runners have a desktop session, so this proves the capture
 * path the other suites can only build arguments for.
 *
 * Gated behind RUN_CAPTURE_SMOKE (CI's Windows leg sets it) so a plain
 * `npm test` never captures a developer's screen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RUN = process.platform === "win32" && !!process.env.RUN_CAPTURE_SMOKE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A hosted runner's desktop session is shared and often loaded; one retry
// there absorbs a stalled capture without hiding a real break, which fails
// both attempts. Local runs get no retry (#260).
const RETRY = process.env.GITHUB_ACTIONS === "true" ? 1 : 0;

/** Video packet timestamps (seconds, presentation order) and the container
 * duration, from ffprobe: what the file holds, independent of wall time. */
function videoTimeline(ffprobe: string, path: string): { pts: number[]; frameSec: number; durationSec: number } {
  const res = spawnSync(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,duration_time:format=duration", "-of", "json", path],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`ffprobe failed on ${path}: ${res.stderr}`);
  const data = JSON.parse(res.stdout) as { packets?: Array<{ pts_time?: string; duration_time?: string }>; format?: { duration?: string } };
  const packets = (data.packets ?? []).filter((p) => p.pts_time !== undefined);
  const pts = packets.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
  const frameSec = Number(packets[0]?.duration_time ?? 0);
  return { pts, frameSec, durationSec: Number(data.format?.duration ?? 0) };
}

describe.skipIf(!RUN)("capture smoke (RUN_CAPTURE_SMOKE)", { retry: RETRY }, () => {
  let home: string;
  let client: Client;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "sc-smoke-"));
    process.env.SCREENCAST_HOME = home;
    const { createServer } = await import("../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "smoke", version: "0.0.0" });
    await client.connect(clientSide);
  });
  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    const blocks = res.content as Array<{ type: string; text?: string }>;
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* plain text */
    }
    return { isError: res.isError === true, text, json, images: blocks.filter((b) => b.type === "image").length };
  }

  it("screenshots the full desktop", async () => {
    const res = await call("screenshot", { target: "full" });
    expect(res.isError, res.text).toBe(false);
    expect(res.images).toBe(1);
  }, 30_000);

  it("records two seconds with gdigrab and finalizes the file", async () => {
    const { probeMedia } = await import("../utils/ffmpeg.js");
    const start = await call("start_recording", { target: "region:0,0,640,480", quality: "draft", fps: 15 });
    expect(start.isError, start.text).toBe(false);
    await sleep(2000);
    const stop = await call("stop_recording", { sessionId: start.json.sessionId });
    expect(stop.isError, stop.text).toBe(false);
    expect(stop.json.finalizedGracefully).toBe(true);
    const output = start.json.outputPath as string;
    expect(existsSync(output)).toBe(true);
    const info = await probeMedia(output);
    expect(info.width).toBe(640);
    expect(info.durationSec!).toBeGreaterThan(1);
  }, 60_000);

  it("events: true writes events.jsonl, removes the raw log, and leaves no helper running (#298)", async () => {
    const powershells = () =>
      new Set(
        (spawnSync("tasklist", ["/FI", "IMAGENAME eq powershell.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout ?? "")
          .split(/\r?\n/)
          .map((l) => l.split('","')[1])
          .filter((pid): pid is string => !!pid),
      );
    const before = powershells();
    const start = await call("start_recording", { target: "region:0,0,640,480", quality: "draft", fps: 15, events: true });
    expect(start.isError, start.text).toBe(false);
    await sleep(1500);
    const stop = await call("stop_recording", { sessionId: start.json.sessionId });
    expect(stop.isError, stop.text).toBe(false);
    const base = (start.json.outputPath as string).replace(/\.mp4$/, "");
    expect(existsSync(`${base}.events.jsonl`), stop.text).toBe(true);
    expect(existsSync(`${base}.events.raw`)).toBe(false);
    const leftover = [...powershells()].filter((pid) => !before.has(pid));
    expect(leftover, "the hook helper is still running").toEqual([]);
  }, 90_000);

  it("leaves a paused stretch out of the file and the markers (#200)", async () => {
    const { requireFfmpeg } = await import("../utils/ffmpeg.js");
    const start = await call("start_recording", { target: "region:0,0,640,480", quality: "draft", fps: 15 });
    expect(start.isError, start.text).toBe(false);
    const id = start.json.sessionId;
    const output = start.json.outputPath as string;
    await sleep(2000);
    const pause = await call("pause_recording", { sessionId: id });
    expect(pause.isError, pause.text).toBe(false);
    expect(pause.json.status).toBe("paused");
    // ffprobe's length of the first segment, which is the output file until
    // stop joins the parts.
    const recorded = pause.json.recordedSec as number;
    expect(recorded).toBeGreaterThan(1);
    await sleep(3000);
    const mark = await call("add_marker", { sessionId: id, label: "at the pause" });
    expect((mark.json.marker as { t: number }).t).toBeCloseTo(recorded, 1);
    const resume = await call("resume_recording", { sessionId: id });
    expect(resume.isError, resume.text).toBe(false);
    await sleep(2000);
    const stop = await call("stop_recording", { sessionId: id });
    expect(stop.isError, stop.text).toBe(false);
    expect(stop.json.segmentsJoined).toBe(2);
    expect(existsSync(`${output}.parts`)).toBe(false);

    // Judge the file by its own timestamps, not by wall time: a loaded runner
    // stretches each segment by its start/stop latency (#260). If the pause
    // were kept, as a frozen stretch or a timestamp hole, the timeline would
    // jump by about 3 s where the first segment ends.
    const { pts, frameSec, durationSec } = videoTimeline(requireFfmpeg().ffprobe, output);
    // On failure, show what resume and stop reported, to tell an empty or late
    // second segment from one the join dropped (#331).
    const summary =
      `${pts.length} frames over ${durationSec}s, first segment ${recorded}s` +
      `\nresume: ${JSON.stringify(resume.json)}\nstop: ${JSON.stringify(stop.json)}`;
    expect(pts.length, summary).toBeGreaterThan(15);
    expect(pts[0]!, summary).toBeLessThan(0.5);
    const gaps = pts.slice(1).map((t, i) => t - pts[i]!);
    const widest = Math.max(...gaps);
    expect(widest, `widest gap ${widest}s; ${summary}`).toBeLessThan(1);
    // The container ends with the last frame: no padding where the pause was.
    expect(Math.abs(pts[pts.length - 1]! + frameSec - durationSec), summary).toBeLessThan(0.5);
    // Both segments are in it: the first, then at least 1 s of the second.
    expect(durationSec, summary).toBeGreaterThan(recorded + 1);
    // Wide sanity bound only: two ~2 s segments plus generous latency each.
    expect(durationSec, summary).toBeLessThan(recorded + 10);
  }, 90_000);

  it("records with ddagrab and the auto encoder (#199)", async () => {
    const { probeMedia } = await import("../utils/ffmpeg.js");
    const start = await call("start_recording", { target: "region:0,0,640,480", backend: "ddagrab", fps: 30 });
    if (start.isError && /Desktop Duplication|second GPU|single one/.test(start.text)) return; // no DDA here
    expect(start.isError, start.text).toBe(false);
    expect(start.json.backend).toBe("ddagrab");
    expect(["x264", "nvenc", "qsv", "amf"]).toContain(start.json.encoder);
    await sleep(2000);
    const stop = await call("stop_recording", { sessionId: start.json.sessionId });
    expect(stop.isError, stop.text).toBe(false);
    const info = await probeMedia(start.json.outputPath as string);
    expect(info.width).toBe(640);
    expect(info.durationSec!).toBeGreaterThan(1);
  }, 60_000);

  // Moved from the local-only suite so they gate releases (#300).

  it("maxDurationSec ends a recording on its own with a playable file (#82)", async () => {
    const { probeMedia } = await import("../utils/ffmpeg.js");
    const start = await call("start_recording", { target: "region:0,0,64,64", quality: "draft", fps: 5, maxDurationSec: 2 });
    expect(start.isError, start.text).toBe(false);
    expect(start.json.maxDurationSec).toBe(2);
    // Poll rather than sleep a fixed time: a loaded host is slow to spin up ffmpeg.
    let got = await call("get_session", { sessionId: start.json.sessionId });
    for (const t0 = Date.now(); got.json.status === "recording" && Date.now() - t0 < 30_000; ) {
      await sleep(500);
      got = await call("get_session", { sessionId: start.json.sessionId });
    }
    expect(got.json, got.text).toMatchObject({ status: "stopped", endReason: "max_duration" });
    const info = await probeMedia(start.json.outputPath as string);
    expect(info.durationSec!).toBeCloseTo(2, 0);
  }, 60_000);

  it("wait_for_change: a still region settles, and an unchanged one times out (#116)", async () => {
    // The top-left corner of a runner's desktop holds no clock or cursor.
    const settle = await call("wait_for_change", { target: "region:0,0,64,64", mode: "settle", settleSec: 0.5, timeoutSec: 10, returnImage: false });
    expect(settle.isError, settle.text).toBe(false);
    expect(settle.json.outcome).toBe("settled");
    const change = await call("wait_for_change", { target: "region:0,0,64,64", mode: "change", timeoutSec: 1, returnImage: false });
    expect(change.isError, change.text).toBe(false);
    expect(change.json.outcome).toBe("timeout");
  }, 60_000);

  // These two start their own server process from dist/ (CI builds first).
  const SERVER = join(process.cwd(), "dist", "index.js");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("reaps a live orphaned ffmpeg on startup", async () => {
    const { requireFfmpeg } = await import("../utils/ffmpeg.js");
    const h = mkdtempSync(join(tmpdir(), "sc-smoke-reap-"));
    mkdirSync(join(h, "recordings"), { recursive: true });
    const out = join(h, "recordings", "orphan.mp4");
    const ff = spawn(
      requireFfmpeg().ffmpeg,
      ["-y", "-f", "gdigrab", "-framerate", "5", "-offset_x", "0", "-offset_y", "0", "-video_size", "200x150", "-i", "desktop", "-t", "30",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov", out],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    ff.unref();
    try {
      await sleep(1500);
      expect(alive(ff.pid!)).toBe(true);
      writeFileSync(
        join(h, "sessions.json"),
        JSON.stringify([{ id: "rec-orphan", target: "region:0,0,200,150", outputPath: out, fps: 5, quality: "draft", pid: ff.pid, status: "recording", startedAt: "2026-01-01T00:00:00.000Z" }]),
      );
      const c2 = new Client({ name: "reap", version: "0.0.0" });
      await c2.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, SCREENCAST_HOME: h } as Record<string, string>, stderr: "pipe" }));
      try {
        let status = "";
        for (const t0 = Date.now(); Date.now() - t0 < 15_000; await sleep(300)) {
          const sess = await c2.callTool({ name: "get_session", arguments: { sessionId: "rec-orphan" } });
          status = (JSON.parse((sess.content as Array<{ text: string }>)[0]!.text) as { status: string }).status;
          if (status === "orphaned" && !alive(ff.pid!)) break;
        }
        expect(status).toBe("orphaned");
        expect(alive(ff.pid!)).toBe(false);
      } finally {
        await c2.close();
      }
    } finally {
      if (alive(ff.pid!)) spawnSync("taskkill", ["/PID", String(ff.pid), "/F"]);
      rmSync(h, { recursive: true, force: true });
    }
  }, 60_000);

  it("a client disconnect finalizes the recording and the server + ffmpeg exit (#76)", async () => {
    const { probeMedia } = await import("../utils/ffmpeg.js");
    // Raw stdio (not StdioClientTransport, whose close() kills the child and
    // would hide the bug): end the server's stdin like a client going away.
    const h = mkdtempSync(join(tmpdir(), "sc-smoke-disconnect-"));
    const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, SCREENCAST_HOME: h }, stdio: ["pipe", "pipe", "pipe"] });
    let started: { pid: number; outputPath: string; sessionId: string } | undefined;
    try {
      let buf = "";
      let errBuf = "";
      srv.stdout.on("data", (d) => (buf += d));
      srv.stderr.on("data", (d) => (errBuf += d));
      const send = (m: object) => srv.stdin.write(JSON.stringify(m) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "disconnect", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_recording", arguments: { target: "region:0,0,64,64", quality: "draft", fps: 5 } } });
      for (const t0 = Date.now(); !buf.includes('"id":2') && Date.now() - t0 < 45_000; ) await sleep(100);
      const line = buf.split("\n").find((l) => l.includes('"id":2'));
      expect(line, `start_recording never answered. stdout: ${buf.slice(0, 400)} stderr: ${errBuf.slice(0, 400)}`).toBeDefined();
      started = JSON.parse((JSON.parse(line!) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as typeof started;
      await sleep(1500);

      const exited = new Promise<void>((r) => srv.once("exit", () => r()));
      srv.stdin.end();
      await Promise.race([exited, sleep(30_000)]);

      expect(srv.exitCode !== null || srv.signalCode !== null, `server still running. stderr: ${errBuf.slice(-400)}`).toBe(true);
      expect(alive(started!.pid)).toBe(false);
      expect((await probeMedia(started!.outputPath)).durationSec!).toBeGreaterThan(0.5);
      const reg = JSON.parse(readFileSync(join(h, "sessions.json"), "utf8")) as Array<{ id: string; status: string; endReason?: string }>;
      expect(reg.find((r) => r.id === started!.sessionId)).toMatchObject({ status: "stopped", endReason: "shutdown" });
    } finally {
      if (srv.exitCode === null && srv.signalCode === null) srv.kill();
      if (started && alive(started.pid)) spawnSync("taskkill", ["/PID", String(started.pid), "/F"]);
      rmSync(h, { recursive: true, force: true });
    }
  }, 120_000);

  // A camera is needed too, so this one has its own switch.
  it.skipIf(!process.env.RUN_WEBCAM_SMOKE)("records a webcam aligned with the screen (#200)", async () => {
    const { probeMedia } = await import("../utils/ffmpeg.js");
    const start = await call("start_recording", { target: "region:0,0,640,480", fps: 15, webcam: { corner: "top_right" } });
    expect(start.isError, start.text).toBe(false);
    await sleep(2500);
    const stop = await call("stop_recording", { sessionId: start.json.sessionId });
    expect(stop.isError, stop.text).toBe(false);
    const cam = stop.json.webcam as { path: string; overlay: { x: number } };
    const [screen, webcam] = await Promise.all([probeMedia(start.json.outputPath as string), probeMedia(cam.path)]);
    expect(Math.abs(webcam.durationSec! - screen.durationSec!)).toBeLessThan(0.2);
    expect(cam.overlay.x).toBeGreaterThan(320);
  }, 90_000);
});
