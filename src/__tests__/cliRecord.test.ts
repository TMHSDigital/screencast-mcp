/**
 * #257: record's robustness: --max-duration bounds, --command-env, cmd.exe
 * escaping, and evidence.json's status/endReason with a warning when the
 * recording ended before the command did. #268: OCR'd error lines.
 * runRecord gets a fake MCP client, so nothing is captured.
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandLine,
  displayCommand,
  earlyEndWarning,
  errorLines,
  parseCliArgs,
  runRecord,
  type Evidence,
  type RecordOptions,
  type ToolClient,
} from "../cli.js";

function recordOpts(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const cmd = parseCliArgs(argv, env);
  if (cmd.kind !== "record") throw new Error(`expected record, got ${cmd.kind}`);
  return cmd.options;
}

describe("record options", () => {
  it("validates --max-duration as an integer within start_recording's bounds", () => {
    expect(recordOpts(["record", "--max-duration", "0", "--", "x"]).maxDurationSec).toBe(0);
    expect(recordOpts(["record", "--max-duration", "604800", "--", "x"]).maxDurationSec).toBe(604800);
    for (const bad of ["90.5", "-1", "604801", "abc", ""]) {
      expect(() => parseCliArgs(["record", `--max-duration=${bad}`, "--", "x"], {})).toThrow(
        /--max-duration must be an integer 0-604800/,
      );
    }
  });

  it("reads the command from --command-env verbatim", () => {
    const env = { SC_COMMAND: 'npx playwright test -g "a & b"' };
    const o = recordOpts(["record", "--command-env", "SC_COMMAND", "--ocr-errors"], env);
    expect(o.command).toEqual(['npx playwright test -g "a & b"']);
    expect(o.ocrErrors).toBe(true);
    expect(commandLine(o.command, "win32")).toBe('npx playwright test -g "a & b"');
    expect(() => parseCliArgs(["record", "--command-env", "NOPE"], {})).toThrow(/unset or empty/);
    expect(() => parseCliArgs(["record", "--command-env", "SC_COMMAND", "--", "x"], env)).toThrow(/not both/);
    expect(() => parseCliArgs(["record", "--target", "full"], {})).toThrow(/needs a command after --/);
  });
});

describe("commandLine", () => {
  it("keeps a single argument verbatim", () => {
    expect(commandLine(["npm test && npm run e2e"], "win32")).toBe("npm test && npm run e2e");
    expect(commandLine(["npm test && npm run e2e"], "linux")).toBe("npm test && npm run e2e");
  });

  it("escapes for cmd.exe: MSVC quoting, then ^ on metacharacters", () => {
    expect(commandLine(["node", "-e", "process.exit(3)"], "win32")).toBe('node -e ^"process.exit^(3^)^"');
    // An embedded quote is \" for the program, and cmd never sees a live quote.
    expect(commandLine(["app.exe", 'say "hi & bye"'], "win32")).toBe('app.exe ^"say^ \\^"hi^ ^&^ bye\\^"^"');
    // Trailing backslashes are doubled so they do not escape the closing quote.
    expect(commandLine(["app.exe", "C:\\Program Files\\"], "win32")).toBe('app.exe ^"C:\\Program^ Files\\\\^"');
    expect(commandLine(["app.exe", ""], "win32")).toBe('app.exe ^"^"');
    expect(commandLine(["dotnet", "test", "--filter", "UI"], "win32")).toBe("dotnet test --filter UI");
    // npm/npx/.cmd shims re-parse %*, so they get a second round of carets.
    expect(commandLine(["npx", "vitest", "-t", "a & b"], "win32")).toBe('npx vitest -t ^^^"a^^^ ^^^&^^^ b^^^"');
  });

  it("single-quotes for sh elsewhere", () => {
    expect(commandLine(["node", "-e", "process.exit(3)"], "linux")).toBe("node -e 'process.exit(3)'");
    expect(commandLine(["echo", "it's"], "linux")).toBe("echo 'it'\\''s'");
  });

  it("displayCommand is the readable form for evidence.json", () => {
    expect(displayCommand(["node", "-e", 'say "hi"'])).toBe('node -e "say \\"hi\\""');
    expect(displayCommand(["npm test && npm run e2e"])).toBe("npm test && npm run e2e");
  });
});

describe("helpers", () => {
  it("earlyEndWarning flags a recording that ended before the command", () => {
    expect(earlyEndWarning("stopped", "stopped", 12)).toBeNull();
    expect(earlyEndWarning(null, null, null)).toBeNull();
    expect(earlyEndWarning("stopped", "max_duration", 3600)).toMatch(/max-duration cap at 3600 s.*not the end of the run/);
    expect(earlyEndWarning("failed", "crashed", 40)).toMatch(/recording failed at 40 s/);
    expect(earlyEndWarning("stopped", "window_closed", null)).toMatch(/window closed/);
  });

  it("errorLines puts the latest first, dedupes, and masks secrets", () => {
    expect(
      errorLines([
        { t: 1, line: "Error: old" },
        { t: 5, line: "Error: token=sk-abcdef123456" },
        { t: 3, line: "error:   OLD" },
        { t: 4, line: "  " },
      ]),
    ).toEqual(["Error: [REDACTED]", "error:   OLD"]);
  });
});

describe("runRecord evidence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  type Responses = Record<string, Record<string, unknown> | Error>;

  async function run(responses: Responses, exitCode: number, extra: Partial<RecordOptions> = {}) {
    const outDir = mkdtempSync(join(tmpdir(), "sc-cli-"));
    dirs.push(outDir);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: ToolClient = {
      async call(name, args) {
        calls.push({ name, args });
        const r = responses[name];
        if (r instanceof Error) return { isError: true, text: r.message, structured: undefined };
        return { isError: false, text: "", structured: r ?? {} };
      },
      close: async () => undefined,
    };
    const err: string[] = [];
    let t = 1000;
    const code = await runRecord(
      { ...recordOpts(["record", "--", "x"]), outDir, ...extra },
      { out: () => undefined, err: (s) => void err.push(s) },
      { connect: async () => client, run: async () => exitCode, now: () => (t += 5000) },
    );
    const evidence = JSON.parse(readFileSync(join(outDir, "evidence.json"), "utf8")) as Evidence;
    return { code, evidence, calls, err: err.join("") };
  }

  const started = { sessionId: "s1", outputPath: "rec.mp4" };

  it("records endReason stopped and no warning for a normal run", async () => {
    const r = await run(
      { start_recording: started, stop_recording: { sessionId: "s1", status: "stopped", outputPath: "rec.mp4", durationSec: 5 } },
      0,
    );
    expect(r.code).toBe(0);
    expect(r.evidence).toMatchObject({ status: "stopped", endReason: "stopped", commandSec: 5, warnings: [], errors: null });
  });

  it("warns when the recording hit max_duration before the command ended", async () => {
    const r = await run(
      {
        start_recording: started,
        stop_recording: { sessionId: "s1", status: "stopped", outputPath: "rec.mp4", durationSec: 60, endReason: "max_duration" },
        export_gif: { outputPath: "evidence.gif" },
        contact_sheet: { outputPath: "contact-sheet.png" },
      },
      1,
      { maxDurationSec: 60 },
    );
    expect(r.code).toBe(1);
    expect(r.calls.find((c) => c.name === "start_recording")?.args.maxDurationSec).toBe(60);
    expect(r.evidence.endReason).toBe("max_duration");
    expect(r.evidence.gif).toBe("evidence.gif");
    expect(r.evidence.warnings.join(" ")).toMatch(/max-duration cap at 60 s/);
    expect(r.err).toMatch(/max-duration cap/);
  });

  it("warns when the recording failed", async () => {
    const r = await run(
      {
        start_recording: started,
        stop_recording: { sessionId: "s1", status: "failed", outputPath: "rec.mp4", durationSec: 3, endReason: "crashed" },
      },
      0,
      { artifacts: "never" },
    );
    expect(r.evidence).toMatchObject({ status: "failed", endReason: "crashed" });
    expect(r.evidence.warnings.join(" ")).toMatch(/recording failed at 3 s/);
  });

  it("OCRs the tail of a failing run for error lines with --ocr-errors", async () => {
    const r = await run(
      {
        start_recording: started,
        stop_recording: { sessionId: "s1", status: "stopped", outputPath: "rec.mp4", durationSec: 100 },
        export_gif: { outputPath: "evidence.gif" },
        contact_sheet: { outputPath: "contact-sheet.png" },
        trim: { outputPath: "tail.mp4" },
        find_text: { matches: [{ t: 2, line: "AssertionError: expected 1" }] },
      },
      1,
      { ocrErrors: true },
    );
    expect(r.calls.find((c) => c.name === "trim")?.args).toMatchObject({ input: "rec.mp4", start: 70, duration: 30 });
    expect(r.calls.find((c) => c.name === "find_text")?.args).toMatchObject({ input: "tail.mp4", regex: true });
    expect(r.evidence.errors).toEqual(["AssertionError: expected 1"]);
  });

  it("does not OCR a passing run", async () => {
    const r = await run(
      { start_recording: started, stop_recording: { sessionId: "s1", status: "stopped", outputPath: "rec.mp4", durationSec: 5 } },
      0,
      { ocrErrors: true },
    );
    expect(r.calls.some((c) => c.name === "find_text")).toBe(false);
    expect(r.evidence.errors).toBeNull();
  });

  it("still runs the command when recording does not start", async () => {
    const r = await run({ start_recording: new Error("no ffmpeg") }, 3);
    expect(r.code).toBe(3);
    expect(r.evidence).toMatchObject({ status: null, endReason: null, recording: null });
    expect(r.evidence.warnings[0]).toMatch(/recording did not start/);
  });
});
