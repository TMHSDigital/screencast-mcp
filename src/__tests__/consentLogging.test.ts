/**
 * #222: opt-in capture consent through MCP elicitation, and ffmpeg warnings
 * as MCP log messages. Driven through real Clients over the in-memory
 * transport; monitors, windows, and the still capture are faked, so no
 * desktop or ffmpeg is needed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  LoggingMessageNotificationSchema,
  type ElicitResult,
  type LoggingMessageNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { Monitor } from "../utils/monitors.js";
import type { WindowQuery } from "../utils/windows.js";
import { CONFIRM_CAPTURE_ENV, confirmCaptureEnabled, describeTarget } from "../utils/consent.js";
import { DROP_REPORT_INTERVAL_MS, ffmpegWarnings, logMessage, StderrWatch } from "../utils/logging.js";

const MONITORS: Monitor[] = [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true }];
const DESKTOP: WindowQuery = {
  virtual: { x: 0, y: 0, w: 1920, h: 1080 },
  windows: [
    { title: "notes.txt - Editor", left: 100, top: 100, right: 900, bottom: 700, minimized: false, hwnd: 101, exe: "editor.exe" },
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
// A spawn of the fake path would fail loudly: a declined capture never gets that far.
vi.mock("../utils/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg-not-called", ffprobe: "ffprobe-not-called" }),
  wgcAvailable: () => true,
}));
const captureStill = vi.fn(async () => {});
vi.mock("../utils/still.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/still.js")>()),
  captureStill: (...args: unknown[]) => captureStill(...(args as [])),
}));

const home = mkdtempSync(join(tmpdir(), "sc-consent-"));
process.env.SCREENCAST_HOME = home;

/** What the elicitation-capable client answers, and what it was asked. */
let answer: ElicitResult = { action: "accept", content: {} };
const asked: string[] = [];
const logs: LoggingMessageNotification["params"][] = [];
let asker: Client;
let plain: Client;

async function connect(client: Client): Promise<Client> {
  const { createServer } = await import("../server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  await client.connect(clientSide);
  return client;
}

beforeAll(async () => {
  asker = new Client({ name: "asker", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  asker.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push(req.params.message);
    return answer;
  });
  asker.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(n.params);
  });
  await connect(asker);
  plain = await connect(new Client({ name: "plain", version: "0.0.0" }));
});
afterEach(() => {
  delete process.env[CONFIRM_CAPTURE_ENV];
  answer = { action: "accept", content: {} };
  asked.length = 0;
  logs.length = 0;
  captureStill.mockClear();
});
afterAll(async () => {
  await asker?.close();
  await plain?.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { isError: res.isError === true, text };
}

const SHOT = { target: "window:notes", returnImage: false };

describe("capture consent (#222)", () => {
  it("reads the opt-in setting", () => {
    expect(confirmCaptureEnabled({})).toBe(false);
    expect(confirmCaptureEnabled({ [CONFIRM_CAPTURE_ENV]: "0" })).toBe(false);
    for (const v of ["1", "true", "YES", " on "]) expect(confirmCaptureEnabled({ [CONFIRM_CAPTURE_ENV]: v })).toBe(true);
    expect(describeTarget("full")).toMatch(/full screen/);
    expect(describeTarget("window:no", { matchedTitle: "notes.txt - Editor" })).toBe('window "notes.txt - Editor"');
  });

  it("captures without asking when the setting is off", async () => {
    const res = await call(asker, "screenshot", SHOT);
    expect(res.isError).toBe(false);
    expect(asked).toEqual([]);
    expect(captureStill).toHaveBeenCalledTimes(1);
  });

  it("asks first, naming the matched window, and captures on accept", async () => {
    process.env[CONFIRM_CAPTURE_ENV] = "1";
    const res = await call(asker, "screenshot", SHOT);
    expect(res.isError).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Take a screenshot of window "notes\.txt - Editor"/);
    expect(captureStill).toHaveBeenCalledTimes(1);
  });

  it("captures nothing when the user declines or cancels", async () => {
    process.env[CONFIRM_CAPTURE_ENV] = "1";
    answer = { action: "decline" };
    let res = await call(asker, "screenshot", SHOT);
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toMatch(/declined by the user\. Nothing was captured/);
    answer = { action: "cancel" };
    res = await call(asker, "find_text", { target: "region:0,0,200,100" });
    expect(res.text).toMatch(/cancelled by the user/);
    expect(captureStill).not.toHaveBeenCalled();
  });

  it("shows a recording's target, duration, and audio before it starts", async () => {
    process.env[CONFIRM_CAPTURE_ENV] = "1";
    answer = { action: "decline" };
    const res = await call(asker, "start_recording", { target: "region:0,0,640,480", maxDurationSec: 60, events: true });
    expect(res.text).toMatch(/declined/);
    expect(asked[0]).toMatch(/^Record region:0,0,640,480 for up to 60 s, without audio, logging mouse clicks and typing, saved to .*\.mp4\?$/);
  });

  it("asks before wait_for_change starts watching", async () => {
    process.env[CONFIRM_CAPTURE_ENV] = "1";
    answer = { action: "decline" };
    const res = await call(asker, "wait_for_change", { target: "full", mode: "settle", timeoutSec: 5 });
    expect(res.text).toMatch(/declined/);
    expect(asked[0]).toBe("Watch the full screen (all monitors) for up to 5 s, until it stops changing?");
  });

  it("fails closed in a client without elicitation", async () => {
    process.env[CONFIRM_CAPTURE_ENV] = "1";
    const res = await call(plain, "screenshot", SHOT);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not support MCP elicitation\. Nothing was captured/);
    expect(res.text).toMatch(/unset SCREENCAST_CONFIRM_CAPTURE/);
    expect(captureStill).not.toHaveBeenCalled();
  });
});

describe("log messages (#222)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("declares the logging capability and sends warnings, honoring logging/setLevel", async () => {
    expect(asker.getServerCapabilities()?.logging).toBeDefined();
    logMessage("warning", "Recording rec-1 dropped 3 frames.", { sessionId: "rec-1" });
    await flush();
    expect(logs).toContainEqual({
      level: "warning",
      logger: "screencast-mcp",
      data: { message: "Recording rec-1 dropped 3 frames.", sessionId: "rec-1" },
    });

    logs.length = 0;
    await asker.setLoggingLevel("error");
    logMessage("warning", "filtered out");
    logMessage("error", "still sent");
    await flush();
    expect(logs.map((l) => (l.data as { message: string }).message)).toEqual(["still sent"]);
    await asker.setLoggingLevel("debug");
  });

  it("picks warning lines out of ffmpeg's stderr", () => {
    const stderr = [
      "ffmpeg version 8.0 Copyright (c) 2000-2025 the FFmpeg developers",
      "  configuration: --enable-gpl --disable-w32threads",
      "Input #0, gdigrab, from 'desktop':",
      "[swscaler @ 0x1] deprecated pixel format used, make sure you did set range correctly",
      "[dshow @ 0x2] real-time buffer [virtual-audio-capturer] [audio input] too full or near too full (101% of size: 3041280 [rtbufsize parameter])! frame dropped!",
      "frame=   50 fps= 10 q=23.0 size=     256KiB time=00:00:05.00 bitrate= 419.4kbits/s drop=2 speed=1x",
      "[aac @ 0x3] Too many bits 8832 > 6144 per frame requested, clamping to max",
      "[mp4 @ 0x4] Non-monotonic DTS; previous: 10, current: 9; changing to 11.",
      "[mp4 @ 0x4] Non-monotonic DTS; previous: 10, current: 9; changing to 11.",
    ].join("\r\n");
    expect(ffmpegWarnings(stderr)).toEqual([
      "[dshow @ 0x2] real-time buffer [virtual-audio-capturer] [audio input] too full or near too full (101% of size: 3041280 [rtbufsize parameter])! frame dropped!",
      "[mp4 @ 0x4] Non-monotonic DTS; previous: 10, current: 9; changing to 11.",
    ]);
  });

  it("watches a running capture: each warning once, dropped frames throttled", () => {
    const sent: Array<[string, string, Record<string, unknown>]> = [];
    let now = 0;
    const watch = new StderrWatch(() => ({ sessionId: "rec-9" }), (level, message, data = {}) => {
      sent.push([level, message, data]);
    }, () => now);
    // Stats lines end in \r; chunks split lines anywhere.
    watch.feed("frame=   10 fps=10 drop=0 speed=1x\rframe=   20 fps=10 dr");
    watch.feed("op=1 speed=1x\r[dshow @ 0x1] real-time buffer too full! frame dropped!\n");
    now += 1000;
    watch.feed("frame=   30 fps=10 drop=4 speed=1x\r[dshow @ 0x1] real-time buffer too full! frame dropped!\n");
    now += DROP_REPORT_INTERVAL_MS;
    watch.feed("frame=   40 fps=10 drop=4 speed=1x\r");
    watch.feed("frame=   50 fps=10 drop=7 speed=1x\r");
    expect(sent).toEqual([
      ["warning", "The recording has dropped 1 frame(s) so far.", { sessionId: "rec-9", dropped: 1 }],
      ["warning", "[dshow @ 0x1] real-time buffer too full! frame dropped!", { sessionId: "rec-9", source: "ffmpeg" }],
      ["warning", "The recording has dropped 4 frame(s) so far.", { sessionId: "rec-9", dropped: 4 }],
    ]);
  });
});
