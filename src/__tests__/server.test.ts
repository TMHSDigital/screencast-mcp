/**
 * The MCP tool layer, driven through a real Client over an in-memory
 * transport (#192): registration matches mcp-tools.json, every tool rejects
 * bad arguments with a clean isError result, and the target-resolving tools
 * report bad targets without ever reaching ffmpeg. Runs everywhere: monitor
 * and window enumeration are faked, so no Windows desktop is needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Monitor } from "../utils/monitors.js";
import type { WindowQuery } from "../utils/windows.js";
import { MCP_APPS_EXTENSION, MCP_APP_MIME } from "../utils/player.js";

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

/** Tools listed only to MCP Apps clients. */
const APP_ONLY = ["player_frames"];

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
    expect(listed).toEqual(declared.filter((n) => !APP_ONLY.includes(n)));
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("lists the app-only player_frames only to clients that advertise MCP Apps (#242)", async () => {
    const { createServer } = await import("../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    const apps = new Client(
      { name: "apps-test", version: "0.0.0" },
      { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } } },
    );
    await apps.connect(clientSide);
    try {
      await vi.waitFor(async () => {
        expect((await apps.listTools()).tools.map((t) => t.name)).toContain("player_frames");
      });
    } finally {
      await apps.close();
    }
    const res = await call("player_frames", { input: "x.mp4" });
    expect(res.isError).toBe(true);
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
    expect(checked).toBeGreaterThan(tools.length - 4); // list_sessions, list_audio_devices, doctor take no arguments
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

describe("tool metadata (#212)", () => {
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

  /** Every tool, including the app-only ones. */
  async function allTools() {
    const { createServer } = await import("../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    const apps = new Client(
      { name: "meta-test", version: "0.0.0" },
      { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } } },
    );
    await apps.connect(clientSide);
    try {
      await vi.waitFor(async () => {
        expect((await apps.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(APP_ONLY));
      });
      return (await apps.listTools()).tools;
    } finally {
      await apps.close();
    }
  }

  it("registers every tool with registerTool, never the deprecated server.tool", () => {
    const dir = join(process.cwd(), "src", "tools");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && /\bserver\.tool\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("gives every tool a title and all four annotation hints, none open-world", async () => {
    const failures: string[] = [];
    for (const tool of await allTools()) {
      if (!tool.title) failures.push(`${tool.name}: no title`);
      for (const hint of HINTS) {
        if (typeof tool.annotations?.[hint] !== "boolean") failures.push(`${tool.name}: no ${hint}`);
      }
      // The server makes no network requests.
      if (tool.annotations?.openWorldHint !== false) failures.push(`${tool.name}: open-world`);
      if (tool.annotations?.readOnlyHint && tool.annotations.destructiveHint) failures.push(`${tool.name}: read-only yet destructive`);
    }
    expect(failures).toEqual([]);
  });

  it("marks a tool that can overwrite a file destructive", async () => {
    for (const tool of await allTools()) {
      const props = (tool.inputSchema as JsonSchema).properties ?? {};
      if ("overwrite" in props) expect({ tool: tool.name, destructive: tool.annotations?.destructiveHint }).toEqual({ tool: tool.name, destructive: true });
    }
  });

  it("mirrors each tool's title and annotations in mcp-tools.json", async () => {
    const declared = JSON.parse(readFileSync(join(process.cwd(), "mcp-tools.json"), "utf8")) as Array<{
      name: string;
      title?: string;
      annotations?: Record<string, boolean>;
    }>;
    const live = new Map((await allTools()).map((t) => [t.name, t]));
    for (const entry of declared) {
      const tool = live.get(entry.name);
      expect({ name: entry.name, title: entry.title, annotations: entry.annotations }).toEqual({
        name: entry.name,
        title: tool?.title,
        annotations: tool?.annotations,
      });
    }
  });

  it("publishes loose output schemas, so optional result fields never fail a client's validation", async () => {
    const withSchema = (await allTools()).filter((t) => t.outputSchema);
    expect(withSchema.length).toBeGreaterThan(30);
    for (const tool of withSchema) {
      expect({ tool: tool.name, additional: tool.outputSchema?.additionalProperties }).not.toEqual({ tool: tool.name, additional: false });
    }
  });

  describe("structured results", () => {
    const outputPath = join(home, "meta.mp4");

    beforeAll(async () => {
      const { getStore } = await import("../context.js");
      getStore().create({
        id: "rec-meta",
        target: "full",
        outputPath,
        fps: 30,
        quality: "standard",
        pid: null,
        status: "stopped",
        startedAt: new Date().toISOString(),
      });
    });

    // The client validates structuredContent against the tool's outputSchema
    // and throws on a mismatch, so a clean call is itself the schema check.
    it.each([
      ["list_sessions", {}],
      ["get_session", { sessionId: "rec-meta" }],
      ["stop_recording", { sessionId: "rec-meta" }],
    ] as const)("%s returns structuredContent that matches its JSON text", async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError).toBeFalsy();
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      expect(res.structuredContent).toEqual(JSON.parse(text));
      expect(JSON.stringify(res.structuredContent)).toContain(outputPath.replace(/\\/g, "\\\\"));
    });

    it("leaves error results without structuredContent", async () => {
      const res = await client.callTool({ name: "get_session", arguments: { sessionId: "no-such-session" } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toBeUndefined();
    });
  });
});
