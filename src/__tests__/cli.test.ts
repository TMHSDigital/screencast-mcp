/**
 * #179: the headless CLI's argument parsing and the small helpers around it.
 * Recording itself goes through the same tool handlers the server tests cover.
 */
import { describe, it, expect } from "vitest";
import {
  CliUsageError,
  commandLine,
  isCliInvocation,
  parseCliArgs,
  parseToolArgs,
  runCli,
  tailWindow,
  USAGE,
} from "../cli.js";

function recordOpts(argv: string[]) {
  const cmd = parseCliArgs(argv);
  if (cmd.kind !== "record") throw new Error(`expected record, got ${cmd.kind}`);
  return cmd.options;
}

describe("isCliInvocation", () => {
  it("keeps the stdio server the default", () => {
    expect(isCliInvocation([])).toBe(false);
    // Unknown arguments are not a CLI call either: clients may pass anything.
    expect(isCliInvocation(["--stdio"])).toBe(false);
  });
  it.each(["record", "call", "help", "--help", "-h", "--version", "-v"])("treats %s as the CLI", (sub) => {
    expect(isCliInvocation([sub])).toBe(true);
  });
});

describe("parseCliArgs record", () => {
  it("applies the defaults", () => {
    expect(recordOpts(["record", "--", "npm", "test"])).toEqual({
      target: "full",
      fps: 15,
      outDir: "screencast-evidence",
      artifacts: "failure",
      lastSec: 30,
      gif: true,
      contactSheet: true,
      discardOnSuccess: false,
      command: ["npm", "test"],
    });
  });
  it("reads every option, in both --flag value and --flag=value forms", () => {
    const o = recordOpts([
      "record", "--target", "window:My App", "--fps=30", "--out", "ev", "--artifacts=always",
      "--last", "12.5", "--no-gif", "--no-contact-sheet", "--discard-on-success", "--max-duration=600",
      "--", "dotnet", "test", "--filter", "UI",
    ]);
    expect(o).toMatchObject({
      target: "window:My App", fps: 30, outDir: "ev", artifacts: "always", lastSec: 12.5,
      gif: false, contactSheet: false, discardOnSuccess: true, maxDurationSec: 600,
      command: ["dotnet", "test", "--filter", "UI"],
    });
  });
  it("keeps flags after -- as part of the command", () => {
    expect(recordOpts(["record", "--", "npx", "vitest", "--fps", "3"]).command).toEqual(["npx", "vitest", "--fps", "3"]);
  });
  it.each([
    [["record"], /needs a command after --/],
    [["record", "--target", "full"], /needs a command after --/],
    [["record", "--"], /needs a command after --/],
    [["record", "--fps", "0", "--", "x"], /--fps must be an integer 1-120/],
    [["record", "--fps", "2.5", "--", "x"], /--fps must be an integer/],
    [["record", "--last", "-1", "--", "x"], /--last must be a number >= 0/],
    [["record", "--artifacts", "sometimes", "--", "x"], /failure, always, or never/],
    [["record", "--target", "--", "x"], /--target needs a value/],
    [["record", "--bogus", "--", "x"], /Unknown record option "--bogus"/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe("parseCliArgs other commands", () => {
  it("parses call, help, and version", () => {
    expect(parseCliArgs(["call", "doctor"])).toEqual({ kind: "call", tool: "doctor", args: undefined });
    expect(parseCliArgs(["call", "trim", '{"input":"a.mp4","start":1}'])).toEqual({ kind: "call", tool: "trim", args: '{"input":"a.mp4","start":1}' });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["record", "--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  });
  it("rejects call without a tool or with stray arguments", () => {
    expect(() => parseCliArgs(["call"])).toThrow(/needs a tool name/);
    expect(() => parseCliArgs(["call", "trim", "{}", "extra"])).toThrow(/one JSON argument/);
  });
});

describe("helpers", () => {
  it("commandLine keeps a single argument verbatim and quotes the rest", () => {
    expect(commandLine(["npm test && npm run e2e"])).toBe("npm test && npm run e2e");
    expect(commandLine(["node", "-e", "process.exit(3)"])).toBe('node -e "process.exit(3)"');
    expect(commandLine(["app.exe", "C:\\Program Files\\x", 'say "hi"', ""])).toBe('app.exe "C:\\Program Files\\x" "say \\"hi\\"" ""');
  });
  it("tailWindow covers the last N seconds, or everything", () => {
    expect(tailWindow(100, 30)).toEqual({ start: 70, duration: 30 });
    expect(tailWindow(20, 30)).toEqual({});
    expect(tailWindow(100, 0)).toEqual({});
    expect(tailWindow(null, 30)).toEqual({});
    expect(tailWindow(10.1234, 2)).toEqual({ start: 8.123, duration: 2 });
  });
  it("parseToolArgs reads inline JSON or @file and insists on an object", () => {
    expect(parseToolArgs(undefined)).toEqual({});
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs("@steps.json", (p) => (p === "steps.json" ? '{"steps":[]}' : ""))).toEqual({ steps: [] });
    expect(() => parseToolArgs("[1]")).toThrow(/JSON object/);
    expect(() => parseToolArgs("{nope")).toThrow(/not valid JSON/);
  });
});

describe("runCli", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) } };
  }
  it("prints usage and the version", async () => {
    const a = io();
    expect(await runCli(["--help"], a.io)).toBe(0);
    expect(a.out.join("")).toBe(USAGE);
    const b = io();
    expect(await runCli(["--version"], b.io)).toBe(0);
    expect(b.out.join("")).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
  it("exits 2 with a message on a usage error", async () => {
    const a = io();
    expect(await runCli(["record", "--fps", "x", "--", "true"], a.io)).toBe(2);
    expect(a.err.join("")).toMatch(/--fps must be/);
  });
  it("calls a tool in-process and reports a tool error as exit 1", async () => {
    const a = io();
    expect(await runCli(["call", "get_media_info", '{"input":"definitely-missing.mp4"}'], a.io)).toBe(1);
    expect(a.err.join("")).toMatch(/not found|ffprobe|ffmpeg/i);
  });
});
