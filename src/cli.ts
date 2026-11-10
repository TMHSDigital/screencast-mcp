/**
 * The headless command line (#179): the same tool handlers the MCP server
 * exposes, driven in-process through an in-memory MCP client, so a CI job can
 * record a desktop-app test run without an MCP client.
 *
 *   screencast-mcp record [options] -- <command...>
 *   screencast-mcp record [options] --command-env <NAME>
 *   screencast-mcp call <tool> [json | @file.json]
 *   screencast-mcp setup [options]
 *
 * With no arguments (or anything else) the binary stays the stdio MCP server;
 * index.ts only hands over when the first argument is a subcommand here.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.js";
import { MAX_RECORDING_CAP_SEC } from "./utils/targets.js";
import { DEFAULT_ERROR_PATTERN, DEFAULT_SECRET_PATTERN, MAX_ERROR_LINES, maskSecrets } from "./utils/bugReport.js";
import { defaultSetupDeps, parseSetupArgs, runSetup, SETUP_USAGE, type SetupOptions } from "./setup.js";
import { errorMessage } from "./utils/errors.js";

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** When record makes the GIF and contact sheet: only after a failing
 * command (the default), after every run, or never. */
export type ArtifactPolicy = "failure" | "always" | "never";

export interface RecordOptions {
  target: string;
  fps: number;
  /** Folder for recording.mp4, the evidence files, and evidence.json. */
  outDir: string;
  artifacts: ArtifactPolicy;
  /** The GIF covers the last this-many seconds (0 = the whole recording). */
  lastSec: number;
  gif: boolean;
  contactSheet: boolean;
  /** Delete recording.mp4 when the command succeeds. */
  discardOnSuccess: boolean;
  /** OCR the end of a failing run for error lines (Windows OCR). */
  ocrErrors: boolean;
  maxDurationSec?: number;
  /** The command to run, as given after `--` (or the one --command-env names). */
  command: string[];
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "record"; options: RecordOptions }
  | { kind: "call"; tool: string; args: string | undefined }
  | { kind: "setup"; options: SetupOptions };

/** A command line the CLI cannot run; the message says what to fix. */
export class CliUsageError extends Error {}

const SUBCOMMANDS = new Set(["record", "call", "setup", "help", "--help", "-h", "--version", "-v"]);

/** Whether these arguments are a CLI invocation rather than a server start. */
export function isCliInvocation(argv: readonly string[]): boolean {
  return argv.length > 0 && SUBCOMMANDS.has(argv[0] ?? "");
}

export const USAGE = `screencast-mcp: an MCP server for Windows screen recording.

Usage:
  screencast-mcp                          run the MCP server over stdio (default)
  screencast-mcp record [options] -- <command...>
                                          record the screen while <command> runs
  screencast-mcp record [options] --command-env <NAME>
                                          the same, running the command in env var NAME
  screencast-mcp call <tool> [json|@file] call one tool and print its result
  screencast-mcp setup [options]          check this machine and wire up MCP clients
  screencast-mcp --version | --help

record options:
  --target <target>       full | monitor:<i> | window:<title> | region:x,y,w,h (default full)
  --fps <n>               capture frame rate, 1-120 (default 15)
  --out <dir>             output folder (default screencast-evidence)
  --artifacts <when>      make the GIF and contact sheet on: failure | always | never (default failure)
  --last <sec>            the GIF covers the last <sec> seconds; 0 = all (default 30)
  --no-gif                skip the GIF
  --no-contact-sheet      skip the contact sheet
  --discard-on-success    delete the recording when the command exits 0
  --ocr-errors            on failure, OCR the last <sec> seconds for error lines (Windows OCR)
  --max-duration <sec>    stop recording after <sec> seconds, an integer 0-${MAX_RECORDING_CAP_SEC}
                          (0 = no cap; default SCREENCAST_MAX_RECORDING_SEC, else 3600)
  --command-env <NAME>    run the command line in environment variable NAME instead of
                          the arguments after --, so quotes and & survive any shell

record exits with the command's exit code and writes <out>/evidence.json.

${SETUP_USAGE}`;

function takeValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value === "--") throw new CliUsageError(`${flag} needs a value.`);
  return value;
}

function number(value: string, flag: string, min: number, max = Infinity, integer = false): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    const range = max === Infinity ? `>= ${min}` : `${min}-${max}`;
    throw new CliUsageError(`${flag} must be ${integer ? "an integer" : "a number"} ${range}, got "${value}".`);
  }
  return n;
}

function parseRecord(argv: readonly string[], env: NodeJS.ProcessEnv): RecordOptions {
  const dash = argv.indexOf("--");
  const options: RecordOptions = {
    target: "full",
    fps: 15,
    outDir: "screencast-evidence",
    artifacts: "failure",
    lastSec: 30,
    gif: true,
    contactSheet: true,
    discardOnSuccess: false,
    ocrErrors: false,
    command: dash === -1 ? [] : argv.slice(dash + 1),
  };
  let commandEnv: string | undefined;
  const flags = dash === -1 ? argv : argv.slice(0, dash);
  for (let i = 0; i < flags.length; i++) {
    const raw = flags[i] ?? "";
    // --flag=value is the same as --flag value.
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = takeValue(flags, i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case "--target":
        options.target = value();
        break;
      case "--fps":
        options.fps = number(value(), flag, 1, 120, true);
        break;
      case "--out":
        options.outDir = value();
        break;
      case "--artifacts": {
        const v = value();
        if (v !== "failure" && v !== "always" && v !== "never") {
          throw new CliUsageError(`--artifacts must be failure, always, or never, got "${v}".`);
        }
        options.artifacts = v;
        break;
      }
      case "--last":
        options.lastSec = number(value(), flag, 0);
        break;
      case "--max-duration":
        // The same bounds start_recording enforces, so a bad value fails here
        // instead of leaving the run unrecorded (#257).
        options.maxDurationSec = number(value(), flag, 0, MAX_RECORDING_CAP_SEC, true);
        break;
      case "--command-env":
        commandEnv = value();
        break;
      case "--no-gif":
        options.gif = false;
        break;
      case "--no-contact-sheet":
        options.contactSheet = false;
        break;
      case "--discard-on-success":
        options.discardOnSuccess = true;
        break;
      case "--ocr-errors":
        options.ocrErrors = true;
        break;
      default:
        throw new CliUsageError(`Unknown record option "${raw}". Run screencast-mcp --help.`);
    }
  }
  if (commandEnv !== undefined) {
    if (options.command.length > 0) {
      throw new CliUsageError("Give the command either after -- or with --command-env, not both.");
    }
    const line = env[commandEnv];
    if (line === undefined || line.trim() === "") {
      throw new CliUsageError(`--command-env ${commandEnv}: the environment variable is unset or empty.`);
    }
    // One argument: run as written by the shell, quotes and & included.
    options.command = [line];
  } else if (options.command.length === 0) {
    throw new CliUsageError("record needs a command after -- (or --command-env NAME), e.g. screencast-mcp record -- npm test");
  }
  return options;
}

/** Parses the CLI arguments (process.argv without node and the script). */
export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "--version":
    case "-v":
      return { kind: "version" };
    case "record":
      if (rest[0] === "--help" || rest[0] === "-h") return { kind: "help" };
      return { kind: "record", options: parseRecord(rest, env) };
    case "call": {
      const [tool, args, extra] = rest;
      if (!tool || tool.startsWith("-")) throw new CliUsageError("call needs a tool name, e.g. screencast-mcp call doctor");
      if (extra !== undefined) throw new CliUsageError("call takes one JSON argument; quote it as a single string.");
      return { kind: "call", tool, args };
    }
    case "setup": {
      if (rest[0] === "--help" || rest[0] === "-h") return { kind: "help" };
      try {
        return { kind: "setup", options: parseSetupArgs(rest) };
      } catch (err) {
        throw new CliUsageError(errorMessage(err));
      }
    }
    default:
      throw new CliUsageError(`Unknown command "${sub ?? ""}". Run screencast-mcp --help.`);
  }
}

// cmd.exe metacharacters, escaped with ^ (the set cross-spawn uses).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
// Windows batch shims re-parse their arguments (%*), so they need a second
// round of ^ escaping; .exe targets must not get one.
const BATCH_SHIM = /(\.(cmd|bat)$)|^(npm|npx|pnpm|yarn|corepack)$/i;

/** One argument quoted for the MSVC runtime (CommandLineToArgvW rules):
 * backslashes before a quote and at the end are doubled, quotes escaped. */
function msvcQuote(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

const NEEDS_QUOTES = /[\s"&|<>^()!;'`$*?%,[\]]/;

/** The command after `--` as one shell line for `spawn(..., { shell: true })`.
 * A single argument is used as written (so `-- "npm test && npm run e2e"` and
 * --command-env lines work). Several are joined, quoting each that needs it:
 * on Windows for cmd.exe (MSVC quoting, then ^ on every cmd metacharacter so
 * cmd's own quote state never matters, twice for npm/npx/.cmd shims, #257),
 * elsewhere for sh with single quotes. */
export function commandLine(command: readonly string[], platform: NodeJS.Platform = process.platform): string {
  if (command.length === 1) return command[0] ?? "";
  if (platform !== "win32") {
    return command.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
  }
  const batch = BATCH_SHIM.test(command[0] ?? "");
  return command
    .map((a, i) => {
      if (i === 0 || (!NEEDS_QUOTES.test(a) && a !== "")) return a;
      let q = msvcQuote(a).replace(CMD_META, "^$1");
      if (batch) q = q.replace(CMD_META, "^$1");
      return q;
    })
    .join(" ");
}

/** The command as a person would type it, for evidence.json and logs. */
export function displayCommand(command: readonly string[]): string {
  if (command.length === 1) return command[0] ?? "";
  return command.map((a) => (NEEDS_QUOTES.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

/** Where the GIF starts and how long it runs: the last `lastSec` seconds of a
 * recording `durationSec` long, or all of it. */
export function tailWindow(durationSec: number | null, lastSec: number): { start?: number; duration?: number } {
  if (!lastSec || durationSec === null || durationSec <= lastSec) return {};
  return { start: Math.round((durationSec - lastSec) * 1000) / 1000, duration: lastSec };
}

/** OCR'd error lines from find_text matches: the latest first, each line
 * once, secrets masked, at most MAX_ERROR_LINES (#268). */
export function errorLines(matches: ReadonlyArray<{ line?: unknown; text?: unknown; t?: unknown }>): string[] {
  const sorted = [...matches].sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of sorted) {
    const line = String(m.line ?? m.text ?? "").trim();
    const key = line.toLowerCase().replace(/\s+/g, " ");
    if (!line || seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
    if (lines.length >= MAX_ERROR_LINES) break;
  }
  return maskSecrets(lines, DEFAULT_SECRET_PATTERN);
}

/** Parses `call` arguments: inline JSON, `@path` to a JSON file, or none. */
export function parseToolArgs(raw: string | undefined, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  const text = raw.startsWith("@") ? readFile(raw.slice(1)) : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CliUsageError(`Tool arguments are not valid JSON: ${errorMessage(err)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError("Tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export interface ToolResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | undefined;
}

/** What the CLI needs from an MCP client: call a tool, then close. Tests
 * pass a fake; the real one runs the server in this process. */
export interface ToolClient {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** The server and an in-memory client connected to it: the tool handlers run
 * in this process, exactly as an MCP client would call them. */
export async function connect(): Promise<ToolClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  // Every toolset: SCREENCAST_TOOLSETS trims what an agent sees, not the CLI.
  await createServer({ toolsets: "all" }).connect(serverSide);
  const client = new Client({ name: "screencast-mcp-cli", version: VERSION });
  await client.connect(clientSide);
  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} omitted]`))
        .join("\n");
      return {
        isError: res.isError === true,
        text,
        structured: res.structuredContent as Record<string, unknown> | undefined,
      };
    },
    close: () => client.close(),
  };
}

export async function mustCall(client: ToolClient, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.call(name, args);
  if (res.isError) throw new Error(`${name}: ${res.text}`);
  return res.structured ?? {};
}

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: CliIo = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** Runs the command and resolves with its exit code; SIGINT/SIGTERM are
 * passed on so the recording is still stopped cleanly. */
function runCommand(command: readonly string[]): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(commandLine(command), { shell: true, stdio: "inherit" });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const done = (code: number) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolveExit(code);
    };
    child.on("error", (err) => {
      process.stderr.write(`screencast-mcp: could not run the command: ${err.message}\n`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

/** What record writes to <out>/evidence.json. */
export interface Evidence {
  command: string;
  exitCode: number;
  target: string;
  recording: string | null;
  durationSec: number | null;
  /** How long the command ran, wall clock. */
  commandSec: number;
  /** The recording session's final status: stopped | failed | ... (null
   * when no recording ran). */
  status: string | null;
  /** Why the recording ended: "stopped" when record stopped it after the
   * command; max_duration, crashed, or window_closed when it ended first
   * and the evidence does not cover the end of the run (#257). */
  endReason: string | null;
  gif: string | null;
  contactSheet: string | null;
  /** OCR'd error lines from the end of a failing run (--ocr-errors), else null. */
  errors: string[] | null;
  warnings: string[];
}

/** The warning for a recording that did not last until the command ended
 * (#257), or null when it did. */
export function earlyEndWarning(status: string | null, endReason: string | null, durationSec: number | null): string | null {
  if (status === null) return null;
  const at = durationSec === null ? "" : ` at ${durationSec} s`;
  const tail = "so the GIF and contact sheet show the end of the recording, not the end of the run.";
  if (endReason === "max_duration") {
    return `the recording hit its max-duration cap${at} before the command finished, ${tail} Raise --max-duration (0 = no cap).`;
  }
  if (status === "failed" || endReason === "crashed") {
    return `the recording failed${at} before the command finished (endReason ${endReason ?? "unknown"}), ${tail}`;
  }
  if (endReason === "window_closed") {
    return `the recorded window closed${at} before the command finished, ${tail}`;
  }
  if (endReason !== null && endReason !== "stopped") {
    return `the recording ended early${at} (endReason ${endReason}), ${tail}`;
  }
  return null;
}

export interface RecordDeps {
  connect: () => Promise<ToolClient>;
  run: (command: readonly string[]) => Promise<number>;
  now: () => number;
}

const defaultRecordDeps: RecordDeps = { connect, run: runCommand, now: () => Date.now() };

export async function runRecord(opts: RecordOptions, io: CliIo = defaultIo, deps: RecordDeps = defaultRecordDeps): Promise<number> {
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const evidence: Evidence = {
    command: displayCommand(opts.command),
    exitCode: 0,
    target: opts.target,
    recording: null,
    durationSec: null,
    commandSec: 0,
    status: null,
    endReason: null,
    gif: null,
    contactSheet: null,
    errors: null,
    warnings: [],
  };
  const warn = (msg: string) => {
    evidence.warnings.push(msg);
    io.err(`screencast-mcp: ${msg}\n`);
  };

  const client = await deps.connect();
  try {
    let sessionId: string | null = null;
    try {
      const started = await mustCall(client, "start_recording", {
        target: opts.target,
        fps: opts.fps,
        output: join(outDir, "recording.mp4"),
        overwrite: true,
        ...(opts.maxDurationSec !== undefined ? { maxDurationSec: opts.maxDurationSec } : {}),
      });
      sessionId = String(started.sessionId);
      io.err(`screencast-mcp: recording ${opts.target} to ${String(started.outputPath)}\n`);
    } catch (err) {
      // No evidence is better than a blocked test run: run the command anyway.
      warn(`recording did not start, running the command without it: ${errorMessage(err)}`);
    }

    const began = deps.now();
    evidence.exitCode = await deps.run(opts.command);
    evidence.commandSec = Math.round(deps.now() - began) / 1000;

    if (sessionId) {
      try {
        const stopped = await mustCall(client, "stop_recording", { sessionId });
        evidence.recording = String(stopped.outputPath);
        evidence.durationSec = typeof stopped.durationSec === "number" ? stopped.durationSec : null;
        evidence.status = typeof stopped.status === "string" ? stopped.status : null;
        // stop_recording reports endReason only for a session that had
        // already ended; one it stopped itself ended because we stopped it.
        evidence.endReason =
          typeof stopped.endReason === "string" ? stopped.endReason : evidence.status === "stopped" ? "stopped" : null;
        const early = earlyEndWarning(evidence.status, evidence.endReason, evidence.durationSec);
        if (early) warn(early);
      } catch (err) {
        warn(`stop_recording failed: ${errorMessage(err)}`);
      }
    }

    const failed = evidence.exitCode !== 0;
    const wanted = opts.artifacts === "always" || (opts.artifacts === "failure" && failed);
    if (evidence.recording && wanted) {
      const input = evidence.recording;
      if (opts.gif) {
        try {
          const gif = await mustCall(client, "export_gif", {
            input,
            ...tailWindow(evidence.durationSec, opts.lastSec),
            output: join(outDir, "evidence.gif"),
            overwrite: true,
          });
          evidence.gif = String(gif.outputPath);
        } catch (err) {
          warn(`export_gif failed: ${errorMessage(err)}`);
        }
      }
      if (opts.contactSheet) {
        try {
          const sheet = await mustCall(client, "contact_sheet", {
            input,
            output: join(outDir, "contact-sheet.png"),
            overwrite: true,
            returnImage: false,
          });
          evidence.contactSheet = String(sheet.outputPath);
        } catch (err) {
          warn(`contact_sheet failed: ${errorMessage(err)}`);
        }
      }
    }
    if (evidence.recording && failed && opts.ocrErrors) {
      evidence.errors = await ocrErrors(client, evidence.recording, evidence.durationSec, opts.lastSec, outDir, warn);
    }
    if (!failed && opts.discardOnSuccess && evidence.recording) {
      rmSync(evidence.recording, { force: true });
      evidence.recording = null;
    }
  } finally {
    await client.close();
  }

  writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  io.err(
    `screencast-mcp: command exited ${evidence.exitCode}; evidence in ${outDir}` +
      (evidence.gif ? ` (gif: ${evidence.gif})` : "") +
      "\n",
  );
  return evidence.exitCode;
}

/** OCR the same tail the GIF covers for error lines: find_text scans a whole
 * video, so a longer recording is first cut to its last `lastSec` seconds. */
async function ocrErrors(
  client: ToolClient,
  recording: string,
  durationSec: number | null,
  lastSec: number,
  outDir: string,
  warn: (msg: string) => void,
): Promise<string[] | null> {
  const window = tailWindow(durationSec, lastSec);
  let input = recording;
  let tail: string | null = null;
  try {
    if (window.start !== undefined) {
      const cut = await mustCall(client, "trim", {
        input: recording,
        start: window.start,
        duration: window.duration,
        output: join(outDir, ".ocr-tail.mp4"),
        overwrite: true,
      });
      tail = String(cut.outputPath);
      input = tail;
    }
    const found = await mustCall(client, "find_text", {
      input,
      scanEverySec: 1,
      maxFrames: 30,
      query: DEFAULT_ERROR_PATTERN,
      regex: true,
      returnImage: false,
    });
    const matches = Array.isArray(found.matches) ? (found.matches as Array<Record<string, unknown>>) : [];
    return errorLines(matches);
  } catch (err) {
    warn(`OCR of error lines failed: ${errorMessage(err)}`);
    return null;
  } finally {
    if (tail) rmSync(tail, { force: true });
  }
}

async function call(tool: string, rawArgs: string | undefined, io: CliIo): Promise<number> {
  const args = parseToolArgs(rawArgs);
  const client = await connect();
  try {
    const res = await client.call(tool, args);
    if (res.isError) {
      io.err(`${res.text}\n`);
      return 1;
    }
    io.out((res.structured ? JSON.stringify(res.structured, null, 2) : res.text) + "\n");
    return 0;
  } finally {
    await client.close();
  }
}

/** Runs a CLI invocation and resolves with the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.err(`screencast-mcp: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  switch (command.kind) {
    case "help":
      io.out(USAGE);
      return 0;
    case "version":
      io.out(`${VERSION}\n`);
      return 0;
    case "record":
      return runRecord(command.options, io);
    case "setup":
      return runSetup(command.options, defaultSetupDeps({ connect, io }));
    case "call":
      try {
        return await call(command.tool, command.args, io);
      } catch (err) {
        if (err instanceof CliUsageError) {
          io.err(`screencast-mcp: ${err.message}\n`);
          return 2;
        }
        throw err;
      }
  }
}
