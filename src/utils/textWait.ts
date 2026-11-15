/**
 * wait_for_change mode "text" (#318): wait until text appears (or, with
 * `gone`, disappears) on screen. The screen is read once at the start, then
 * again only after its pixels change, so a still screen costs one OCR pass
 * however long the wait. The grab, the read, the clock and the sleep are
 * injected so scripted sequences can test every outcome.
 */
import { diffFrames, type DiffOptions } from "./diff.js";
import type { TextMatch } from "./ocr.js";

export type TextWaitOutcome = "matched" | "timeout" | "cancelled";

export interface TextWaitOptions {
  /** One grayscale frame at width x height, for change detection. */
  grab: () => Promise<Uint8Array>;
  /** OCR the screen as it is now and match the query. */
  read: () => Promise<TextMatch[]>;
  width: number;
  height: number;
  diff: DiffOptions;
  timeoutMs: number;
  intervalMs: number;
  /** Wait for the text to be gone instead of present. */
  gone: boolean;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TextWaitResult {
  outcome: TextWaitOutcome;
  /** The matches of the last read (empty when the text is gone). */
  matches: TextMatch[];
  /** OCR passes run. */
  reads: number;
  startedAt: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function textWaitLoop(o: TextWaitOptions): Promise<TextWaitResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const startedAt = now();
  let reads = 0;
  let matches: TextMatch[] = [];
  const done = async () => {
    reads++;
    matches = await o.read();
    return o.gone ? matches.length === 0 : matches.length > 0;
  };
  const grab = () =>
    o.grab().catch((error: unknown) => {
      if (o.signal.aborted) return null;
      throw error;
    });

  let base = await grab();
  if (!base) return { outcome: "cancelled", matches, reads, startedAt };
  if (await done()) return { outcome: "matched", matches, reads, startedAt };
  while (now() - startedAt < o.timeoutMs) {
    if (o.signal.aborted) return { outcome: "cancelled", matches, reads, startedAt };
    await sleep(o.intervalMs);
    const current = await grab();
    if (!current) return { outcome: "cancelled", matches, reads, startedAt };
    if (diffFrames(base, current, o.width, o.height, o.diff).regions.length === 0) continue;
    base = current;
    if (await done()) return { outcome: "matched", matches, reads, startedAt };
  }
  return { outcome: "timeout", matches, reads, startedAt };
}
