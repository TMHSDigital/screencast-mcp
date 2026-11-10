/**
 * The input-event logger's lifecycle (#298): starting the hook helper,
 * stopping it, converting its raw log, and waiting on a finalizer. The
 * PowerShell helper is a fake child; nothing is hooked.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawn: spawnMock }));

import {
  LOGGER_READY_TIMEOUT_MS,
  LOGGER_STOP_GRACE_MS,
  startEventLogger,
  stopEventLogger,
  trackFinalizer,
  whenFinalized,
  writeEventsFile,
} from "../utils/events.js";

type FakeHelper = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
};

function fakeHelper(): FakeHelper {
  const c = new EventEmitter() as FakeHelper;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.kill = vi.fn(() => {
    exit(c, null, "SIGTERM");
    return true;
  });
  return c;
}

function exit(c: FakeHelper, code: number | null, signal: string | null = null): void {
  if (c.exitCode !== null || c.signalCode !== null) return;
  c.exitCode = code;
  c.signalCode = signal;
  c.emit("exit", code, signal);
}

const asChild = (c: FakeHelper) => c as unknown as ChildProcess;

// startEventLogger is Windows-only; the fake helper makes it portable.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }));
afterAll(() => Object.defineProperty(process, "platform", platform));

let dir: string;
let raw: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-evlog-"));
  raw = join(dir, "rec.events.raw");
  spawnMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("startEventLogger (#298)", () => {
  it("resolves once the helper prints ready, and clears a stale stop file", async () => {
    writeFileSync(`${raw}.stop`, "");
    const helper = fakeHelper();
    spawnMock.mockImplementation(() => {
      setTimeout(() => helper.stdout.emit("data", Buffer.from("ready\r\n")), 5);
      return helper;
    });
    await expect(startEventLogger(raw, "masked")).resolves.toBe(helper);
    expect(spawnMock.mock.calls[0]![0]).toBe("powershell");
    expect(existsSync(`${raw}.stop`)).toBe(false);
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it("rejects with the helper's cleaned error when it exits first", async () => {
    const helper = fakeHelper();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        helper.stderr.emit("data", Buffer.from('#< CLIXML\r\n<Objs><S S="Error">Add-Type failed_x000D__x000A_</S></Objs>'));
        exit(helper, 1);
      }, 5);
      return helper;
    });
    await expect(startEventLogger(raw, "masked")).rejects.toThrow("Could not start the input event log: Add-Type failed");
    expect(helper.kill).toHaveBeenCalled();
  });

  it("falls back to the exit code when stderr is empty", async () => {
    const helper = fakeHelper();
    spawnMock.mockImplementation(() => {
      setTimeout(() => exit(helper, 7), 5);
      return helper;
    });
    await expect(startEventLogger(raw, "masked")).rejects.toThrow("helper exited with code 7");
  });

  it("gives up and kills the helper when it never reports ready", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    spawnMock.mockImplementation(() => helper);
    const p = startEventLogger(raw, "masked");
    const failed = expect(p).rejects.toThrow(`no response in ${LOGGER_READY_TIMEOUT_MS / 1000}s`);
    await vi.advanceTimersByTimeAsync(LOGGER_READY_TIMEOUT_MS);
    await failed;
    expect(helper.kill).toHaveBeenCalled();
  });
});

describe("stopEventLogger (#298)", () => {
  async function started(): Promise<FakeHelper> {
    const helper = fakeHelper();
    spawnMock.mockImplementation(() => {
      setTimeout(() => helper.stdout.emit("data", Buffer.from("ready")), 1);
      return helper;
    });
    await startEventLogger(raw, "masked");
    return helper;
  }

  it("writes the stop file and resolves when the helper exits in the grace period", async () => {
    const helper = await started();
    const stop = stopEventLogger(asChild(helper));
    expect(existsSync(`${raw}.stop`)).toBe(true);
    exit(helper, 0);
    await stop;
    expect(helper.kill).not.toHaveBeenCalled();
    expect(existsSync(`${raw}.stop`)).toBe(false);
  });

  it("kills a helper that ignores the stop file", async () => {
    const helper = await started();
    vi.useFakeTimers();
    const stop = stopEventLogger(asChild(helper));
    await vi.advanceTimersByTimeAsync(LOGGER_STOP_GRACE_MS);
    await stop;
    expect(helper.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(`${raw}.stop`)).toBe(false);
  });

  it("resolves at once for a helper that already exited", async () => {
    const helper = await started();
    exit(helper, 0);
    await stopEventLogger(asChild(helper));
    expect(existsSync(`${raw}.stop`)).toBe(false);
    expect(helper.kill).not.toHaveBeenCalled();
  });
});

describe("writeEventsFile (#298)", () => {
  const frame = { x: 0, y: 0, w: 640, h: 360 };

  it("converts the raw log to events.jsonl and removes the raw file", () => {
    const jsonl = join(dir, "rec.events.jsonl");
    writeFileSync(raw, ["1500.0,down,10,20,left", "1600.0,hb,0,0,"].join("\n"));
    const events = writeEventsFile({ raw, jsonl }, { startMs: 1000, frame, endSec: 5 });
    expect(events.length).toBeGreaterThan(0);
    const lines = readFileSync(jsonl, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l) as { type: string })[0]).toMatchObject({ type: "down", t: 0.5 });
    expect(existsSync(raw)).toBe(false);
  });

  it("writes an empty log when the helper wrote nothing", () => {
    const jsonl = join(dir, "rec.events.jsonl");
    expect(writeEventsFile({ raw, jsonl }, { startMs: 1000, frame })).toEqual([]);
    expect(readFileSync(jsonl, "utf8").trim()).toBe("");
  });
});

describe("whenFinalized (#298)", () => {
  it("resolves at once for a session with no finalizer", async () => {
    await expect(whenFinalized("nobody")).resolves.toBeUndefined();
  });

  it("waits for the tracked conversion", async () => {
    let done!: () => void;
    trackFinalizer("fin-1", new Promise<void>((r) => (done = r)));
    let resolved = false;
    const p = whenFinalized("fin-1").then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    done();
    await p;
    expect(resolved).toBe(true);
  });

  it("gives up on a conversion that hangs", async () => {
    trackFinalizer("fin-2", new Promise<void>(() => {}));
    const t0 = Date.now();
    await whenFinalized("fin-2", 30);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
