/** Triggered recording (#336): the condition loop and arm lifecycle. */
import { describe, it, expect } from "vitest";
import { armStart, describeConditions, disarm, getArm, isArmId, listArms, waitForConditions, whenStarted } from "../utils/triggers.js";

/** A fake clock whose sleeps advance time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), time: () => t };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("triggers (#336)", () => {
  it("waits until every check holds at once", async () => {
    const c = clock();
    let n = 0;
    const out = await waitForConditions({
      checks: [async () => ++n >= 3, async () => true],
      timeoutMs: 10_000,
      intervalMs: 1000,
      signal: new AbortController().signal,
      ...c,
    });
    expect(out).toBe("met");
    expect(c.time()).toBe(2000);
  });

  it("times out, treats a throwing check as not holding, and cancels", async () => {
    const c = clock();
    expect(
      await waitForConditions({ checks: [async () => { throw new Error("x"); }], timeoutMs: 3000, intervalMs: 1000, signal: new AbortController().signal, ...c }),
    ).toBe("timeout");
    const ctl = new AbortController();
    ctl.abort();
    expect(await waitForConditions({ checks: [async () => true], timeoutMs: 3000, intervalMs: 1000, signal: ctl.signal })).toBe("cancelled");
  });

  it("starts the recording when the conditions hold and reports it", async () => {
    const arm = armStart({ conditions: { text: "Ready" }, target: "full", timeoutSec: 5, checks: [async () => true], fire: async () => "rec-1", intervalMs: 1 });
    expect(isArmId(arm.id)).toBe(true);
    expect(arm.status).toBe("armed");
    await until(() => getArm(arm.id)?.status === "started");
    expect(getArm(arm.id)).toMatchObject({ status: "started", sessionId: "rec-1" });
    expect(listArms().some((a) => a.id === arm.id)).toBe(true);
  });

  it("can be disarmed while waiting, and reports a failed start", async () => {
    const waiting = armStart({ conditions: { window: "window:Never" }, target: "full", timeoutSec: 60, checks: [async () => false], fire: async () => "x", intervalMs: 1 });
    expect(disarm(waiting.id)).toBe(true);
    expect(disarm(waiting.id)).toBe(false);
    expect(getArm(waiting.id)?.status).toBe("cancelled");
    const failing = armStart({ conditions: { text: "x" }, target: "full", timeoutSec: 5, checks: [async () => true], fire: async () => { throw new Error("no ffmpeg"); }, intervalMs: 1 });
    await until(() => getArm(failing.id)?.status === "failed");
    expect(getArm(failing.id)).toMatchObject({ status: "failed", error: "no ffmpeg" });
  });

  it("is 'starting', not disarmable, while the start runs; whenStarted waits for it (#342)", async () => {
    let release!: (id: string) => void;
    const arm = armStart({
      conditions: { text: "x" }, target: "full", timeoutSec: 5, checks: [async () => true],
      fire: () => new Promise<string>((r) => (release = r)), intervalMs: 1,
    });
    await until(() => getArm(arm.id)?.status === "starting");
    expect(disarm(arm.id)).toBe(false);
    const waited = whenStarted(arm.id);
    release("rec-2");
    expect(await waited).toMatchObject({ status: "started", sessionId: "rec-2" });
  });

  it("describes what it waits for", () => {
    expect(describeConditions({ window: "window:Error", text: "Ready" })).toBe('the window Error exists and "Ready" is on screen');
  });
});
