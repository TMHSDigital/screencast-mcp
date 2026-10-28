/**
 * #88: monitor geometry is queried through async PowerShell and cached for
 * MONITOR_CACHE_MS. execFile is mocked so this runs on any OS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { argAfter, defined } from "./testUtils.js";

const execFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...a: unknown[]) => execFile(...a) }));

const { getMonitors, clearMonitorCache, MONITOR_CACHE_MS } = await import("../utils/monitors.js");

const SCREENS = JSON.stringify([{ X: 0, Y: 0, Width: 1920, Height: 1080, Primary: true }]);
const realPlatform = process.platform;

describe("getMonitors cache (#88)", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    clearMonitorCache();
    execFile.mockReset();
    execFile.mockImplementation((_bin, _args, _opts, cb) => setImmediate(() => cb(null, SCREENS, "")));
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("reuses a layout queried within the cache window", async () => {
    const a = await getMonitors(1_000);
    const b = await getMonitors(1_000 + MONITOR_CACHE_MS - 1);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ width: 1920, primary: true });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("re-queries once the window has passed", async () => {
    await getMonitors(1_000);
    await getMonitors(1_000 + MONITOR_CACHE_MS);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("shares one query between concurrent callers", async () => {
    await Promise.all([getMonitors(5), getMonitors(5), getMonitors(6)]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure", async () => {
    execFile.mockImplementationOnce((_b, _a, _o, cb) => setImmediate(() => cb(new Error("boom"), "", "nope")));
    await expect(getMonitors(10)).rejects.toThrow(/Could not enumerate monitors: nope/);
    await expect(getMonitors(11)).resolves.toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("never blocks: the query runs through the async execFile", async () => {
    await getMonitors(20);
    expect(execFile.mock.calls[0]?.[0]).toBe("powershell");
  });

  it("makes PowerShell write UTF-8, so non-ASCII text survives the pipe", async () => {
    await getMonitors(30);
    const args = defined(execFile.mock.calls[0])[1] as string[];
    const script = Buffer.from(argAfter(args, "-EncodedCommand"), "base64").toString("utf16le");
    expect(script.startsWith("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n")).toBe(true);
  });
});
