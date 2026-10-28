/**
 * list_targets and doctor through a real Client (#213, #195). Enumeration,
 * ffmpeg probes, and the still capture are faked, so this runs anywhere; the
 * fake capture records what screenshot resolved, proving every listed target
 * round-trips through screenshot to the listed monitor or window.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Monitor } from "../utils/monitors.js";
import type { WindowQuery } from "../utils/windows.js";
import type { ResolvedTarget } from "../utils/resolveTarget.js";
import type { TargetList } from "../utils/targetList.js";

const MONITORS: Monitor[] = [
  { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, dpi: 120 },
  { index: 1, x: 1920, y: 0, width: 1280, height: 1024, primary: false, dpi: 96 },
];
const DESKTOP: WindowQuery = {
  virtual: { x: 0, y: 0, w: 3200, h: 1080 },
  windows: [
    { title: "notes.txt - Editor", left: 100, top: 100, right: 900, bottom: 700, minimized: false, hwnd: 101, exe: "editor.exe", pid: 7 },
    { title: "notes.txt - Editor", left: 2000, top: 100, right: 2600, bottom: 700, minimized: false, hwnd: 102, exe: "editor.exe", pid: 7 },
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
vi.mock("../utils/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg-fake", ffprobe: "ffprobe-fake" }),
  detectFfmpeg: () => ({ ffmpeg: "ffmpeg-fake", ffprobe: "ffprobe-fake" }),
  wgcAvailable: () => true,
  hasFilter: (name: string) => name !== "whisper",
}));
vi.mock("../utils/capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/capabilities.js")>()),
  versionText: (bin: string) =>
    `${bin.startsWith("ffprobe") ? "ffprobe" : "ffmpeg"} version 7.1.1-essentials_build Copyright\n  libavutil      59. 39.100 / 59. 39.100\n`,
  devicesText: () => "Devices:\n ---\n D  dshow           DirectShow\n D  gdigrab         GDI\n D  lavfi           lavfi\n",
  locate: (bin: string) => `C:\\ffmpeg\\bin\\${bin}.exe`,
  ocrStatus: async () => ({ available: true, language: "en-US", languages: ["en-US"] }),
}));
const captured: Array<{ resolved: ResolvedTarget; backend: string }> = [];
vi.mock("../utils/still.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/still.js")>()),
  captureStill: async (resolved: ResolvedTarget, _output: string, backend: string) => {
    captured.push({ resolved, backend });
  },
}));

const home = mkdtempSync(join(tmpdir(), "sc-targets-"));
process.env.SCREENCAST_HOME = home;
let client: Client;

beforeAll(async () => {
  const { createServer } = await import("../server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "targets-test", version: "0.0.0" });
  await client.connect(clientSide);
});
afterAll(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
  return { isError: res.isError === true, text, structured: res.structuredContent as Record<string, unknown> | undefined };
}

describe("list_targets (#213)", () => {
  it("is advertised read-only and closed-world", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "list_targets");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool?.outputSchema).toBeDefined();
  });

  it("returns monitors and windows as structured content", async () => {
    const res = await call("list_targets");
    expect(res.isError).toBe(false);
    const list = res.structured as unknown as TargetList;
    expect(JSON.parse(res.text)).toEqual(res.structured);
    expect(list.monitors.map((m) => [m.target, m.scale])).toEqual([["monitor:0", 1.25], ["monitor:1", 1]]);
    expect(list.windows.map((w) => [w.target, w.capturable, w.wgcCapturable])).toEqual([
      ["window:hwnd=101", true, true],
      ["window:hwnd=102", true, true],
      ["window:hwnd=202", false, true],
      ["window:hwnd=303", false, false],
    ]);
  });

  it("filters by exe and title", async () => {
    const byExe = (await call("list_targets", { exe: "editor" })).structured as unknown as TargetList;
    expect(byExe.windows.map((w) => w.hwnd)).toEqual([101, 102]);
    const byTitle = (await call("list_targets", { titleContains: "mail", capturableOnly: true })).structured as unknown as TargetList;
    expect(byTitle.windows).toEqual([]);
  });

  it("every returned target round-trips through screenshot", async () => {
    const list = (await call("list_targets")).structured as unknown as TargetList;
    const entries = [
      { target: list.full.target, backend: "gdigrab" },
      ...list.monitors.map((m) => ({ target: m.target, backend: "gdigrab", index: m.index })),
      ...list.windows
        .filter((w) => w.capturable || w.wgcCapturable)
        .map((w) => ({ target: w.target, backend: w.capturable ? "gdigrab" : "wgc", hwnd: w.hwnd })),
    ];
    for (const e of entries) {
      captured.length = 0;
      const res = await call("screenshot", { target: e.target, backend: e.backend, returnImage: false });
      expect(res.isError, `${e.target}: ${res.text}`).toBe(false);
      const { resolved } = captured[0];
      if ("hwnd" in e) expect(resolved.window?.hwnd).toBe(e.hwnd);
      else if ("index" in e) expect(resolved.target).toEqual({ kind: "monitor", index: e.index });
      else expect(resolved.target.kind).toBe("full");
    }
    expect(entries).toHaveLength(1 + 2 + 3);
  });
});

describe("doctor (#195)", () => {
  it("is advertised read-only and closed-world", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "doctor");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("reports versions, filters, devices, OCR, and the FFmpeg 8 gap", async () => {
    const res = await call("doctor");
    expect(res.isError).toBe(false);
    const r = res.structured as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.ffmpeg).toMatchObject({ found: true, version: "7.1.1-essentials_build", major: 7, meetsFfmpeg8: false, path: "C:\\ffmpeg\\bin\\ffmpeg-fake.exe" });
    expect(r.ffprobe).toMatchObject({ found: true, major: 7 });
    expect(r.filters).toMatchObject({ whisper: false, subtitles: true, gfxcapture: true, drawtext: true });
    expect(r.devices).toEqual({ gdigrab: true, dshow: true });
    expect(r.wgc).toEqual({ available: true });
    expect(r.ocr).toMatchObject({ available: true, language: "en-US" });
    expect(r.storage.home).toBe(home);
    expect(r.env.SCREENCAST_HOME).toBe(home);
    expect(r.ok).toBe(false);
    const problems = (r.problems as string[]).join("\n");
    expect(problems).toMatch(/older than 8: transcribe and backend "wgc" need FFmpeg 8\+/);
    expect(problems).toMatch(/No whisper filter: transcribe unavailable/);
    expect(problems).not.toMatch(/subtitles/);
  });
});
