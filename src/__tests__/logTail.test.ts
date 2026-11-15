/** App logs on the video clock (#334): line splitting, levels, the clock,
 * a real tailer over a temp file (append, rotate, truncate), the report
 * excerpt, and search over indexed log lines. */
import { describe, it, expect, afterAll } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTailer, convertLogLines, formatLogsJsonl, logLevel, logsPath, parseLogsJsonl, splitChunk } from "../utils/logTail.js";
import { buildReportMarkdown, logExcerpt, type BugReportData } from "../utils/bugReport.js";
import { attach, searchIndex, INDEX_VERSION, type RecordingIndex } from "../utils/recordingIndex.js";

const dir = mkdtempSync(join(tmpdir(), "sc-logtail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("app logs (#334)", () => {
  it("splits chunks into lines, keeping a partial line and a split UTF-8 character", () => {
    const euro = Buffer.from("€"); // 3 bytes
    const a = splitChunk(Buffer.alloc(0), Buffer.concat([Buffer.from("one\r\ntwo "), euro.subarray(0, 1)]));
    expect(a.lines).toEqual(["one"]);
    const b = splitChunk(a.rest, Buffer.concat([euro.subarray(1), Buffer.from("\n")]));
    expect(b.lines).toEqual(["two €"]);
    expect(b.rest.length).toBe(0);
  });

  it("reads levels from common markers", () => {
    expect(logLevel("2026-01-01 ERROR db down")).toBe("error");
    expect(logLevel("Unhandled exception in worker")).toBe("error");
    expect(logLevel("[warn] slow query")).toBe("warn");
    expect(logLevel("terror alert")).toBeUndefined();
  });

  it("moves lines onto the video clock, dropping ones outside it and blank ones", () => {
    const raw = [
      { epochMs: 900, source: "app", line: "before" },
      { epochMs: 1500, source: "app", line: "ERROR at 0.5" },
      { epochMs: 1600, source: "app", line: "  " },
      { epochMs: 9000, source: "app", line: "after the end" },
    ];
    const lines = convertLogLines(raw, { startMs: 1000, endSec: 5 });
    expect(lines).toEqual([{ t: 0.5, source: "app", line: "ERROR at 0.5", level: "error" }]);
    expect(parseLogsJsonl(formatLogsJsonl(lines) + "{torn")).toEqual(lines);
    expect(logsPath("C:/r/rec.mp4")).toBe("C:/r/rec.logs.jsonl");
  });

  it("follows a file from its end, through rotation and truncation", async () => {
    const f = join(dir, "app.log");
    writeFileSync(f, "already there\n");
    const t = new LogTailer([{ path: f }]);
    await t.mark();
    appendFileSync(f, "after mark\n");
    await t.readNew();
    renameSync(f, `${f}.1`);
    writeFileSync(f, "new file\n");
    await t.readNew();
    writeFileSync(f, "");
    await t.readNew();
    appendFileSync(f, "after truncate\nno newline yet");
    const lines = (await t.stop()).map((l) => `${l.source}: ${l.line}`);
    expect(lines).toEqual(["app.log: after mark", "app.log: new file", "app.log: after truncate", "app.log: no newline yet"]);
  });

  it("quotes the log lines around the clip, masked, in the report", () => {
    const lines = [
      { t: 1, source: "app", line: "too early" },
      { t: 8, source: "app", line: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 used" },
      { t: 12, source: "app", line: "ERROR boom", level: "error" },
    ];
    const ex = logExcerpt(lines, { start: 10, end: 13 }, String.raw`ghp_[A-Za-z0-9]{36}`);
    expect(ex.map((l) => l.t)).toEqual([-2, 2]);
    expect(ex[0]!.line).not.toContain("ghp_abc");
    const md = buildReportMarkdown({
      title: "t", createdAt: "x", clip: { start: 10, end: 13, recordingDurationSec: 20, width: 1, height: 1 },
      files: { clip: "clip.mp4" }, steps: [], errors: [], ocr: "unavailable", logs: ex,
      redaction: { scanned: false, found: 0, manual: 0 }, environment: [],
    } as BugReportData);
    expect(md).toContain("## App logs");
    expect(md).toContain("0:02.0 [app] ERROR boom");
  });

  it("makes indexed log lines searchable", () => {
    const base: RecordingIndex = {
      version: INDEX_VERSION, video: "v.mp4", fingerprint: { size: 1, mtimeMs: 1, sample: "x" }, durationSec: 10,
      createdAt: "x", sceneThreshold: 0.03, maxFrames: 10, framesRead: 0, ocr: false, segments: [{ start: 0, end: 10, ocr: [] }],
    };
    const index = { ...base, segments: attach(base.segments, [{ t: 4, text: "app: NullReferenceException in Save" }], "logs") };
    const res = searchIndex(index, "NullReferenceException");
    expect(res.hits[0]?.matches[0]).toMatchObject({ source: "log", t: 4 });
  });
});
