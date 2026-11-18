/**
 * stop_recording, pause_recording and resume_recording through the MCP
 * handler (#348): the branches of their own that only a live capture used to
 * reach. Sessions are seeded in a temporary store and nothing is captured.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SessionRecord } from "../utils/sessions.js";

const spawned: string[][] = [];
const killed: number[] = [];
/** ownerAlive's answer, for the foreign-owner case. */
let ownerIsAlive = false;
let resumeCap = 0;

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: (_cmd: string, args: string[]) => {
    spawned.push(args);
    throw new Error("nothing should be spawned");
  },
}));
vi.mock("../utils/ffmpeg.js", async (orig) => ({
  ...(await orig<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
  probeDuration: async () => 4.2,
  runCapture: async () => ({ code: 1, stdout: "", stderr: "fake ffmpeg failed" }),
}));
vi.mock("../utils/sessions.js", async (orig) => ({
  ...(await orig<typeof import("../utils/sessions.js")>()),
  ownerAlive: () => ownerIsAlive,
  killPid: (pid: number) => void killed.push(pid),
}));
vi.mock("../utils/recorder.js", async (orig) => ({
  ...(await orig<typeof import("../utils/recorder.js")>()),
  resumeSession: async (_store: unknown, record: SessionRecord) => ({ recordedSec: 3, record: { ...record, pid: 99 }, capSec: resumeCap }),
}));

const home = mkdtempSync(join(tmpdir(), "sc-ctl-"));
process.env.SCREENCAST_HOME = home;
let client: Client;
let n = 0;

beforeAll(async () => {
  const { createServer } = await import("../server.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "ctl-test", version: "0" });
  await client.connect(b);
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

/** Seed a session in the server's store. */
async function seed(over: Partial<SessionRecord> = {}): Promise<SessionRecord> {
  const { getStore } = await import("../context.js");
  const outputPath = join(home, `ctl-${++n}.mp4`);
  writeFileSync(outputPath, "mp4 bytes");
  const record: SessionRecord = {
    id: `ctl-${n}-${Math.random().toString(36).slice(2, 8)}`,
    target: "region:0,0,640,480",
    outputPath,
    fps: 30,
    quality: "standard",
    pid: null,
    status: "stopped",
    startedAt: new Date().toISOString(),
    backend: "gdigrab",
    durationSec: 3,
    ...over,
  };
  getStore().create(record);
  return record;
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("stop_recording on an armed recording (#348)", () => {
  it("disarms one that is still waiting", async () => {
    const { armStart, getArm } = await import("../utils/triggers.js");
    const arm = armStart({ conditions: { text: "Never" }, target: "full", timeoutSec: 60, checks: [async () => false], fire: async () => "x", intervalMs: 5 });
    const r = await call("stop_recording", { sessionId: arm.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ sessionId: arm.id, status: "cancelled", note: "Disarmed; nothing was recorded.", outputPath: "", durationSec: null });
    expect(getArm(arm.id)?.status).toBe("cancelled");
  });

  it("refuses an arm id it does not know", async () => {
    const r = await call("stop_recording", { sessionId: "arm-nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No armed recording with id "arm-nope".');
  });

  it("reports an arm whose start failed", async () => {
    const { armStart, getArm } = await import("../utils/triggers.js");
    const arm = armStart({ conditions: { text: "x" }, target: "full", timeoutSec: 5, checks: [async () => true], fire: async () => { throw new Error("no ffmpeg"); }, intervalMs: 1 });
    await until(() => getArm(arm.id)?.status === "failed");
    const r = await call("stop_recording", { sessionId: arm.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ status: "failed", error: "no ffmpeg" });
  });

  it("stops the session an arm started", async () => {
    const { armStart, getArm } = await import("../utils/triggers.js");
    const rec = await seed({ endReason: "max_duration", maxDurationSec: 60 });
    const arm = armStart({ conditions: { text: "x" }, target: "full", timeoutSec: 5, checks: [async () => true], fire: async () => rec.id, intervalMs: 1 });
    await until(() => getArm(arm.id)?.status === "started");
    const r = await call("stop_recording", { sessionId: arm.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ sessionId: rec.id, status: "stopped", outputPath: rec.outputPath });
  });
});

describe("stop_recording on a session that already ended (#348)", () => {
  it("says why it ended, and kills nothing", async () => {
    const notes: Record<string, string> = {
      max_duration: "Recording already ended at its maxDurationSec cap (60s).",
      window_closed: "Recording already ended: the recorded window was closed.",
      none: "Session was not active; returning its recorded final state.",
    };
    for (const [reason, note] of Object.entries(notes)) {
      const rec = await seed({ maxDurationSec: 60, ...(reason === "none" ? {} : { endReason: reason as SessionRecord["endReason"] }) });
      const r = await call("stop_recording", { sessionId: rec.id });
      expect(r.isError, r.text).toBe(false);
      expect(r.data).toMatchObject({ status: "stopped", durationSec: 3, endReason: reason === "none" ? null : reason, note });
    }
    expect(killed).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it("probes the length when the exit handler has not yet", async () => {
    const rec = await seed({ durationSec: undefined });
    const r = await call("stop_recording", { sessionId: rec.id });
    expect(r.data).toMatchObject({ durationSec: 4.2 });
  });

  it("discards a leftover replay buffer, or reports a save that failed and keeps it", async () => {
    const replayRec = async () => {
      const dir = join(home, `buf-${++n}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "seg-000.ts"), "");
      return { dir, rec: await seed({ replay: { dir, bufferSec: 30, segmentSec: 2, wrap: 17 } }) };
    };
    const a = await replayRec();
    const discarded = await call("stop_recording", { sessionId: a.rec.id });
    expect(discarded.isError, discarded.text).toBe(false);
    expect(discarded.data!.replay).toMatchObject({ saved: false, discarded: true });
    expect(existsSync(a.dir)).toBe(false);

    const b = await replayRec();
    const failed = await call("stop_recording", { sessionId: b.rec.id, save: true });
    expect(failed.isError, failed.text).toBe(false);
    expect(failed.data!.replay).toMatchObject({ saved: false, discarded: false });
    expect((failed.data!.replay as { error?: string }).error).toBeTruthy();
    expect(existsSync(b.dir)).toBe(true);
  });

  it("refuses an unknown session", async () => {
    const r = await call("stop_recording", { sessionId: "rec-missing" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No session with id "rec-missing".');
  });
});

describe("stop_recording on another instance's live capture (#286, #348)", () => {
  it("refuses, and does not kill it", async () => {
    ownerIsAlive = true;
    try {
      const rec = await seed({ status: "recording", pid: 31337, serverPid: process.pid + 100000, durationSec: undefined });
      const r = await call("stop_recording", { sessionId: rec.id });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`belongs to another running screencast-mcp instance (pid ${process.pid + 100000})`);
      expect(killed).toEqual([]);
      const { getStore } = await import("../context.js");
      expect(getStore().get(rec.id)?.status).toBe("recording");
    } finally {
      ownerIsAlive = false;
    }
  });
});

describe("pause_recording and resume_recording short-circuits (#348)", () => {
  it("pause: already paused, and an unknown id", async () => {
    const rec = await seed({ status: "paused", segments: { parts: [{ path: "p1.mp4", startMs: 0, durationSec: 2.5 }] } });
    const r = await call("pause_recording", { sessionId: rec.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ sessionId: rec.id, status: "paused", recordedSec: 2.5, note: "Already paused." });
    const missing = await call("pause_recording", { sessionId: "rec-missing" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('No session with id "rec-missing".');
  });

  it("resume: already recording", async () => {
    const rec = await seed({ status: "recording", pid: null, serverPid: process.pid });
    const r = await call("resume_recording", { sessionId: rec.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ status: "recording", recordedSec: 0, note: "Already recording." });
  });

  it("resume: remainingSec only when the session has a cap", async () => {
    for (const cap of [0, 42]) {
      resumeCap = cap;
      const rec = await seed({ status: "paused", serverPid: process.pid, segments: { parts: [{ path: "p.mp4", startMs: 0, durationSec: 3 }] } });
      const r = await call("resume_recording", { sessionId: rec.id });
      expect(r.isError, r.text).toBe(false);
      expect(r.data).toMatchObject({ status: "recording", recordedSec: 3, pid: 99 });
      if (cap > 0) expect(r.data!.remainingSec).toBe(42);
      else expect(r.data!.remainingSec).toBeUndefined();
    }
  });
});
