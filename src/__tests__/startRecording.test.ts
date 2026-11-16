/**
 * start_recording's session bookkeeping, through the MCP handler (#192, #207):
 * if the session registry cannot be written, the capture that was just
 * started is killed rather than left running where nothing can stop it.
 * ffmpeg is faked with a child that stays alive, so this runs anywhere.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Monitor } from "../utils/monitors.js";

const FAKE_PID = 424242;
const spawned: string[][] = [];
const killed: number[] = [];
/** When set, the next capture exits at once (a bad device, a busy window). */
let exitAtOnce = false;

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (_cmd: string, args: string[]) => {
    spawned.push(args);
    // A capture that keeps running: it never exits on its own (unless told to).
    const child = Object.assign(new EventEmitter(), {
      pid: FAKE_PID,
      stdin: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    if (exitAtOnce) {
      setImmediate(() => {
        child.stderr.write("Could not open the capture device\n");
        Object.assign(child, { exitCode: 1 });
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
      });
    }
    return child;
  },
}));
vi.mock("../utils/monitors.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/monitors.js")>()),
  getMonitors: async (): Promise<Monitor[]> => [
    { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true },
  ],
}));
vi.mock("../utils/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
}));
vi.mock("../utils/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/sessions.js")>()),
  killPid: (pid: number) => void killed.push(pid),
}));

const home = mkdtempSync(join(tmpdir(), "sc-start-"));
process.env.SCREENCAST_HOME = home;
let client: Client;

beforeAll(async () => {
  const { createServer } = await import("../server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "start-test", version: "0.0.0" });
  await client.connect(clientSide);
});
afterAll(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("start_recording session registry failure (#207)", () => {
  it("kills the capture it started and reports the registry error", async () => {
    const { SessionStore } = await import("../utils/sessions.js");
    const { getStore } = await import("../context.js");
    const create = vi.spyOn(SessionStore.prototype, "create").mockImplementation(() => {
      throw new Error("EACCES: permission denied, open 'sessions.json'");
    });
    try {
      const res = await client.callTool({
        name: "start_recording",
        arguments: { target: "region:0,0,640,480", quality: "draft" },
      });
      const text = (res.content as Array<{ text?: string }>).map((c) => c.text).join("\n");
      expect(res.isError).toBe(true);
      expect(text).toMatch(/session registry could not be written \(EACCES/);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toContain("gdigrab");
      expect(killed).toEqual([FAKE_PID]);
      // Nothing is left registered for shutdown to chase.
      expect(getStore().activeIds()).toEqual([]);
      expect(getStore().list()).toEqual([]);
    } finally {
      create.mockRestore();
    }
  }, 15_000);
});

describe("start_recording rollback (#307)", () => {
  it("gives back the replay ring when the capture exits at once", async () => {
    const { existsSync, readdirSync } = await import("node:fs");
    const { replayRoot } = await import("../utils/replay.js");
    exitAtOnce = true;
    try {
      const res = await client.callTool({
        name: "start_recording",
        arguments: { target: "region:0,0,640,480", quality: "draft", replayBufferSec: 30 },
      });
      const text = (res.content as Array<{ text?: string }>).map((c) => c.text).join("\n");
      expect(res.isError).toBe(true);
      expect(text).toMatch(/exited immediately/);
      // The ring prepared before the spawn is gone, not left on disk.
      expect(existsSync(replayRoot()) ? readdirSync(replayRoot()) : []).toEqual([]);
    } finally {
      exitAtOnce = false;
    }
  }, 15_000);
});
