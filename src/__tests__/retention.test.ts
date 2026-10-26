/** #209: SCREENCAST_RETENTION_DAYS prunes old captures, never recordings. */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneCaptures, retentionDays, RETENTION_ENV } from "../utils/retention.js";

const root = mkdtempSync(join(tmpdir(), "sc-retention-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
function file(rel: string, ageDays: number): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
  const t = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
}

describe("capture retention (#209)", () => {
  it("is off unless set to a positive number of days", () => {
    expect(retentionDays({})).toBeNull();
    expect(retentionDays({ [RETENTION_ENV]: "0" })).toBeNull();
    expect(retentionDays({ [RETENTION_ENV]: "soon" })).toBeNull();
    expect(retentionDays({ [RETENTION_ENV]: "7" })).toBe(7);
  });

  it("deletes old screenshots, frames, and raw event logs, and keeps the rest", () => {
    const oldShot = file("screenshots/ocr-old.png", 10);
    const newShot = file("screenshots/shot-new.png", 1);
    const oldFrame = file("frames/sample-1/frame_00001.png", 10);
    const oldRaw = file("recordings/rec-1.events.raw", 10);
    const oldRec = file("recordings/rec-1.mp4", 10);
    const oldEvents = file("recordings/rec-1.events.jsonl", 10);
    const oldEdit = file("edits/clip.mp4", 10);

    const r = pruneCaptures(7, Date.now(), root);
    expect(r.removed).toBe(3);
    for (const gone of [oldShot, oldFrame, oldRaw]) expect(existsSync(gone)).toBe(false);
    for (const kept of [newShot, oldRec, oldEvents, oldEdit]) expect(existsSync(kept)).toBe(true);
  });
});
