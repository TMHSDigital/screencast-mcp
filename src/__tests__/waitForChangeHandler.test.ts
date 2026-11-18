/**
 * wait_for_change through the MCP handler (#350): argument checks, the wgc
 * size probe, text mode, the final screenshot, and that the work folder is
 * removed on every path. Capture, OCR and ffmpeg are faked, so this runs
 * anywhere and never touches the screen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ResolvedTarget } from "../utils/resolveTarget.js";
import type { ReadFrame } from "../utils/ocrScan.js";
import { detectionSize } from "../utils/diff.js";

const MONITORS = [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true }];
const REGION: ResolvedTarget = { target: { kind: "region", x: 0, y: 0, w: 64, h: 64 }, monitors: MONITORS };
const SIZE = detectionSize(64, 64);
const BYTES = SIZE.width * SIZE.height;

let resolved: ResolvedTarget = REGION;
let probedSize = { width: 0, height: 0 };
/** The frames the fake capture stream delivers, then it fails with `streamError` or waits to be stopped. */
let streamFrames: Buffer[] = [];
let streamError: Error | null = null;
let ocrFrames: ReadFrame[] = [];
let ocrCalls = 0;

const png = (path: string) => writeFileSync(path, "png");

vi.mock("../utils/resolveTarget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/resolveTarget.js")>()),
  resolveCaptureTarget: async () => resolved,
}));
vi.mock("../utils/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
  probeMedia: async () => ({ ...probedSize, durationSec: null, fps: null, videoCodec: "png", audioCodec: null }),
  runFfmpeg: async (args: string[]) => png(args[args.length - 1]!),
  runFfmpegBuffer: async () => Buffer.alloc(BYTES),
  runFfmpegFrames: async (_args: string[], _bytes: number, onFrame: (f: Buffer) => void, _t: number, o: { signal: AbortSignal }) => {
    for (const f of streamFrames) {
      await new Promise((r) => setTimeout(r, 5));
      onFrame(f);
    }
    if (streamError) throw streamError;
    await new Promise<void>((r) => (o.signal.aborted ? r() : o.signal.addEventListener("abort", () => r())));
  },
}));
vi.mock("../utils/still.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/still.js")>()),
  captureStill: async (_r: unknown, output: string) => png(output),
}));
vi.mock("../utils/ocrScan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ocrScan.js")>()),
  readFrames: async () => (ocrCalls++, ocrFrames),
}));
vi.mock("../utils/images.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/images.js")>()),
  encodeInlineImages: async () => ({ images: [{ type: "image", data: "eA==", mimeType: "image/png" }] }),
}));

const home = mkdtempSync(join(tmpdir(), "sc-wait-"));
process.env.SCREENCAST_HOME = home;
let client: Client;

beforeAll(async () => {
  const { createServer } = await import("../server.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "wait-test", version: "0" });
  await client.connect(b);
});
afterAll(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  resolved = REGION;
  probedSize = { width: 0, height: 0 };
  streamFrames = [];
  streamError = null;
  ocrFrames = [];
  ocrCalls = 0;
});

/** screencast-wait-* entries in the temp folder: work folders and unkept shots. */
const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("screencast-wait-"));

async function call(args: Record<string, unknown>) {
  const res = await client.callTool({ name: "wait_for_change", arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  return {
    isError: res.isError === true,
    text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
    images: content.filter((c) => c.type === "image").length,
    data: res.structuredContent as Record<string, unknown> | undefined,
  };
}

/** A line of OCR text covering the top-left of the frame. */
const line = (text: string) => ({ text, x: 0, y: 0, width: 40, height: 10, words: [{ text, x: 0, y: 0, width: 40, height: 10 }] });

describe("wait_for_change handler (#350)", () => {
  it("pairs text with mode text, both ways", async () => {
    for (const args of [{ target: "full", mode: "text" }, { target: "full", text: "Saved" }]) {
      const r = await call(args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Use text with mode "text", and mode "text" with text.');
    }
  });

  it("refuses wgc without a window target", async () => {
    const r = await call({ target: "full", backend: "wgc" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("watches one window");
  });

  it("refuses a wgc window whose first still has no size, and leaves no work folder", async () => {
    resolved = {
      target: { kind: "region", x: 0, y: 0, w: 64, h: 64 },
      monitors: MONITORS,
      window: { hwnd: 7, title: "App", x: 0, y: 0, width: 64, height: 64, client: { x: 0, y: 0, width: 64, height: 64 } } as unknown as ResolvedTarget["window"],
    };
    const before = leftovers();
    const r = await call({ target: "window:App", backend: "wgc" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Could not read the window capture's size.");
    expect(leftovers()).toEqual(before);
  });

  it("returns changed once a frame differs, and removes the unkept screenshot", async () => {
    streamFrames = [Buffer.alloc(BYTES, 0), Buffer.alloc(BYTES, 0), Buffer.alloc(BYTES, 255)];
    const before = leftovers();
    const r = await call({ target: "region:0,0,64,64", intervalMs: 100, timeoutSec: 5 });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ outcome: "changed", mode: "change", origin: { x: 0, y: 0 } });
    expect((r.data!.regions as unknown[]).length).toBeGreaterThan(0);
    expect(r.data!.screenshotPath).toBeUndefined();
    expect(r.images).toBe(1);
    expect(leftovers()).toEqual(before);
  });

  it("keep: true leaves the final screenshot under SCREENCAST_HOME and returns its path", async () => {
    streamFrames = [Buffer.alloc(BYTES, 0), Buffer.alloc(BYTES, 255)];
    const r = await call({ target: "region:0,0,64,64", intervalMs: 100, timeoutSec: 5, keep: true });
    expect(r.isError, r.text).toBe(false);
    const shot = r.data!.screenshotPath as string;
    expect(shot.startsWith(join(home, "screenshots"))).toBe(true);
    expect(statSync(shot).isFile()).toBe(true);
  });

  it("returnImage: false takes no final screenshot", async () => {
    streamFrames = [Buffer.alloc(BYTES, 0), Buffer.alloc(BYTES, 255)];
    const r = await call({ target: "region:0,0,64,64", intervalMs: 100, timeoutSec: 5, returnImage: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.images).toBe(0);
  });

  it("text mode: matched once OCR finds the text, with its matches", async () => {
    streamFrames = [Buffer.alloc(BYTES, 0)];
    ocrFrames = [{ lines: [line("Build succeeded")], width: 64, height: 64 }];
    const r = await call({ target: "region:0,0,64,64", mode: "text", text: "succeeded", intervalMs: 100, timeoutSec: 5, returnImage: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ outcome: "matched", mode: "text", text: "succeeded" });
    expect((r.data!.matches as unknown[]).length).toBe(1);
    expect(r.data!.ocrReads).toBeGreaterThan(0);
    expect(r.data!.gone).toBeUndefined();
  });

  it("text mode with gone: matched once the text is not there, and says gone", async () => {
    streamFrames = [Buffer.alloc(BYTES, 0)];
    ocrFrames = [{ lines: [line("Other")], width: 64, height: 64 }];
    const r = await call({ target: "region:0,0,64,64", mode: "text", text: "Loading", gone: true, intervalMs: 100, timeoutSec: 5, returnImage: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ outcome: "matched", gone: true, matches: [] });
    expect(ocrCalls).toBeGreaterThan(0);
  });

  it("a capture that fails mid-wait is an error, and the work folder is removed", async () => {
    streamFrames = [Buffer.alloc(BYTES, 0)];
    streamError = new Error("gdigrab: the device went away");
    const before = leftovers();
    const r = await call({ target: "region:0,0,64,64", intervalMs: 100, timeoutSec: 5 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("the device went away");
    expect(leftovers()).toEqual(before);
  });
});
