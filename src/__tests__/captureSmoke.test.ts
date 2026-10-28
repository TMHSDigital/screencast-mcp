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
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const RUN = process.platform === "win32" && !!process.env.RUN_CAPTURE_SMOKE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("capture smoke (RUN_CAPTURE_SMOKE)", () => {
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

  it("leaves a paused stretch out of the file and the markers (#200)", async () => {
    const { probeMedia } = await import("../utils/ffmpeg.js");
    const start = await call("start_recording", { target: "region:0,0,640,480", quality: "draft", fps: 15 });
    expect(start.isError, start.text).toBe(false);
    const id = start.json.sessionId;
    await sleep(2000);
    const pause = await call("pause_recording", { sessionId: id });
    expect(pause.isError, pause.text).toBe(false);
    expect(pause.json.status).toBe("paused");
    const recorded = pause.json.recordedSec as number;
    await sleep(3000);
    const mark = await call("add_marker", { sessionId: id, label: "at the pause" });
    expect((mark.json.marker as { t: number }).t).toBeCloseTo(recorded, 1);
    const resume = await call("resume_recording", { sessionId: id });
    expect(resume.isError, resume.text).toBe(false);
    await sleep(2000);
    const stop = await call("stop_recording", { sessionId: id });
    expect(stop.isError, stop.text).toBe(false);
    expect(stop.json.segmentsJoined).toBe(2);
    const info = await probeMedia(start.json.outputPath as string);
    // About 4 s recorded over about 7 s of wall time. The second segment runs
    // ~2 s plus resume/stop latency (up to ~1.6 s on a hosted runner); keeping
    // the 3 s pause would put it past recorded + 5.
    expect(info.durationSec!).toBeGreaterThan(recorded + 1);
    expect(info.durationSec!).toBeLessThan(recorded + 4.5);
    expect(existsSync(`${start.json.outputPath as string}.parts`)).toBe(false);
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
