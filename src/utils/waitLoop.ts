/**
 * The polling loop behind wait_for_change (#301), with the frame grab, clock
 * and sleep injected so scripted frame sequences can test every outcome.
 */
import { diffFrames, SettleTracker, type DiffOptions, type Rect } from "./diff.js";

export type WaitOutcome = "changed" | "settled" | "timeout" | "cancelled";

export interface WaitLoopOptions {
  /** One grayscale frame at width x height. */
  grab: () => Promise<Uint8Array>;
  mode: "change" | "settle";
  width: number;
  height: number;
  diff: DiffOptions;
  timeoutMs: number;
  /** Mode settle: how long frames must stay still. */
  settleMs: number;
  intervalMs: number;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitLoopResult {
  outcome: WaitOutcome;
  /** Changed regions: the first difference (change), or the last one (settle). */
  regions: Rect[];
  /** Mode settle: whether anything changed before it settled. */
  everChanged: boolean;
  startedAt: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Grab a baseline, then poll until the frame differs from it (change), stays
 * still for settleMs (settle), the timeout passes, or the signal aborts. A
 * grab that fails because of the abort is a cancel; any other grab error is
 * rethrown. */
export async function waitLoop(o: WaitLoopOptions): Promise<WaitLoopResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const startedAt = now();
  const baseline = await o.grab();
  const settle = new SettleTracker(baseline, o.width, o.height, o.diff);
  let lastChangeAt = startedAt;
  let everChanged = false;
  let regions: Rect[] = [];
  let outcome: WaitOutcome = "timeout";

  while (now() - startedAt < o.timeoutMs) {
    if (o.signal.aborted) {
      outcome = "cancelled";
      break;
    }
    await sleep(o.intervalMs);
    // A grab killed by the cancel is the cancel, not a failure.
    const current = await o.grab().catch((error: unknown) => {
      if (o.signal.aborted) return null;
      throw error;
    });
    if (!current) {
      outcome = "cancelled";
      break;
    }
    if (o.mode === "change") {
      const d = diffFrames(baseline, current, o.width, o.height, o.diff);
      if (d.regions.length > 0) {
        regions = d.regions;
        outcome = "changed";
        break;
      }
    } else {
      const changed = settle.push(current);
      if (changed.length > 0) {
        everChanged = true;
        lastChangeAt = now();
        regions = changed;
      } else if (now() - lastChangeAt >= o.settleMs) {
        outcome = "settled";
        break;
      }
    }
  }
  return { outcome, regions, everChanged, startedAt };
}
