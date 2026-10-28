/**
 * The re-rendered cursor against real ffmpeg (#170): the sprite's tip lands on
 * the logged position, it hides after hideAfterSec, and in a pipeline it
 * follows an input-seek trim, a speed change and a scale, with a spotlight
 * dimming the rest of the frame.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks, runFfmpeg, runFfmpegBuffer } from "../../utils/ffmpeg.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);

const home = mkdtempSync(join(tmpdir(), "sc-cursor-it-"));
process.env.SCREENCAST_HOME = home;
const p = (name: string) => join(home, name);
const W = 320;
const H = 240;

/** One frame at `t` as gray bytes. */
const frameAt = (f: string, t: number, w = W, h = H) =>
  runFfmpegBuffer(["-v", "error", "-ss", String(t), "-i", f, "-frames:v", "1", "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"]);

/** Bounding box of pixels brighter than `min`, or null. */
function bright(buf: Buffer, w: number, min = 200): { x0: number; y0: number; x1: number; y1: number } | null {
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  buf.forEach((v, i) => {
    if (v < min) return;
    const x = i % w;
    const y = Math.floor(i / w);
    box = box
      ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) }
      : { x0: x, y0: y, x1: x, y1: y };
  });
  return box;
}

const move = (t: number, x: number, y: number) => JSON.stringify({ t, type: "move", x, y, inFrame: true });

describe.skipIf(!AVAILABLE)("cursor against real ffmpeg (#170)", { timeout: 300_000 }, () => {
  const black = p("black.mp4");
  const gray = p("gray.mp4");
  let client: Client;

  beforeAll(async () => {
    const make = (c: string, out: string) =>
      runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=${c}:s=${W}x${H}:r=10:d=4`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
    await make("black", black);
    await make("gray", gray);
    // At rest at (80,60) from 0.5 s, then at (200,150) from 1.5 s; nothing after.
    const log = `${move(0.5, 80, 60)}\n${move(1.5, 200, 150)}\n`;
    writeFileSync(p("black.events.jsonl"), log);
    writeFileSync(p("gray.events.jsonl"), log);
    const { createServer } = await import("../../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "cursor-it", version: "0.0.0" });
    await client.connect(clientSide);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("draws the cursor's tip on the logged position and hides it when idle", async () => {
    const out = p("cursor.mp4");
    const res = await client.callTool({ name: "cursor", arguments: { input: black, output: out, smoothing: 0, hideAfterSec: 1, clicks: false } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const sc = res.structuredContent as { segments: number; outputPath: string };
    expect(sc.outputPath).toBe(out);

    expect(bright(await frameAt(out, 0.2), W)).toBeNull(); // before any input
    const a = bright(await frameAt(out, 1.05), W);
    expect(a, "cursor at (80,60)").not.toBeNull();
    // The white fill starts just inside the tip (outline first; x is rounded to even).
    expect(a!.x0).toBeGreaterThanOrEqual(78);
    expect(a!.x0).toBeLessThanOrEqual(84);
    expect(a!.y0).toBeGreaterThanOrEqual(58);
    expect(a!.y0).toBeLessThanOrEqual(66);
    // About 1.5x a typical cursor at 240 px: the arrow is ~9 px tall.
    expect(a!.y1 - a!.y0).toBeGreaterThan(4);
    expect(a!.y1 - a!.y0).toBeLessThan(16);
    const b = bright(await frameAt(out, 2.05), W);
    expect(b!.x0).toBeGreaterThanOrEqual(198);
    expect(b!.x0).toBeLessThanOrEqual(204);
    expect(b!.y0).toBeGreaterThanOrEqual(148);
    expect(b!.y0).toBeLessThanOrEqual(156);
    expect(bright(await frameAt(out, 3.05), W)).toBeNull(); // hidden 1 s after the last move
  });

  it("follows a trim, speed change and scale in a pipeline, with a spotlight", async () => {
    const out = p("pipeline.mp4");
    const res = await client.callTool({
      name: "pipeline",
      arguments: {
        input: gray,
        output: out,
        steps: [
          { op: "trim", start: 1, end: 4 },
          { op: "speed", factor: 2 },
          { op: "scale", width: 640 },
          { op: "cursor", smoothing: 0, hideAfterSec: 0, spotlight: true },
        ],
      },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const sc = res.structuredContent as { steps: string[] };
    expect(sc.steps.at(-1)).toMatch(/^cursor \d+ segment/);
    // Source (200,150) from 1.5 s is (400,300) from 0.25 s after the trim, 2x speed and 2x scale.
    const f = await frameAt(out, 1, 640, 480);
    const box = bright(f, 640, 220);
    expect(box).not.toBeNull();
    expect(box!.x0).toBeGreaterThanOrEqual(398);
    expect(box!.x0).toBeLessThanOrEqual(406);
    expect(box!.y0).toBeGreaterThanOrEqual(298);
    expect(box!.y0).toBeLessThanOrEqual(308);
    // The spotlight dims the far corner and leaves the area by the cursor alone.
    expect(f[10 * 640 + 10]!).toBeLessThan(90);
    expect(f[(300 + 25) * 640 + 400 + 30]!).toBeGreaterThan(110);
    // Before the cursor first moved (source 0.5 s is cut by the trim) it shows from the start.
    const early = bright(await frameAt(out, 0.05, 640, 480), 640, 220);
    expect(early).not.toBeNull();
  });

  it("fails clearly without an event log", async () => {
    const lonely = p("lonely.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=10:d=1`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", lonely]);
    const res = await client.callTool({ name: "cursor", arguments: { input: lonely } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/No event log/);
  });
});
