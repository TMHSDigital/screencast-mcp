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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
