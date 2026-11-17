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

  it("never deletes a folder, an allowed root, or a file that is not a video", async () => {
    const allowed = mkdtempSync(join(tmpdir(), "sc-allowed-"));
    process.env.SCREENCAST_ALLOWED_DIRS = allowed;
    try {
      writeFileSync(join(allowed, "src.ts"), "code");
      mkdirSync(join(allowed, "x.mp4"));
      writeFileSync(join(allowed, "x.mp4", "inner.txt"), "y");
      for (const input of [allowed, home, join(allowed, "src.ts"), join(dir, "notes.txt"), join(allowed, "x.mp4")]) {
        if (input.endsWith("notes.txt")) writeFileSync(input, "n");
        const r = await call({ input });
        expect(r.isError, `${input}: ${r.text}`).toBe(true);
        expect(existsSync(input)).toBe(true);
      }
      expect(existsSync(join(allowed, "x.mp4", "inner.txt"))).toBe(true);
    } finally {
      delete process.env.SCREENCAST_ALLOWED_DIRS;
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  it("needs a confirmation or a session for a video outside SCREENCAST_HOME", async () => {
    const allowed = mkdtempSync(join(tmpdir(), "sc-allowed-"));
    process.env.SCREENCAST_ALLOWED_DIRS = allowed;
    try {
      const v = join(allowed, "c.mp4");
      writeFileSync(v, "x");
      const r = await call({ input: v });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/cannot ask you to confirm/);
      expect(existsSync(v)).toBe(true);
      getStore().create(rec("rec-c", v));
      const ok = await call({ input: v });
      expect(ok.isError, ok.text).toBe(false);
      expect(existsSync(v)).toBe(false);
    } finally {
      delete process.env.SCREENCAST_ALLOWED_DIRS;
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  it("leaves a folder that has a sidecar's name", async () => {
    const v = join(dir, "d.mp4");
    writeFileSync(v, "x");
    mkdirSync(join(dir, "d.events.jsonl"));
    writeFileSync(join(dir, "d.events.jsonl", "keep.txt"), "k");
    const r = await call({ input: v });
    expect(r.isError, r.text).toBe(false);
    expect(existsSync(v)).toBe(false);
    expect(existsSync(join(dir, "d.events.jsonl", "keep.txt"))).toBe(true);
  });

  it("needs exactly one of sessionId or input", async () => {
    expect((await call({})).isError).toBe(true);
    expect((await call({ sessionId: "x", input: "y.mp4" })).isError).toBe(true);
  });
});

describe("delete_recording confirmation (#351)", () => {
  const dir = join(home, "recordings");
  let asker: Client;
  let answer: () => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, never> }> = async () => ({ action: "accept", content: {} });
  const asked: string[] = [];
  const call = async (args: Record<string, unknown>) => {
    const res = await asker.callTool({ name: "delete_recording", arguments: args });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isError: res.isError ?? false, text, data: res.structuredContent as Record<string, unknown> | undefined };
  };
  const make = (name: string) => {
    mkdirSync(dir, { recursive: true });
    const v = join(dir, name);
    writeFileSync(v, "x");
    writeFileSync(`${v}.index.json`, "{}");
    return v;
  };

  beforeAll(async () => {
    const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    asker = new Client({ name: "asker", version: "0" }, { capabilities: { elicitation: {} } });
    asker.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return answer();
    });
    await asker.connect(b);
  });
  afterAll(async () => {
    await asker.close();
  });

  it("deletes after the user accepts, and says so", async () => {
    answer = async () => ({ action: "accept", content: {} });
    const v = make("acc.mp4");
    const r = await call({ input: v });
    expect(r.isError, r.text).toBe(false);
    expect(r.data?.confirmedByUser).toBe(true);
    expect(asked.at(-1)).toMatch(/Delete .*acc\.mp4 and 1 sidecar/);
    expect(existsSync(v)).toBe(false);
  });

  it("keeps everything when the user declines or cancels", async () => {
    for (const action of ["decline", "cancel"] as const) {
      answer = async () => ({ action });
      const v = make(`${action}.mp4`);
      getStore().create(rec(`rec-${action}`, v));
      const r = await call({ input: v });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(action === "decline" ? /declined by the user/ : /cancelled by the user/);
      expect(existsSync(v)).toBe(true);
      expect(existsSync(`${v}.index.json`)).toBe(true);
      expect(getStore().get(`rec-${action}`)).toBeDefined();
    }
  });

  it("deletes nothing when the confirmation request itself fails", async () => {
    answer = async () => {
      throw new Error("client exploded");
    };
    const v = make("boom.mp4");
    const r = await call({ input: v });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/confirmation request failed/);
    expect(existsSync(v)).toBe(true);
  });

  it("says there is nothing to delete for a missing file with no session", async () => {
    answer = async () => ({ action: "accept", content: {} });
    const r = await call({ input: join(dir, "never.mp4") });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Nothing to delete/);
  });
});

describe("delete_recording without elicitation when confirmation is required (#351)", () => {
  it("refuses and deletes nothing", async () => {
    const { CONFIRM_CAPTURE_ENV } = await import("../utils/consent.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    const plain = new Client({ name: "plain", version: "0" });
    await plain.connect(b);
    const dir = join(home, "recordings");
    mkdirSync(dir, { recursive: true });
    const v = join(dir, "req.mp4");
    writeFileSync(v, "x");
    process.env[CONFIRM_CAPTURE_ENV] = "1";
    try {
      const res = await plain.callTool({ name: "delete_recording", arguments: { input: v } });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text?: string }>)[0]?.text).toMatch(new RegExp(CONFIRM_CAPTURE_ENV));
      expect(existsSync(v)).toBe(true);
    } finally {
      delete process.env[CONFIRM_CAPTURE_ENV];
      await plain.close();
    }
  });
});
