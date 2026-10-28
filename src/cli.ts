/**
 * The headless command line (#179): the same tool handlers the MCP server
 * exposes, driven in-process through an in-memory MCP client, so a CI job can
 * record a desktop-app test run without an MCP client.
 *
 *   screencast-mcp record [options] -- <command...>
 *   screencast-mcp call <tool> [json | @file.json]
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
  maxDurationSec?: number;
  /** The command to run, as given after `--`. */
  command: string[];
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "record"; options: RecordOptions }
  | { kind: "call"; tool: string; args: string | undefined };

/** A command line the CLI cannot run; the message says what to fix. */
export class CliUsageError extends Error {}

const SUBCOMMANDS = new Set(["record", "call", "help", "--help", "-h", "--version", "-v"]);

/** Whether these arguments are a CLI invocation rather than a server start. */
export function isCliInvocation(argv: readonly string[]): boolean {
  return argv.length > 0 && SUBCOMMANDS.has(argv[0] ?? "");
}

export const USAGE = `screencast-mcp: an MCP server for Windows screen recording.

Usage:
  screencast-mcp                          run the MCP server over stdio (default)
  screencast-mcp record [options] -- <command...>
                                          record the screen while <command> runs
  screencast-mcp call <tool> [json|@file] call one tool and print its result
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
  --max-duration <sec>    stop recording after <sec> seconds (default SCREENCAST_MAX_RECORDING_SEC)

record exits with the command's exit code and writes <out>/evidence.json.
`;

function takeValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value === "--") throw new CliUsageError(`${flag} needs a value.`);
  return value;
}

function number(value: string, flag: string, min: number, max = Infinity, integer = false): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    const range = max === Infinity ? `>= ${min}` : `${min}-${max}`;
    throw new CliUsageError(`${flag} must be ${integer ? "an integer" : "a number"} ${range}, got "${value}".`);
  }
  return n;
}

function parseRecord(argv: readonly string[]): RecordOptions {
  const dash = argv.indexOf("--");
  if (dash === -1 || dash === argv.length - 1) {
    throw new CliUsageError("record needs a command after --, e.g. screencast-mcp record -- npm test");
  }
  const options: RecordOptions = {
    target: "full",
    fps: 15,
    outDir: "screencast-evidence",
    artifacts: "failure",
    lastSec: 30,
    gif: true,
    contactSheet: true,
    discardOnSuccess: false,
    command: argv.slice(dash + 1),
  };
  const flags = argv.slice(0, dash);
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
        options.maxDurationSec = number(value(), flag, 0);
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
      default:
        throw new CliUsageError(`Unknown record option "${raw}". Run screencast-mcp --help.`);
    }
  }
  return options;
}

/** Parses the CLI arguments (process.argv without node and the script). */
export function parseCliArgs(argv: readonly string[]): CliCommand {
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
      return { kind: "record", options: parseRecord(rest) };
    case "call": {
      const [tool, args, extra] = rest;
      if (!tool || tool.startsWith("-")) throw new CliUsageError("call needs a tool name, e.g. screencast-mcp call doctor");
      if (extra !== undefined) throw new CliUsageError("call takes one JSON argument; quote it as a single string.");
      return { kind: "call", tool, args };
    }
    default:
      throw new CliUsageError(`Unknown command "${sub ?? ""}". Run screencast-mcp --help.`);
  }
}

/** The command after `--` as one shell line. A single argument is used as
 * written (so `-- "npm test && npm run e2e"` works); several are joined,
 * double-quoting any that contain spaces, quotes, or shell metacharacters. */
export function commandLine(command: readonly string[]): string {
  if (command.length === 1) return command[0] ?? "";
  return command.map((a) => (/[\s"&|<>^()!;'`$*?]/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

/** Where the GIF starts and how long it runs: the last `lastSec` seconds of a
 * recording `durationSec` long, or all of it. */
export function tailWindow(durationSec: number | null, lastSec: number): { start?: number; duration?: number } {
  if (!lastSec || durationSec === null || durationSec <= lastSec) return {};
  return { start: Math.round((durationSec - lastSec) * 1000) / 1000, duration: lastSec };
}

/** Parses `call` arguments: inline JSON, `@path` to a JSON file, or none. */
export function parseToolArgs(raw: string | undefined, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  const text = raw.startsWith("@") ? readFile(raw.slice(1)) : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CliUsageError(`Tool arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError("Tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

interface ToolResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | undefined;
}

/** The server and an in-memory client connected to it: the tool handlers run
 * in this process, exactly as an MCP client would call them. */
async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  // Every toolset: SCREENCAST_TOOLSETS trims what an agent sees, not the CLI.
  await createServer({ toolsets: "all" }).connect(serverSide);
  const client = new Client({ name: "screencast-mcp-cli", version: VERSION });
  await client.connect(clientSide);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} omitted]`))
    .join("\n");
  return {
    isError: res.isError === true,
    text,
    structured: res.structuredContent as Record<string, unknown> | undefined,
  };
}

async function mustCall(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await callTool(client, name, args);
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
  gif: string | null;
  contactSheet: string | null;
  warnings: string[];
}

async function record(opts: RecordOptions, io: CliIo): Promise<number> {
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const evidence: Evidence = {
    command: commandLine(opts.command),
    exitCode: 0,
    target: opts.target,
    recording: null,
    durationSec: null,
    gif: null,
    contactSheet: null,
    warnings: [],
  };
  const warn = (msg: string) => {
    evidence.warnings.push(msg);
    io.err(`screencast-mcp: ${msg}\n`);
  };

  const client = await connect();
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
      warn(`recording did not start, running the command without it: ${err instanceof Error ? err.message : String(err)}`);
    }

    evidence.exitCode = await runCommand(opts.command);

    if (sessionId) {
      try {
        const stopped = await mustCall(client, "stop_recording", { sessionId });
        evidence.recording = String(stopped.outputPath);
        evidence.durationSec = typeof stopped.durationSec === "number" ? stopped.durationSec : null;
      } catch (err) {
        warn(`stop_recording failed: ${err instanceof Error ? err.message : String(err)}`);
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
          warn(`export_gif failed: ${err instanceof Error ? err.message : String(err)}`);
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
          warn(`contact_sheet failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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

async function call(tool: string, rawArgs: string | undefined, io: CliIo): Promise<number> {
  const args = parseToolArgs(rawArgs);
  const client = await connect();
  try {
    const res = await callTool(client, tool, args);
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
      return record(command.options, io);
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
