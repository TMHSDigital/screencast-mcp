/** list_sessions filters, limit and summary mode (#366). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = mkdtempSync(join(tmpdir(), "sc-listsess-"));
process.env.SCREENCAST_HOME = home;
const { createServer } = await import("../server.js");
const { getStore } = await import("../context.js");

type Status = "recording" | "paused" | "stopped" | "failed" | "orphaned";
const rec = (id: string, status: Status, minute: number) => ({
  id, target: "full", outputPath: join(home, `${id}.mp4`), fps: 30, quality: "standard" as const, pid: null, status,
  startedAt: `2026-11-17T10:${String(minute).padStart(2, "0")}:00.000Z`,
  segments: { parts: [{ path: join(home, `${id}.mp4`), startMs: 1, durationSec: 2 }] },
  ...(status === "failed" ? { error: "ffmpeg exited with code 1:\nline 2" } : {}),
});

describe("list_sessions (#366)", () => {
  let client: Client;
  const list = async (args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: "list_sessions", arguments: args });
    return res.structuredContent as { count: number; total?: number; sessions: Array<Record<string, unknown>> };
  };

  beforeAll(async () => {
    const store = getStore();
    store.create(rec("a", "stopped", 1));
    store.create(rec("b", "failed", 2));
    store.create(rec("c", "stopped", 3));
    store.create(rec("d", "paused", 4));
    store.create({ ...rec("e", "stopped", 0), label: "Checkout flow" });
    store.create({ ...rec("f", "paused", 0), serverPid: process.pid });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await createServer().connect(x);
    client = new Client({ name: "c", version: "0" });
    await client.connect(y);
  });
  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns a summary of each session, newest first", async () => {
    const r = await list();
    expect(r.sessions.map((s) => s.id)).toEqual(["d", "c", "b", "a", "e", "f"]);
    expect(r.total).toBeUndefined();
    expect(r.sessions[0]).not.toHaveProperty("segments");
    expect(r.sessions.find((s) => s.id === "b")?.error).toBe("ffmpeg exited with code 1:");
  });

  it("filters by status, limits, and gives whole records when asked", async () => {
    const stopped = await list({ status: ["stopped"] });
    expect(stopped.sessions.map((s) => s.id)).toEqual(["c", "a", "e"]);
    expect(stopped.total).toBe(6);
    const one = await list({ limit: 1, full: true });
    expect(one.sessions).toHaveLength(1);
    expect(one.sessions[0]).toHaveProperty("segments");
    expect(one.sessions[0]?.id).toBe("d");
  });

  it("matches a query against label, id, target and path, and shows the label (#366)", async () => {
    const r = await list({ query: "checkout" });
    expect(r.sessions.map((s) => s.id)).toEqual(["e"]);
    expect(r.sessions[0]?.label).toBe("Checkout flow");
    expect((await list({ query: "B.MP4" })).sessions.map((s) => s.id)).toEqual(["b"]);
  });

  it("a paused session is alive while its server is (#366)", async () => {
    const r = await list({ status: ["paused"] });
    expect(Object.fromEntries(r.sessions.map((s) => [s.id, s.alive]))).toEqual({ d: false, f: true });
  });
});
