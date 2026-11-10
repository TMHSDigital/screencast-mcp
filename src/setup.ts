/**
 * `screencast-mcp setup` (#267): first-run onboarding from one command.
 *
 *  1. Runs the doctor tool's checks and prints a checklist.
 *  2. Offers `winget install Gyan.FFmpeg` when FFmpeg 8 is missing (only with
 *     --yes or an interactive yes).
 *  3. Wires the server into Claude Desktop, Claude Code, Cursor, and VS Code:
 *     merges into their JSON config (backing up the original) or runs
 *     `claude mcp add`; --dry-run prints the change instead.
 *  4. --test records a 3 s clip and exports a GIF.
 *
 * Everything that touches the machine comes in through SetupDeps, so the
 * tests run it against a fake filesystem, environment, and process runner.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { errorMessage } from "./utils/errors.js";

export const CLIENT_IDS = ["claude-desktop", "claude-code", "cursor", "vscode"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export interface SetupOptions {
  /** Answer yes to every question (installs and config writes). */
  yes: boolean;
  /** Print what would change; install and write nothing. */
  dryRun: boolean;
  /** Offer to install FFmpeg with winget when it is missing or older than 8. */
  install: boolean;
  /** Which clients to configure: the ones found on this machine, a list, or none. */
  clients: "detected" | "none" | ClientId[];
  /** Replace an existing, different "screencast" entry. */
  force: boolean;
  /** Record a 3 s test clip and export a GIF. */
  test: boolean;
}

export const SETUP_USAGE = `setup options:
  --yes                   answer yes: install FFmpeg and write client configs without asking
  --dry-run               print the checks and the config changes; change nothing
  --clients <list>        detected (default) | none | a comma list of
                          ${CLIENT_IDS.join(", ")}
  --no-install            never offer to install FFmpeg
  --force                 replace an existing, different "screencast" server entry
  --test                  record a 3 s test clip and export a GIF

setup exits 0 when the doctor checks pass, 1 when something still needs fixing.
`;

/** The package an MCP client should start: the same npx line connect.html shows. */
export const PACKAGE = "@tmhs/screencast-mcp";
export const SERVER_NAME = "screencast";
const NPX = { command: "npx", args: ["-y", PACKAGE] };
export const WINGET_FFMPEG = ["install", "--id", "Gyan.FFmpeg", "-e", "--accept-source-agreements", "--accept-package-agreements"];

export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  const options: SetupOptions = { yes: false, dryRun: false, install: true, clients: "detected", force: false, test: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    switch (flag) {
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-install":
        options.install = false;
        break;
      case "--force":
        options.force = true;
        break;
      case "--test":
        options.test = true;
        break;
      case "--clients": {
        let value: string | undefined;
        if (eq !== -1) value = raw.slice(eq + 1);
        else value = argv[++i];
        if (value === undefined || value === "") throw new Error("--clients needs a value.");
        if (value === "detected" || value === "none") {
          options.clients = value;
          break;
        }
        const ids = value.split(",").map((s) => s.trim()).filter(Boolean);
        const bad = ids.filter((id) => !(CLIENT_IDS as readonly string[]).includes(id));
        if (bad.length > 0) {
          throw new Error(`--clients: unknown client ${bad.map((b) => `"${b}"`).join(", ")}; use ${CLIENT_IDS.join(", ")}, detected, or none.`);
        }
        options.clients = ids as ClientId[];
        break;
      }
      default:
        throw new Error(`Unknown setup option "${raw}". Run screencast-mcp --help.`);
    }
  }
  return options;
}

/** The parts of the doctor tool's report setup reads. */
export interface DoctorReport {
  ok?: boolean;
  problems?: string[];
  server?: { version?: string; node?: string };
  ffmpeg?: { found?: boolean; path?: string | null; version?: string | null; meetsFfmpeg8?: boolean | null };
  ffprobe?: { found?: boolean; version?: string | null };
  devices?: { gdigrab?: boolean; dshow?: boolean };
  wgc?: { available?: boolean };
  ocr?: { available?: boolean; language?: string | null };
  tts?: { available?: boolean };
  env?: Record<string, string | null>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SetupFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  mkdir(path: string): void;
  copyFile(from: string, to: string): void;
}

export interface SetupDeps {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  fs: SetupFs;
  /** Runs a program and resolves with its exit code and output. */
  exec: (cmd: string, args: readonly string[]) => Promise<ExecResult>;
  /** The doctor tool's structured result. */
  doctor: () => Promise<DoctorReport>;
  /** Asks a yes/no question; false when there is no one to ask. */
  confirm: (question: string) => Promise<boolean>;
  /** Records a short clip and exports a GIF; resolves with the GIF's path. */
  testClip: () => Promise<string>;
  /** Opens a file in its default app. */
  open: (path: string) => Promise<void>;
  now: () => Date;
}

/** A JSON-config client: where its config lives, the key servers go under,
 * and the entry to add (the same shapes docs/connect.html shows). */
interface JsonClient {
  id: ClientId;
  name: string;
  path: string;
  key: "mcpServers" | "servers";
  entry: Record<string, unknown>;
  /** A folder whose existence means the client is installed. */
  marker: string;
}

function appData(deps: Pick<SetupDeps, "env" | "home">): string {
  return deps.env.APPDATA ?? join(deps.home, "AppData", "Roaming");
}

export function jsonClients(deps: Pick<SetupDeps, "env" | "home">): JsonClient[] {
  const roaming = appData(deps);
  return [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      path: join(roaming, "Claude", "claude_desktop_config.json"),
      key: "mcpServers",
      entry: NPX,
      marker: join(roaming, "Claude"),
    },
    {
      id: "cursor",
      name: "Cursor",
      path: join(deps.home, ".cursor", "mcp.json"),
      key: "mcpServers",
      entry: NPX,
      marker: join(deps.home, ".cursor"),
    },
    {
      id: "vscode",
      name: "VS Code",
      // The user-level mcp.json; VS Code uses `servers`, not `mcpServers`.
      path: join(roaming, "Code", "User", "mcp.json"),
      key: "servers",
      entry: { type: "stdio", ...NPX },
      marker: join(roaming, "Code", "User"),
    },
  ];
}

/** `claude mcp add` arguments; native Windows needs the cmd /c wrapper for npx. */
export function claudeCodeArgs(platform: NodeJS.Platform): string[] {
  const run = platform === "win32" ? ["cmd", "/c", "npx", "-y", PACKAGE] : ["npx", "-y", PACKAGE];
  return ["mcp", "add", "--scope", "user", SERVER_NAME, "--", ...run];
}

export type MergeResult =
  | { status: "added"; text: string }
  | { status: "unchanged" }
  | { status: "conflict"; existing: unknown }
  | { status: "invalid"; reason: string };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Adds `name: entry` under `key` in a client config, keeping everything else.
 * `existing` is the file's text, or null when there is no file yet. */
export function mergeServerConfig(
  existing: string | null,
  key: string,
  name: string,
  entry: Record<string, unknown>,
  force = false,
): MergeResult {
  let config: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing);
    } catch (err) {
      // JSON with comments (VS Code allows them) is left for the user to edit.
      return { status: "invalid", reason: `not plain JSON (${errorMessage(err)})` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "invalid", reason: "the file is not a JSON object" };
    }
    config = parsed as Record<string, unknown>;
  }
  const servers = config[key] ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { status: "invalid", reason: `"${key}" is not an object` };
  }
  const current = (servers as Record<string, unknown>)[name];
  if (current !== undefined) {
    if (sameJson(current, entry)) return { status: "unchanged" };
    if (!force) return { status: "conflict", existing: current };
  }
  const next = { ...config, [key]: { ...(servers as Record<string, unknown>), [name]: entry } };
  return { status: "added", text: JSON.stringify(next, null, 2) + "\n" };
}

/** A line diff (- removed, + added, two spaces unchanged) of two small texts. */
export function lineDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  // Longest common subsequence table; config files are small.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push(`+ ${b[j]}`);
      j++;
    } else {
      out.push(`- ${a[i]}`);
      i++;
    }
  }
  return out.join("\n") + "\n";
}

/** Backup name for a config before it is rewritten: file.json.bak-20261031-142233. */
export function backupPath(path: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${path}.bak-${stamp}`;
}

export type CheckState = "ok" | "warn" | "fail" | "info";
export interface CheckLine {
  state: CheckState;
  text: string;
}

/** The doctor report as a checklist. */
export function checklist(report: DoctorReport, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CheckLine[] {
  const lines: CheckLine[] = [];
  const nodeMajor = Number((report.server?.node ?? process.version).replace(/^v/, "").split(".")[0]);
  lines.push({ state: nodeMajor >= 22 ? "ok" : "fail", text: `Node.js ${report.server?.node ?? process.version}${nodeMajor >= 22 ? "" : " (needs 22+)"}` });
  const ff = report.ffmpeg ?? {};
  if (!ff.found) lines.push({ state: "fail", text: "FFmpeg not found on PATH (or FFMPEG_PATH)" });
  else if (ff.meetsFfmpeg8 === false) lines.push({ state: "warn", text: `FFmpeg ${ff.version ?? "?"}: works, but transcribe and backend "wgc" need FFmpeg 8+` });
  else lines.push({ state: "ok", text: `FFmpeg ${ff.version ?? "?"}${ff.path ? ` (${ff.path})` : ""}` });
  lines.push(report.ffprobe?.found ? { state: "ok", text: `ffprobe ${report.ffprobe.version ?? ""}`.trim() } : { state: "fail", text: "ffprobe not found" });
  if (platform === "win32") {
    lines.push({ state: report.devices?.gdigrab ? "ok" : "fail", text: report.devices?.gdigrab ? "Screen capture (gdigrab)" : "No gdigrab: this ffmpeg cannot capture the screen" });
    lines.push({ state: report.wgc?.available ? "ok" : "info", text: report.wgc?.available ? "Windows Graphics Capture (backend wgc)" : 'Windows Graphics Capture unavailable (backend "wgc" needs FFmpeg 8)' });
    lines.push(
      report.ocr?.available
        ? { state: "ok", text: `Windows OCR${report.ocr.language ? ` (${report.ocr.language})` : ""}` }
        : { state: "warn", text: "Windows OCR unavailable: find_text cannot read the screen (add an OCR language in Settings > Time & language > Language)" },
    );
    if (report.tts) {
      lines.push(report.tts.available ? { state: "ok", text: "Windows speech (narrate)" } : { state: "warn", text: "No Windows voice: narrate cannot speak" });
    }
  } else {
    lines.push({ state: "warn", text: "Not Windows: capture and OCR are unavailable; the edit and watch tools work" });
  }
  const model = report.env?.SCREENCAST_WHISPER_MODEL ?? env.SCREENCAST_WHISPER_MODEL;
  lines.push(
    model
      ? { state: "ok", text: `Whisper model: ${model}` }
      : { state: "info", text: "transcribe needs a Whisper model: download a ggml model and set SCREENCAST_WHISPER_MODEL to its path" },
  );
  return lines;
}

const MARK: Record<CheckState, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]", info: "[info]" };

async function configureJsonClient(client: JsonClient, opts: SetupOptions, deps: SetupDeps): Promise<boolean> {
  const { fs } = deps;
  const had = fs.exists(client.path);
  let text: string | null = null;
  if (had) {
    try {
      text = fs.readFile(client.path);
    } catch (err) {
      deps.out(`  ${client.name}: could not read ${client.path}: ${errorMessage(err)}\n`);
      return false;
    }
  }
  const merged = mergeServerConfig(text, client.key, SERVER_NAME, client.entry, opts.force);
  switch (merged.status) {
    case "unchanged":
      deps.out(`  ${client.name}: already configured (${client.path})\n`);
      return true;
    case "invalid":
      deps.out(`  ${client.name}: left ${client.path} alone: ${merged.reason}. Add the server by hand (see docs/connect.html).\n`);
      return false;
    case "conflict":
      deps.out(`  ${client.name}: ${client.path} already has a different "${SERVER_NAME}" entry; kept it (pass --force to replace).\n`);
      return false;
  }
  if (opts.dryRun) {
    deps.out(`  ${client.name}: would ${had ? "update" : "create"} ${client.path}:\n`);
    deps.out(lineDiff(text ?? "", merged.text).replace(/^/gm, "    "));
    return true;
  }
  if (!opts.yes && !(await deps.confirm(`Add the screencast server to ${client.name} (${client.path})?`))) {
    deps.out(`  ${client.name}: skipped (run with --yes to write it, or --dry-run to see the change).\n`);
    return false;
  }
  try {
    let backup: string | null = null;
    if (had) {
      backup = backupPath(client.path, deps.now());
      fs.copyFile(client.path, backup);
    } else {
      fs.mkdir(dirname(client.path));
    }
    fs.writeFile(client.path, merged.text);
    deps.out(`  ${client.name}: ${had ? "updated" : "created"} ${client.path}${backup ? ` (backup: ${backup})` : ""}. Restart it to load the server.\n`);
    return true;
  } catch (err) {
    deps.out(`  ${client.name}: could not write ${client.path}: ${errorMessage(err)}\n`);
    return false;
  }
}

async function configureClaudeCode(opts: SetupOptions, deps: SetupDeps): Promise<boolean> {
  const args = claudeCodeArgs(deps.platform);
  const existing = await deps.exec("claude", ["mcp", "get", SERVER_NAME]);
  if (existing.code === 0) {
    deps.out(`  Claude Code: already has a "${SERVER_NAME}" server (claude mcp get ${SERVER_NAME}).\n`);
    return true;
  }
  if (opts.dryRun) {
    deps.out(`  Claude Code: would run: claude ${args.join(" ")}\n`);
    return true;
  }
  if (!opts.yes && !(await deps.confirm("Add the screencast server to Claude Code (user scope)?"))) {
    deps.out(`  Claude Code: skipped. To add it yourself: claude ${args.join(" ")}\n`);
    return false;
  }
  const res = await deps.exec("claude", args);
  if (res.code !== 0) {
    deps.out(`  Claude Code: claude mcp add failed (${(res.stderr || res.stdout).trim() || `exit ${res.code}`}).\n`);
    return false;
  }
  deps.out("  Claude Code: added (user scope). Check it with claude mcp list.\n");
  return true;
}

async function detectedClients(deps: SetupDeps): Promise<ClientId[]> {
  const found: ClientId[] = [];
  for (const c of jsonClients(deps)) if (deps.fs.exists(c.marker)) found.push(c.id);
  const claude = await deps.exec("claude", ["--version"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (claude.code === 0) found.push("claude-code");
  return CLIENT_IDS.filter((id) => found.includes(id));
}

/** Runs setup and resolves with the exit code: 0 when the doctor checks
 * pass, 1 when something still needs fixing. */
export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<number> {
  const say = deps.out;
  say(`screencast-mcp setup${opts.dryRun ? " (dry run: nothing is installed or written)" : ""}\n\n`);

  // 1. The doctor checks.
  let report: DoctorReport;
  try {
    report = await deps.doctor();
  } catch (err) {
    deps.err(`screencast-mcp: the doctor checks failed to run: ${errorMessage(err)}\n`);
    return 1;
  }
  for (const line of checklist(report, deps.env, deps.platform)) say(`${MARK[line.state]} ${line.text}\n`);
  const problems = report.problems ?? [];
  if (problems.length > 0) {
    say("\nWhat doctor says to fix:\n");
    for (const p of problems) say(`  - ${p}\n`);
  }

  // 2. FFmpeg 8 with winget.
  const ff = report.ffmpeg ?? {};
  const needsFfmpeg = !ff.found || ff.meetsFfmpeg8 === false;
  if (needsFfmpeg && opts.install && deps.platform === "win32") {
    const line = `winget ${WINGET_FFMPEG.join(" ")}`;
    say(`\nFFmpeg 8 ${ff.found ? "is not installed (found an older one)" : "is missing"}.\n`);
    if (opts.dryRun) {
      say(`  would run: ${line}\n`);
    } else if (opts.yes || (await deps.confirm("Install FFmpeg 8 with winget now?"))) {
      say(`  running: ${line}\n`);
      const res = await deps.exec("winget", WINGET_FFMPEG).catch((err: unknown) => ({
        code: 1,
        stdout: "",
        stderr: errorMessage(err),
      }));
      if (res.code === 0) say("  FFmpeg installed. Open a new terminal so PATH picks it up, then run setup again.\n");
      else say(`  winget failed (${(res.stderr || res.stdout).trim().split("\n").pop() || `exit ${res.code}`}). Install it yourself: ${line}\n`);
    } else {
      say(`  skipped. Install it yourself: ${line}\n`);
    }
  }

  // 3. MCP clients.
  if (opts.clients !== "none") {
    const ids = opts.clients === "detected" ? await detectedClients(deps) : opts.clients;
    say("\nMCP clients:\n");
    if (ids.length === 0) {
      say("  none found (Claude Desktop, Claude Code, Cursor, VS Code). Name one with --clients, or see docs/connect.html.\n");
    }
    const byId = new Map(jsonClients(deps).map((c) => [c.id, c]));
    for (const id of ids) {
      const json = byId.get(id);
      if (json) await configureJsonClient(json, opts, deps);
      else await configureClaudeCode(opts, deps);
    }
  }

  // 4. A test clip.
  if (opts.test) {
    say("\nTest clip:\n");
    if (opts.dryRun) {
      say("  would record 3 s of the screen and export a GIF.\n");
    } else {
      try {
        const gif = await deps.testClip();
        say(`  recorded 3 s and exported ${gif}\n`);
        await deps.open(gif).catch(() => undefined);
      } catch (err) {
        say(`  the test clip failed: ${errorMessage(err)}\n`);
        return 1;
      }
    }
  }

  const ok = report.ok ?? problems.length === 0;
  say(ok ? "\nAll checks passed.\n" : "\nSome checks need attention (above). Run setup again after fixing them.\n");
  return ok ? 0 : 1;
}

// ---- The real machine ----

interface ToolCaller {
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; structured: Record<string, unknown> | undefined }>;
  close(): Promise<void>;
}

function execReal(platform: NodeJS.Platform) {
  return (cmd: string, args: readonly string[]): Promise<ExecResult> =>
    new Promise((resolveExec) => {
      // .cmd shims (claude, winget aliases) need a shell on Windows; the
      // arguments here are fixed words, so no quoting is involved.
      const child = spawn(cmd, args as string[], { shell: platform === "win32", windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => resolveExec({ code: 127, stdout, stderr: err.message }));
      child.on("close", (code) => resolveExec({ code: code ?? 1, stdout, stderr }));
    });
}

const realFs: SetupFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, s) => writeFileSync(p, s),
  mkdir: (p) => void mkdirSync(p, { recursive: true }),
  copyFile: (a, b) => copyFileSync(a, b),
};

/** SetupDeps for this machine; `connect` is the CLI's in-process MCP client. */
export function defaultSetupDeps(base: {
  connect: () => Promise<ToolCaller>;
  io: { out: (s: string) => void; err: (s: string) => void };
}): SetupDeps {
  const platform = process.platform;
  const exec = execReal(platform);
  const withClient = async <T>(fn: (c: ToolCaller) => Promise<T>): Promise<T> => {
    const client = await base.connect();
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  };
  const must = async (c: ToolCaller, name: string, args: Record<string, unknown>) => {
    const res = await c.call(name, args);
    if (res.isError) throw new Error(`${name}: ${res.text}`);
    return res.structured ?? {};
  };
  return {
    out: base.io.out,
    err: base.io.err,
    env: process.env,
    platform,
    home: homedir(),
    fs: realFs,
    exec,
    doctor: () => withClient(async (c) => (await must(c, "doctor", {})) as DoctorReport),
    confirm: async (question) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    testClip: () =>
      withClient(async (c) => {
        const started = await must(c, "start_recording", { target: "full", fps: 15, maxDurationSec: 30 });
        await new Promise((r) => setTimeout(r, 3000));
        const stopped = await must(c, "stop_recording", { sessionId: String(started.sessionId) });
        const gif = await must(c, "export_gif", { input: String(stopped.outputPath) });
        return String(gif.outputPath);
      }),
    open: async (path) => {
      if (platform !== "win32" || !process.stdout.isTTY) return;
      // No shell: the path may contain spaces, and explorer.exe is an .exe.
      spawn("explorer.exe", [path], { detached: true, stdio: "ignore" }).unref();
    },
    now: () => new Date(),
  };
}
