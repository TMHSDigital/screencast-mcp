/** #183: PowerShell helpers are killed after a timeout instead of hanging. */
import { describe, it, expect } from "vitest";
import { runPowerShell, psTimeoutMs, PS_TIMEOUT_MS, PS_TIMEOUT_ENV } from "../utils/monitors.js";

describe("runPowerShell timeout (#183)", () => {
  it("kills a script that does not answer and says what timed out", async () => {
    const started = Date.now();
    await expect(
      runPowerShell("", "windows", {
        timeoutMs: 300,
        command: { file: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"] },
      }),
    ).rejects.toThrow(/Timed out reading windows after 0\.3 s/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("still returns stdout from a script that finishes in time", async () => {
    const out = await runPowerShell("", "monitors", {
      timeoutMs: 5000,
      command: { file: process.execPath, args: ["-e", "process.stdout.write('[]')"] },
    });
    expect(out).toBe("[]");
  });

  it("takes a positive integer override from the environment", () => {
    expect(psTimeoutMs(PS_TIMEOUT_MS, {})).toBe(20_000);
    expect(psTimeoutMs(60_000, { [PS_TIMEOUT_ENV]: "90000" })).toBe(90_000);
    expect(psTimeoutMs(60_000, { [PS_TIMEOUT_ENV]: "-1" })).toBe(60_000);
    expect(psTimeoutMs(60_000, { [PS_TIMEOUT_ENV]: "soon" })).toBe(60_000);
  });
});
