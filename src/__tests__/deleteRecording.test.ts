/** delete_recording (#321): the file, its sidecars and registry entries. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = mkdtempSync(join(tmpdir(), "sc-delete-"));
process.env.SCREENCAST_HOME = home;
const { createServer } = await import("../server.js");
const { getStore } = await import("../context.js");
const { recordingSidecars } = await import("../utils/recordingFiles.js");

const rec = (id: string, outputPath: string, status: "stopped" | "recording" = "stopped") => ({
  id, target: "full", outputPath, fps: 30, quality: "standard" as const, pid: null, status, startedAt: new Date().toISOString(),
});

describe("recordingSidecars (#321)", () => {
  it("lists every sidecar and leaves a transcript another video may own", () => {
    const v = join("C:", "r", "demo.mp4");
    const own = recordingSidecars(v, ["demo.mp4", "demo.srt"], join("C:", "e"));
    expect(own.files).toEqual(expect.arrayContaining([
      join("C:", "r", "demo.events.jsonl"), join("C:", "r", "demo.events.raw"), join("C:", "r", "demo.webcam.mp4"),
      `${v}.index.json`, join("C:", "r", "demo.markers.json"), `${v}.stop`, join("C:", "r", "demo.srt"),
    ]));
    expect(own.files).not.toContain(v);
    expect(own.dirs).toEqual([`${v}.parts`]);
    const shared = recordingSidecars(v, ["demo.mp4", "demo.mkv", "demo.srt"], join("C:", "e"));
    expect(shared.files).not.toContain(join("C:", "r", "demo.srt"));
  });
});

describe("delete_recording (#321)", () => {
  let client: Client;
  const dir = join(home, "recordings");
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "delete_recording", arguments: args });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isError: res.isError ?? false, text, data: res.structuredContent as Record<string, unknown> | undefined };
  };

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    client = new Client({ name: "c", version: "0" });
    await client.connect(b);
  });
  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("deletes the recording, its sidecars and its registry entry", async () => {
    const v = join(dir, "a.mp4");
    writeFileSync(v, Buffer.alloc(1000));
    writeFileSync(join(dir, "a.events.jsonl"), "{}\n");
    writeFileSync(`${v}.index.json`, "{}");
    mkdirSync(`${v}.parts`);
    writeFileSync(join(`${v}.parts`, "part1.mp4"), Buffer.alloc(500));
    writeFileSync(join(dir, "keep.mp4"), "x");
    getStore().create(rec("rec-a", v));

    const r = await call({ sessionId: "rec-a" });
    expect(r.isError, r.text).toBe(false);
    expect(r.data?.bytesFreed).toBe(1000 + 3 + 2 + 500);
    expect(r.data?.sessionsRemoved).toEqual(["rec-a"]);
    for (const p of [v, join(dir, "a.events.jsonl"), `${v}.index.json`, `${v}.parts`]) expect(existsSync(p)).toBe(false);
    expect(existsSync(join(dir, "keep.mp4"))).toBe(true);
    expect(getStore().get("rec-a")).toBeUndefined();
  });

  it("refuses a recording that is still running", async () => {
    const v = join(dir, "live.mp4");
    writeFileSync(v, "x");
    getStore().create(rec("rec-live", v, "recording"));
    const r = await call({ input: v });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/still recording/);
    expect(existsSync(v)).toBe(true);
  });

  it("refuses a file outside SCREENCAST_HOME when no other folder is allowed", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sc-outside-"));
    try {
      const v = join(outside, "b.mp4");
      writeFileSync(v, "x");
      const r = await call({ input: v });
      expect(r.isError).toBe(true);
      expect(existsSync(v)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("needs exactly one of sessionId or input", async () => {
    expect((await call({})).isError).toBe(true);
    expect((await call({ sessionId: "x", input: "y.mp4" })).isError).toBe(true);
  });
});
