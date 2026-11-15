/**
 * Triggered recording (#336). start_recording { startWhen } arms a recording
 * instead of starting it: a watcher checks the conditions every few seconds
 * and starts the capture (with the same arguments) once they hold, or gives
 * up at its timeout. stopWhen ends a running recording once its text shows.
 * Arms live in this server's memory: list_sessions shows them, get_session
 * reports what one became, and stop_recording disarms one.
 *
 * The loop is pure apart from the injected checks, clock and sleep, so every
 * outcome is unit-tested without a desktop.
 */
import { rand, stamp } from "./paths.js";

export interface TriggerConditions {
  /** A window: target ("window:Error", "window:exe=app.exe") that must exist. */
  window?: string;
  /** Text that must be on the recording's target (OCR). */
  text?: string;
}

export type ArmStatus = "armed" | "started" | "timeout" | "cancelled" | "failed";

export interface Arm {
  id: string;
  status: ArmStatus;
  conditions: TriggerConditions;
  target: string;
  armedAt: string;
  timeoutSec: number;
  /** The recording it started. */
  sessionId?: string;
  firedAt?: string;
  error?: string;
}

export const DEFAULT_ARM_TIMEOUT_SEC = 600;
export const MAX_ARM_TIMEOUT_SEC = 24 * 3600;
export const ARM_POLL_MS = 1500;

const arms = new Map<string, { arm: Arm; abort: AbortController }>();

export function isArmId(id: string): boolean {
  return id.startsWith("arm-");
}

export function newArmId(): string {
  return `arm-${stamp()}-${rand(6)}`;
}

export function getArm(id: string): Arm | undefined {
  const a = arms.get(id)?.arm;
  return a ? { ...a } : undefined;
}

export function listArms(): Arm[] {
  return [...arms.values()].map((a) => ({ ...a.arm }));
}

/** Disarm a waiting arm. Returns false when it is not waiting. */
export function disarm(id: string): boolean {
  const a = arms.get(id);
  if (!a || a.arm.status !== "armed") return false;
  a.abort.abort();
  a.arm.status = "cancelled";
  return true;
}

/** Cancel every waiting arm (server shutdown). */
export function disarmAll(): void {
  for (const id of arms.keys()) disarm(id);
}

/** A human description of what an arm waits for. Pure. */
export function describeConditions(c: TriggerConditions): string {
  const parts = [
    ...(c.window ? [`${c.window.replace(/^window:/, "the window ")} exists`] : []),
    ...(c.text ? [`"${c.text}" is on screen`] : []),
  ];
  return parts.join(" and ");
}

export interface WaitForOptions {
  /** Each check resolves true when its condition holds now. */
  checks: Array<() => Promise<boolean>>;
  timeoutMs: number;
  intervalMs: number;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Poll until every check holds at once ("met"), the timeout passes, or the
 * signal aborts. A check that throws counts as not holding. */
export async function waitForConditions(o: WaitForOptions): Promise<"met" | "timeout" | "cancelled"> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  for (;;) {
    if (o.signal.aborted) return "cancelled";
    let all = true;
    for (const check of o.checks) {
      const ok = await check().catch(() => false);
      if (!ok) {
        all = false;
        break;
      }
    }
    if (o.signal.aborted) return "cancelled";
    if (all) return "met";
    if (now() - started >= o.timeoutMs) return "timeout";
    await sleep(o.intervalMs);
  }
}

/**
 * Arm a start: wait for the conditions in the background, then call `fire`.
 * Returns the arm at once.
 */
export function armStart(o: {
  conditions: TriggerConditions;
  target: string;
  timeoutSec: number;
  checks: Array<() => Promise<boolean>>;
  fire: () => Promise<string>;
  intervalMs?: number;
}): Arm {
  const arm: Arm = {
    id: newArmId(),
    status: "armed",
    conditions: o.conditions,
    target: o.target,
    armedAt: new Date().toISOString(),
    timeoutSec: o.timeoutSec,
  };
  const abort = new AbortController();
  arms.set(arm.id, { arm, abort });
  void (async () => {
    const outcome = await waitForConditions({
      checks: o.checks,
      timeoutMs: o.timeoutSec * 1000,
      intervalMs: o.intervalMs ?? ARM_POLL_MS,
      signal: abort.signal,
    });
    if (outcome !== "met") {
      if (arm.status === "armed") arm.status = outcome;
      return;
    }
    arm.firedAt = new Date().toISOString();
    try {
      arm.sessionId = await o.fire();
      arm.status = "started";
    } catch (err) {
      arm.status = "failed";
      arm.error = err instanceof Error ? err.message : String(err);
    }
  })();
  return { ...arm };
}

/** Forget arms that ended long ago, so the map stays small. */
export function pruneArms(maxAgeMs = 24 * 3600_000, now = Date.now()): void {
  for (const [id, a] of arms) {
    if (a.arm.status !== "armed" && now - Date.parse(a.arm.armedAt) > maxAgeMs) arms.delete(id);
  }
}
