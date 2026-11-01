/**
 * #254: variable-size data for a PowerShell helper (narrate's request, OCR's
 * path list) travels in a temp file, never on the command line, which
 * Windows caps at 32,767 characters. Pure, plus a temp file.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_COMMAND_LINE_CHARS,
  commandLineLength,
  powerShellArgs,
  runPowerShell,
  withPayloadFile,
} from "../utils/monitors.js";
import { MAX_LINES, MAX_LINE_CHARS, ttsCall } from "../utils/narrate.js";
import { ocrCall } from "../utils/ocr.js";
import { MAX_INDEX_FRAMES } from "../utils/recordingIndex.js";

/** A long but realistic temp path, like the payload file's. */
const payloadPath = join(tmpdir(), "a".repeat(120), "screencast-ps-12345-0123456789ab.json");

describe("PowerShell payloads (#254)", () => {
  it("keep the largest narrate script's command line under the Windows limit", () => {
    const items = Array.from({ length: MAX_LINES }, (_, i) => ({
      text: "é".repeat(MAX_LINE_CHARS),
      path: join(tmpdir(), "screencast-narrate-abcdef", `line_${String(i).padStart(3, "0")}.wav`),
    }));
    const { script, payload } = ttsCall({ voice: "Microsoft Zira Desktop", rate: 1, items });
    const length = commandLineLength("powershell", powerShellArgs(script, payloadPath));
    expect(length).toBeLessThan(MAX_COMMAND_LINE_CHARS);
    // The whole request is in the payload, not the script.
    expect(JSON.parse(payload).items).toHaveLength(MAX_LINES);
    expect(script).not.toContain("éé");
    // What the old inline encoding would have needed: far past the limit.
    const inline = Buffer.from(payload, "utf8").toString("base64");
    expect(commandLineLength("powershell", powerShellArgs(script + inline))).toBeGreaterThan(MAX_COMMAND_LINE_CHARS);
  });

  it("keep a whole-index OCR batch's command line under the limit", () => {
    const paths = Array.from({ length: MAX_INDEX_FRAMES * 2 }, (_, i) => join(tmpdir(), "screencast-index-abcdef", `pass${i}-0.png`));
    const { script, payload } = ocrCall(paths);
    expect(commandLineLength("powershell", powerShellArgs(script, payloadPath))).toBeLessThan(MAX_COMMAND_LINE_CHARS);
    expect(JSON.parse(payload)).toEqual(paths);
  });

  it("write the payload to a temp file that is gone afterwards, even on failure", async () => {
    let seen = "";
    const out = await withPayloadFile('{"a":"é"}', async (path) => {
      seen = path;
      expect(readFileSync(path, "utf8")).toBe('{"a":"é"}');
      return 7;
    });
    expect(out).toBe(7);
    expect(existsSync(seen)).toBe(false);
    await expect(
      withPayloadFile("x", async (path) => {
        seen = path;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });

  it("name what failed instead of 'Could not enumerate'", async () => {
    await expect(
      runPowerShell("", "the speech engine", {
        timeoutMs: 5000,
        payload: "{}",
        failure: "Could not synthesize speech",
        command: { file: process.execPath, args: ["-e", "process.stderr.write('bad'); process.exit(1)"] },
      }),
    ).rejects.toThrow(/^Could not synthesize speech: bad/);
    await expect(
      runPowerShell("", "windows", {
        timeoutMs: 5000,
        command: { file: process.execPath, args: ["-e", "process.exit(1)"] },
      }),
    ).rejects.toThrow(/^Could not enumerate windows/);
  });
});
