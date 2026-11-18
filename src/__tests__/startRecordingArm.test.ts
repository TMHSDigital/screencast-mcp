/**
 * start_recording's armed path (#336, #349) through real Clients: consent is
 * asked once at arm time and carried to the start the trigger fires, but not
 * to any other call; a failed start is the arm's error; stopWhen stops the
 * session once its text shows. Desktop, OCR and ffmpeg are faked, so nothing
 * is captured.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { Monitor } from "../utils/monitors.js";
import type { WindowQuery } from "../utils/windows.js";
import type { ReadFrame } from "../utils/ocrScan.js";

const MONITORS: Monitor[] = [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true }];
const DESKTOP: WindowQuery = {
  virtual: { x: 0, y: 0, w: 1920, h: 1080 },
  windows: [{ title: "Build - Done", left: 100, top: 100, right: 900, bottom: 700, minimized: false, hwnd: 101, exe: "build.exe" }],
};

/** OCR'd text on the target, for stopWhen. */
let screenText = "";

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  // A capture that runs until it is sent 'q', then exits cleanly.
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null as number | null, stderr: new PassThrough(), kill: () => true });
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => {
      if (d.toString().startsWith("q") && child.exitCode === null) {
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        }, 5);
      }
    });
    return Object.assign(child, { stdin });
  },
}));
vi.mock("../utils/monitors.js", async (orig) => ({
  ...(await orig<typeof import("../utils/monitors.js")>()),
  getMonitors: async () => MONITORS,
}));
vi.mock("../utils/windows.js", async (orig) => {
  const real = await orig<typeof import("../utils/windows.js")>();
  return {
    ...real,
    getRawWindows: async () => DESKTOP,
    resolveWindowBounds: async (title: string, opts?: Parameters<typeof real.selectWindow>[2]) => real.selectWindow(DESKTOP, title, opts),
  };
});
vi.mock("../utils/ffmpeg.js", async (orig) => ({
  ...(await orig<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
  probeDuration: async () => 1,
  wgcAvailable: () => true,
}));
vi.mock("../utils/still.js", async (orig) => ({
  ...(await orig<typeof import("../utils/still.js")>()),
  captureStill: async () => {},
}));
vi.mock("../utils/ocrScan.js", async (orig) => ({
  ...(await orig<typeof import("../utils/ocrScan.js")>()),
  readFrames: async (): Promise<ReadFrame[]> => [
    { lines: screenText ? [{ text: screenText, x: 0, y: 0, width: 100, height: 20, words: [{ text: screenText, x: 0, y: 0, width: 100, height: 20 }] }] : [], width: 1920, height: 1080 },
  ],
}));

const home = mkdtempSync(join(tmpdir(), "sc-arm-"));
process.env.SCREENCAST_HOME = home;

let answer: ElicitResult = { action: "accept", content: {} };
const asked: string[] = [];
let client: Client;

beforeAll(async () => {
  const { createServer } = await import("../server.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "arm-test", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push(req.params.message);
    return answer;
  });
  await client.connect(b);
});
afterEach(() => {
  answer = { action: "accept", content: {} };
  asked.length = 0;
  screenText = "";
});
afterAll(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  return {
    isError: res.isError === true,
    text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
    data: res.structuredContent as Record<string, unknown> | undefined,
  };
}

const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe("start_recording startWhen (#349)", () => {
  it("needs a window or text", async () => {
    const r = await call("start_recording", { target: "full", startWhen: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("startWhen needs window and/or text.");
    expect(asked).toEqual([]);
  });

  it("asks once at arm time, and the start it fires is not asked again", async () => {
    const { getArm } = await import("../utils/triggers.js");
    const { getStore } = await import("../context.js");
    const r = await call("start_recording", { target: "full", startWhen: { window: "window:Build" } });
    expect(r.isError, r.text).toBe(false);
    const armId = r.data!.sessionId as string;
    expect(armId.startsWith("arm-")).toBe(true);
    expect(r.data).toMatchObject({ status: "armed", outputPath: "" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^When .*start recording/);

    await until(() => getArm(armId)?.status === "started" || getArm(armId)?.status === "failed");
    const arm = getArm(armId)!;
    expect(arm.error).toBeUndefined();
    expect(arm.status).toBe("started");
    expect(getStore().get(arm.sessionId!)?.status).toBe("recording");
    expect(asked).toHaveLength(1);

    // Stop it through the arm id; the session it made is the one stopped.
    const stopped = await call("stop_recording", { sessionId: armId });
    expect(stopped.isError, stopped.text).toBe(false);
    expect(stopped.data).toMatchObject({ sessionId: arm.sessionId, status: "stopped" });
  });

  it("does not carry the approval to a later plain start", async () => {
    answer = { action: "decline" };
    const r = await call("start_recording", { target: "full" });
    expect(r.isError).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("registers no arm when consent is declined", async () => {
    const { listArms } = await import("../utils/triggers.js");
    const before = listArms().length;
    answer = { action: "decline" };
    const r = await call("start_recording", { target: "full", startWhen: { window: "window:Build" } });
    expect(r.isError).toBe(true);
    expect(listArms()).toHaveLength(before);
  });

  it("a start that fails when fired is the arm's error", async () => {
    const { getArm } = await import("../utils/triggers.js");
    // wgc records one window, so a full-screen start is refused when it fires.
    const r = await call("start_recording", { target: "full", backend: "wgc", startWhen: { window: "window:Build" } });
    expect(r.isError, r.text).toBe(false);
    const armId = r.data!.sessionId as string;
    await until(() => getArm(armId)?.status === "failed");
    expect(getArm(armId)).toMatchObject({ status: "failed" });
    expect(getArm(armId)!.error).toContain("records one window");
  });
});

describe("start_recording stopWhen (#349)", () => {
  it("stops the session once the text shows", async () => {
    const { getStore } = await import("../context.js");
    screenText = "All tests passed";
    const r = await call("start_recording", { target: "full", stopWhen: { text: "tests passed" } });
    expect(r.isError, r.text).toBe(false);
    const id = r.data!.sessionId as string;
    await until(() => getStore().get(id)?.status === "stopped");
    expect(getStore().get(id)?.status).toBe("stopped");
  });
});
