/**
 * #126: prompts and resources, exercised through a real MCP client over an
 * in-memory transport (no ffmpeg or Windows needed, except the poster read).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { defined } from "./testUtils.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const home = mkdtempSync(join(tmpdir(), "screencast-pr-"));
process.env.SCREENCAST_HOME = home;
const { registerPrompts, PROMPT_TEXT } = await import("../prompts.js");
const { registerResources } = await import("../resources.js");
const { getStore } = await import("../context.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const toolNames = new Set((JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf8")) as Array<{ name: string }>).map((t) => t.name));

describe("MCP prompts and resources (#126)", () => {
  let client: Client;
  let changes = 0;

  beforeAll(async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerPrompts(server);
    registerResources(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "c", version: "0" });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      changes++;
    });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists the four workflow prompts", async () => {
    const names = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(names).toEqual(["bug-repro-clip", "demo-gif", "review-recording", "verify-ui-change"]);
  });

  it("fills a prompt's arguments into its workflow", async () => {
    const r = await client.getPrompt({ name: "verify-ui-change", arguments: { target: "window:App", expectation: "the Save button turns green" } });
    const text = (defined(r.messages[0]).content as { text: string }).text;
    expect(text).toContain('wait_for_change { target: "window:App", mode: "settle" }');
    expect(text).toContain("the Save button turns green");
  });

  it("only names tools that exist", () => {
    const texts = [
      PROMPT_TEXT.bugReproClip("full", ""),
      PROMPT_TEXT.demoGif("full", "10"),
      PROMPT_TEXT.verifyUiChange("full", ""),
      PROMPT_TEXT.reviewRecording("x.mp4"),
    ].join("\n");
    const named = [...texts.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b(?= \{|\b)/g)].map((m) => defined(m[1])).filter((n) => /^[a-z]+_[a-z_]+$/.test(n));
    const unknown = [...new Set(named)].filter((n) => !toolNames.has(n) && !["fileExists"].includes(n));
    expect(unknown).toEqual([]);
    for (const t of ["start_recording", "export_gif", "find_text", "contact_sheet", "screen_diff"]) expect(named).toContain(t);
  });

  it("exposes sessions as resources and announces changes", async () => {
    const store = getStore();
    store.create({ id: "rec-1", target: "full", outputPath: join(home, "nope.mp4"), fps: 30, quality: "standard", pid: null, status: "stopped", startedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 20));
    expect(changes).toBeGreaterThan(0);

    const listed = (await client.listResources()).resources.map((r) => r.uri);
    expect(listed).toContain("screencast://sessions");
    expect(listed).toContain("screencast://sessions/rec-1");

    const all = await client.readResource({ uri: "screencast://sessions" });
    expect(JSON.parse((all.contents[0] as { text: string }).text)[0].id).toBe("rec-1");
    const one = await client.readResource({ uri: "screencast://sessions/rec-1" });
    expect(JSON.parse((one.contents[0] as { text: string }).text)).toMatchObject({ id: "rec-1", fileExists: false });

    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain("screencast://sessions/{id}/poster");
    await expect(client.readResource({ uri: "screencast://sessions/rec-1/poster" })).rejects.toThrow(/not found/);
    await expect(client.readResource({ uri: "screencast://sessions/missing" })).rejects.toThrow(/No session/);
  });
});

describe("no client notifications after shutdown starts (#229)", () => {
  it("skips the resource-list notification once shutting down", async () => {
    const { markShuttingDown } = await import("../context.js");
    const server = new McpServer({ name: "t2", version: "0" });
    registerResources(server);
    let sent = 0;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "c2", version: "0" });
    c.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      sent++;
    });
    await Promise.all([server.connect(a), c.connect(b)]);
    markShuttingDown();
    mkdirSync(home, { recursive: true }); // the suite above already cleaned it up
    getStore().create({ id: "rec-late", target: "full", outputPath: join(home, "late.mp4"), fps: 30, quality: "standard", pid: null, status: "stopped", startedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toBe(0);
    await c.close();
    rmSync(home, { recursive: true, force: true });
  });
});
