/**
 * The MCP tool layer, driven through a real Client over an in-memory
 * transport (#192): registration matches mcp-tools.json, every tool rejects
 * bad arguments with a clean isError result, and the target-resolving tools
 * report bad targets without ever reaching ffmpeg. Runs everywhere: monitor
 * and window enumeration are faked, so no Windows desktop is needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Monitor } from "../utils/monitors.js";
import type { WindowQuery } from "../utils/windows.js";

const MONITORS: Monitor[] = [
  { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true },
];
const DESKTOP: WindowQuery = {
  virtual: { x: 0, y: 0, w: 1920, h: 1080 },
  windows: [
    { title: "notes.txt - Editor", left: 100, top: 100, right: 900, bottom: 700, minimized: false, hwnd: 101, exe: "editor.exe" },
    { title: "Settings", left: 0, top: 0, right: 800, bottom: 600, minimized: false, hwnd: 202, exe: "SystemSettings.exe", cloaked: true },
    { title: "Mail", left: 0, top: 0, right: 800, bottom: 600, minimized: true, hwnd: 303, exe: "mail.exe" },
  ],
};

vi.mock("../utils/monitors.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/monitors.js")>()),
  getMonitors: async () => MONITORS,
}));
vi.mock("../utils/windows.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../utils/windows.js")>();
  return {
    ...real,
    getRawWindows: async () => DESKTOP,
    resolveWindowBounds: async (title: string, opts?: Parameters<typeof real.selectWindow>[2]) =>
      real.selectWindow(DESKTOP, title, opts),
  };
});
// Every case here fails before a capture starts; a fake path proves that (a
// spawn of it would fail loudly) and keeps the suite independent of ffmpeg.
vi.mock("../utils/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg-not-called", ffprobe: "ffprobe-not-called" }),
  wgcAvailable: () => true,
}));

const home = mkdtempSync(join(tmpdir(), "sc-server-"));
process.env.SCREENCAST_HOME = home;
let client: Client;

beforeAll(async () => {
  const { createServer } = await import("../server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "server-test", version: "0.0.0" });
  await client.connect(clientSide);
});
afterAll(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { isError: res.isError === true, text };
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

/** Arguments the tool's schema must reject: a missing required field, or
 * (for a tool with none) a value of the wrong type. */
function invalidArgs(schema: JsonSchema): Record<string, unknown> {
  if ((schema.required ?? []).length > 0) return {};
  const [name, prop] = Object.entries(schema.properties ?? {})[0] ?? [];
  if (!name) return {};
  return { [name]: prop.type === "object" ? 12345 : { not: "valid" } };
}

describe("MCP tool layer (#192)", () => {
  it("registers exactly the tools declared in mcp-tools.json", async () => {
    const declared = (JSON.parse(readFileSync(join(process.cwd(), "mcp-tools.json"), "utf8")) as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual(declared);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("answers invalid arguments to every tool with an isError result", async () => {
    const { tools } = await client.listTools();
    const failures: string[] = [];
    let checked = 0;
    for (const tool of tools) {
      const schema = tool.inputSchema as JsonSchema;
      if (Object.keys(schema.properties ?? {}).length === 0) continue; // nothing to get wrong
      checked++;
      const res = await call(tool.name, invalidArgs(schema));
      if (!res.isError || !/invalid|required|expected/i.test(res.text)) failures.push(`${tool.name}: ${res.text.slice(0, 120)}`);
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(tools.length - 3);
  });

  describe("target resolution", () => {
    const tools = [
      ["screenshot", {}],
      ["start_recording", {}],
      ["find_text", { query: "x" }],
      ["wait_for_change", {}],
    ] as const;

    it.each(tools)("%s names the candidates when no window matches", async (tool, extra) => {
      const res = await call(tool, { ...extra, target: "window:Nonexistent App" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/No visible window matching title "Nonexistent App"/);
    });

    it.each(tools)("%s refuses a minimized window", async (tool, extra) => {
      const res = await call(tool, { ...extra, target: "window:Mail" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/minimized/);
    });

    it.each(tools)("%s refuses a region off the desktop", async (tool, extra) => {
      const res = await call(tool, { ...extra, target: "region:5000,5000,100,100" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/desktop/i);
    });

    it.each(tools)("%s rejects a malformed target", async (tool, extra) => {
      const res = await call(tool, { ...extra, target: "screen:1" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Unrecognized target|target/);
    });

    it("refuses a cloaked window for a screen capture, naming the wgc alternative (#227)", async () => {
      const res = await call("screenshot", { target: "window:Settings" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/cloaked/);
      expect(res.text).toMatch(/wgc/);
    });

    it("refuses a monitor that does not exist", async () => {
      const res = await call("screenshot", { target: "monitor:3" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/monitor:3 not found\. Available monitor indexes: 0/);
    });

    it("refuses backend wgc without a window target", async () => {
      const res = await call("start_recording", { target: "region:0,0,640,480", backend: "wgc" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/window: target/);
    });
  });
});
