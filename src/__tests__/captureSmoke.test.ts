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
});
