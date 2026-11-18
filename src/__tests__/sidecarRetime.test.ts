/** The input's sidecars moved onto a pipeline output's timeline (#352). */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retimeEvents, retimeTimed, writeRetimedSidecars } from "../utils/sidecarRetime.js";
import { formatEventsJsonl, parseEventsJsonl, type InputEvent } from "../utils/events.js";
import type { TimeOp } from "../utils/chapters.js";

const dir = mkdtempSync(join(tmpdir(), "sc-sidecar-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ID = { sx: 1, sy: 1, ox: 0, oy: 0 };
const size = { width: 640, height: 360, durationSec: 10 };

describe("retimeEvents (#352)", () => {
  const ev = (t: number, x = 100, y = 100, extra: Partial<InputEvent> = {}): InputEvent => ({ t, type: "down", x, y, inFrame: true, button: "left", ...extra });

  it("drops events trimmed away and moves the rest", () => {
    const ops: TimeOp[] = [{ op: "trim", start: 2, end: 8 }];
    const out = retimeEvents([ev(1), ev(3), ev(9)], ops, ID, size);
    expect(out.map((e) => e.t)).toEqual([1]);
  });

  it("follows speed and cuts", () => {
    const ops: TimeOp[] = [{ op: "cut", spans: [{ start: 2, end: 4 }] }, { op: "speed", factor: 2 }];
    expect(retimeEvents([ev(6)], ops, ID, size)[0]!.t).toBe(2);
  });

  it("maps positions through crop and scale, and marks ones that left the frame", () => {
    // crop x=100,y=50 then scale by 0.5
    const geo = { sx: 0.5, sy: 0.5, ox: -50, oy: -25 };
    const [inside, outside] = retimeEvents([ev(1, 300, 250), ev(1, 50, 20)], [], geo, { width: 320, height: 180, durationSec: 10 });
    expect(inside).toMatchObject({ x: 100, y: 100, inFrame: true });
    expect(outside).toMatchObject({ x: -25, y: -15, inFrame: false });
  });

  it("maps a typing burst's length by its end", () => {
    const out = retimeEvents([ev(2, 0, 0, { type: "typing", durationSec: 4 })], [{ op: "speed", factor: 2 }], ID, size);
    expect(out[0]).toMatchObject({ t: 1, durationSec: 2 });
  });

  it("retimeTimed drops items past the output's end", () => {
    expect(retimeTimed([{ t: 1 }, { t: 12 }], [], 10)).toEqual([{ t: 1 }]);
  });
});

describe("writeRetimedSidecars (#352)", () => {
  it("writes events, logs and perf beside the output", () => {
    const input = join(dir, "rec.mp4");
    const output = join(dir, "out.mp4");
    writeFileSync(join(dir, "rec.events.jsonl"), formatEventsJsonl([{ t: 3, type: "key", x: 10, y: 10, inFrame: true, keys: "Ctrl+S" }]));
    writeFileSync(join(dir, "rec.logs.jsonl"), JSON.stringify({ t: 4, source: "app", line: "Error: x" }) + "\n");
    writeFileSync(join(dir, "rec.perf.jsonl"), JSON.stringify({ t: 0.5, cpu: 1 }) + "\n");
    const res = writeRetimedSidecars(input, output, { timeOps: [{ op: "trim", start: 1, end: 9 }], geometry: ID, width: 640, height: 360, durationSec: 8 });
    expect(res.note).toBeUndefined();
    expect(parseEventsJsonl(readFileSync(res.eventsPath!, "utf8"))[0]).toMatchObject({ t: 2, keys: "Ctrl+S" });
    expect(readFileSync(res.logsPath!, "utf8")).toContain('"t":3');
    expect(readFileSync(res.perfPath!, "utf8")).toBe(""); // trimmed away
  });

  it("leaves the event log out once the content moved, and says why", () => {
    const res = writeRetimedSidecars(join(dir, "rec.mp4"), join(dir, "zoomed.mp4"), { timeOps: [], geometry: null, width: 640, height: 360, durationSec: 8 });
    expect(res.eventsPath).toBeUndefined();
    expect(res.note).toMatch(/zoom, reframe or backdrop/);
    expect(existsSync(join(dir, "zoomed.events.jsonl"))).toBe(false);
  });

  it("writes nothing when the input has no sidecars", () => {
    expect(writeRetimedSidecars(join(dir, "none.mp4"), join(dir, "o2.mp4"), { timeOps: [], geometry: ID, width: 1, height: 1, durationSec: 1 })).toEqual({});
  });
});
