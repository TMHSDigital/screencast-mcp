/**
 * #128: the MCP Apps review player - the resource, the tool links, the frames
 * it is fed, and the page's protocol. Through a real MCP client over an
 * in-memory transport; player_frames needs ffmpeg.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = mkdtempSync(join(tmpdir(), "screencast-player-"));
process.env.SCREENCAST_HOME = home;
const { register: registerReview, playerHtml } = await import("../tools/reviewRecording.js");
const { register: registerStop } = await import("../tools/stopRecording.js");
const { playerFramePlan, playerFrameTimes, splitJpegs, PLAYER_URI, MCP_APP_MIME } = await import("../utils/player.js");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;

describe("player helpers", () => {
  it("plans up to 4 frames a second, capped, spread evenly", () => {
    expect(playerFramePlan(6)).toEqual({ count: 24, fps: 4 });
    expect(playerFramePlan(600).count).toBe(120);
    expect(playerFramePlan(600, 300).count).toBe(300);
    expect(playerFramePlan(0.1).count).toBe(1);
    expect(() => playerFramePlan(0)).toThrow(/no duration/);
    expect(playerFrameTimes(4, 4)).toEqual([0.5, 1.5, 2.5, 3.5]);
  });
  it("splits concatenated JPEGs at their markers", () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0x00, 3, 0xff, 0xd9]);
    const b = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]);
    const parts = splitJpegs(Buffer.concat([a, b, Buffer.from([0xff, 0xd8, 7])]));
    expect(parts.map((p) => [...p])).toEqual([[...a], [...b]]); // a torn last image is dropped
  });
});

describe("review player as an MCP App (#128)", () => {
  let client: Client;
  beforeAll(async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerReview(server);
    registerStop(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("serves the player as a ui:// resource with the MCP App MIME type", async () => {
    const r = await client.readResource({ uri: PLAYER_URI });
    expect(r.contents[0]).toMatchObject({ uri: PLAYER_URI, mimeType: MCP_APP_MIME });
    expect((r.contents[0] as { text: string }).text).toBe(playerHtml());
    const listed = (await client.listResources()).resources.find((x) => x.uri === PLAYER_URI);
    expect(listed?.mimeType).toBe(MCP_APP_MIME);
  });

  it("links stop_recording and review_recording to it, and keeps player_frames app-only", async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ["stop_recording", "review_recording"]) {
      const meta = tools.find((t) => t.name === name)?._meta as Record<string, unknown>;
      expect(meta.ui).toEqual({ resourceUri: PLAYER_URI });
      expect(meta["ui/resourceUri"]).toBe(PLAYER_URI);
    }
    expect(tools.find((t) => t.name === "player_frames")?._meta).toEqual({ ui: { visibility: ["app"] } });
  });

  it("the page is self-contained ASCII and speaks the spec's methods", () => {
    const html = playerHtml();
    expect([...html].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(html).not.toMatch(/(src|href)=["']https?:/); // hosts' CSP allows no outside origins
    for (const m of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "tools/call", "ui/update-model-context", "ui/notifications/size-changed"]) {
      expect(html).toContain(`"${m}"`);
    }
    expect(html).toContain('"2026-01-26"');
    expect(html).toContain('callTool("pipeline"');
  });

  it.skipIf(!hasFfmpeg)("feeds the player evenly spaced JPEG frames with their times", async () => {
    const src = join(home, "clip.mp4");
    spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=3:r=30", "-pix_fmt", "yuv420p", src]);
    const r = await client.callTool({ name: "player_frames", arguments: { input: src, width: 160 } });
    expect(r.isError).toBeFalsy();
    const content = r.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const meta = JSON.parse(content[0].text!);
    const images = content.filter((c) => c.type === "image");
    expect(images).toHaveLength(12); // 3 s at 4 fps
    expect(meta).toMatchObject({ durationSec: 3, width: 320, height: 180, hasAudio: false });
    expect(meta.frameTimes).toHaveLength(12);
    const jpeg = Buffer.from(images[0].data!, "base64");
    expect([jpeg[0], jpeg[1], jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    const rv = await client.callTool({ name: "review_recording", arguments: { input: src } });
    expect(JSON.parse((rv.content as Array<{ text: string }>)[0].text)).toMatchObject({ input: src, durationSec: 3, width: 320 });
  });
});
