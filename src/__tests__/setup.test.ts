/**
 * #267: `screencast-mcp setup` against a fake filesystem, environment, and
 * process runner. Nothing is installed or written to the real machine.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseCliArgs } from "../cli.js";
import {
  backupPath,
  checklist,
  claudeCodeArgs,
  lineDiff,
  mergeServerConfig,
  parseSetupArgs,
  runSetup,
  WINGET_FFMPEG,
  type DoctorReport,
  type ExecResult,
  type SetupDeps,
  type SetupOptions,
} from "../setup.js";

const HOME = join("C:", "Users", "me");
const APPDATA = join(HOME, "AppData", "Roaming");
const DESKTOP = join(APPDATA, "Claude", "claude_desktop_config.json");
const CURSOR = join(HOME, ".cursor", "mcp.json");
const VSCODE = join(APPDATA, "Code", "User", "mcp.json");

const healthy: DoctorReport = {
  ok: true,
  problems: [],
  server: { version: "1.0.0", node: "v22.10.0" },
  ffmpeg: { found: true, path: "C:/ffmpeg/bin/ffmpeg.exe", version: "8.0", meetsFfmpeg8: true },
  ffprobe: { found: true, version: "8.0" },
  devices: { gdigrab: true, dshow: true },
  wgc: { available: true },
  ocr: { available: true, language: "en-US" },
  tts: { available: true },
  env: {},
};

function fakeDeps(opts: {
  files?: Record<string, string>;
  dirs?: string[];
  report?: DoctorReport;
  exec?: (cmd: string, args: readonly string[]) => ExecResult;
  confirm?: boolean;
}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const dirs = new Set(opts.dirs ?? []);
  const execs: string[] = [];
  const out: string[] = [];
  const opened: string[] = [];
  let clips = 0;
  const deps: SetupDeps = {
    out: (s) => void out.push(s),
    err: (s) => void out.push(s),
    env: { APPDATA },
    platform: "win32",
    home: HOME,
    fs: {
      exists: (p) => files.has(p) || dirs.has(p),
      readFile: (p) => {
        const t = files.get(p);
        if (t === undefined) throw new Error(`ENOENT ${p}`);
        return t;
      },
      writeFile: (p, s) => void files.set(p, s),
      mkdir: (p) => void dirs.add(p),
      copyFile: (a, b) => void files.set(b, files.get(a) ?? ""),
    },
    exec: async (cmd, args) => {
      execs.push(`${cmd} ${args.join(" ")}`);
      return opts.exec?.(cmd, args) ?? { code: 1, stdout: "", stderr: "not found" };
    },
    doctor: async () => opts.report ?? healthy,
    confirm: async () => opts.confirm ?? false,
    testClip: async () => {
      clips++;
      return "C:/rec/test.gif";
    },
    open: async (p) => void opened.push(p),
    now: () => new Date(2026, 9, 31, 14, 22, 33),
  };
  return { deps, files, dirs, execs, text: () => out.join(""), opened, clips: () => clips };
}

const opts = (argv: string[] = []): SetupOptions => parseSetupArgs(argv);

describe("parseSetupArgs", () => {
  it("applies the defaults and reads every flag", () => {
    expect(opts()).toEqual({ yes: false, dryRun: false, install: true, clients: "detected", force: false, test: false });
    expect(opts(["--yes", "--dry-run", "--no-install", "--force", "--test", "--clients=cursor,vscode"])).toEqual({
      yes: true, dryRun: true, install: false, clients: ["cursor", "vscode"], force: true, test: true,
    });
    expect(opts(["--clients", "none"]).clients).toBe("none");
  });
  it("rejects unknown flags and clients", () => {
    expect(() => opts(["--bogus"])).toThrow(/Unknown setup option/);
    expect(() => opts(["--clients", "emacs"])).toThrow(/unknown client "emacs"/);
  });
  it("is reachable from the CLI", () => {
    expect(parseCliArgs(["setup", "--yes"])).toMatchObject({ kind: "setup", options: { yes: true } });
    expect(() => parseCliArgs(["setup", "--nope"])).toThrow(/Unknown setup option/);
  });
});

describe("mergeServerConfig", () => {
  const entry = { command: "npx", args: ["-y", "@tmhs/screencast-mcp"] };
  it("creates a config, and merges into an existing one keeping other servers and keys", () => {
    const fresh = mergeServerConfig(null, "mcpServers", "screencast", entry);
    expect(fresh.status).toBe("added");
    if (fresh.status === "added") expect(JSON.parse(fresh.text)).toEqual({ mcpServers: { screencast: entry } });
    const merged = mergeServerConfig(JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }), "mcpServers", "screencast", entry);
    if (merged.status !== "added") throw new Error(merged.status);
    expect(JSON.parse(merged.text)).toEqual({ theme: "dark", mcpServers: { other: { command: "x" }, screencast: entry } });
  });
  it("leaves identical, different, and unparseable configs alone", () => {
    expect(mergeServerConfig(JSON.stringify({ mcpServers: { screencast: entry } }), "mcpServers", "screencast", entry).status).toBe("unchanged");
    expect(mergeServerConfig(JSON.stringify({ mcpServers: { screencast: { command: "node" } } }), "mcpServers", "screencast", entry).status).toBe("conflict");
    expect(mergeServerConfig(JSON.stringify({ mcpServers: { screencast: { command: "node" } } }), "mcpServers", "screencast", entry, true).status).toBe("added");
    expect(mergeServerConfig("{ // comment\n}", "servers", "screencast", entry).status).toBe("invalid");
    expect(mergeServerConfig("[]", "servers", "screencast", entry).status).toBe("invalid");
    expect(mergeServerConfig(JSON.stringify({ servers: [] }), "servers", "screencast", entry).status).toBe("invalid");
  });
});

describe("helpers", () => {
  it("lineDiff marks added and removed lines", () => {
    expect(lineDiff("a\nb\n", "a\nc\nb\n")).toBe("  a\n+ c\n  b\n");
    expect(lineDiff("", "x\n")).toBe("+ x\n");
    expect(lineDiff("x\n", "y\n")).toBe("+ y\n- x\n");
  });
  it("backupPath stamps the time", () => {
    expect(backupPath("c.json", new Date(2026, 0, 2, 3, 4, 5))).toBe("c.json.bak-20260102-030405");
  });
  it("claudeCodeArgs wraps npx in cmd /c on Windows only", () => {
    expect(claudeCodeArgs("win32")).toEqual(["mcp", "add", "--scope", "user", "screencast", "--", "cmd", "/c", "npx", "-y", "@tmhs/screencast-mcp"]);
    expect(claudeCodeArgs("linux").slice(-3)).toEqual(["npx", "-y", "@tmhs/screencast-mcp"]);
  });
  it("checklist reports FFmpeg, OCR, and the Whisper hint", () => {
    const lines = checklist({ ...healthy, ffmpeg: { found: true, version: "7.1", meetsFfmpeg8: false }, ocr: { available: false } }, {}, "win32");
    expect(lines.find((l) => /FFmpeg 7.1/.test(l.text))?.state).toBe("warn");
    expect(lines.find((l) => /OCR/.test(l.text))?.state).toBe("warn");
    expect(lines.find((l) => /Whisper/.test(l.text))?.state).toBe("info");
  });
});

describe("runSetup", () => {
  it("prints the checklist and exits 0 on a healthy machine with no clients", async () => {
    const f = fakeDeps({});
    expect(await runSetup(opts(), f.deps)).toBe(0);
    expect(f.text()).toMatch(/\[ok\] {3}FFmpeg 8\.0/);
    expect(f.text()).toMatch(/none found/);
    expect(f.text()).toMatch(/All checks passed/);
  });

  it("offers winget when FFmpeg 8 is missing, and runs it only with --yes", async () => {
    const report: DoctorReport = { ...healthy, ok: false, problems: ["ffmpeg not found"], ffmpeg: { found: false } };
    const ask = fakeDeps({ report });
    expect(await runSetup(opts(["--clients", "none"]), ask.deps)).toBe(1);
    expect(ask.execs.some((e) => e.startsWith("winget"))).toBe(false);
    expect(ask.text()).toMatch(/skipped\. Install it yourself: winget install --id Gyan\.FFmpeg/);

    const yes = fakeDeps({ report, exec: (cmd) => (cmd === "winget" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" }) });
    await runSetup(opts(["--yes", "--clients", "none"]), yes.deps);
    expect(yes.execs).toContain(`winget ${WINGET_FFMPEG.join(" ")}`);
    expect(yes.text()).toMatch(/FFmpeg installed/);

    const dry = fakeDeps({ report });
    await runSetup(opts(["--yes", "--dry-run", "--clients", "none"]), dry.deps);
    expect(dry.execs).toEqual([]);
    expect(dry.text()).toMatch(/would run: winget install/);
  });

  it("--dry-run prints a diff for each detected client and writes nothing", async () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n";
    const f = fakeDeps({ files: { [DESKTOP]: existing }, dirs: [join(APPDATA, "Claude"), join(HOME, ".cursor")] });
    await runSetup(opts(["--dry-run"]), f.deps);
    expect(f.files.get(DESKTOP)).toBe(existing);
    expect(f.files.has(CURSOR)).toBe(false);
    expect(f.text()).toMatch(/Claude Desktop: would update/);
    expect(f.text()).toMatch(/\+ +"screencast": \{/);
    expect(f.text()).toMatch(/Cursor: would create/);
    expect(f.text()).not.toMatch(/VS Code/);
  });

  it("--yes merges configs, backs up the original, and adds Claude Code", async () => {
    const existing = JSON.stringify({ servers: { other: { type: "stdio", command: "x" } } });
    const f = fakeDeps({
      files: { [VSCODE]: existing },
      dirs: [join(APPDATA, "Code", "User")],
      exec: (cmd, args) => (cmd === "claude" && args[0] !== "mcp" ? { code: 0, stdout: "2.0.0", stderr: "" } : cmd === "claude" && args[1] === "add" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
    });
    expect(await runSetup(opts(["--yes"]), f.deps)).toBe(0);
    const backup = `${VSCODE}.bak-20261031-142233`;
    expect(f.files.get(backup)).toBe(existing);
    expect(JSON.parse(f.files.get(VSCODE) ?? "")).toEqual({
      servers: { other: { type: "stdio", command: "x" }, screencast: { type: "stdio", command: "npx", args: ["-y", "@tmhs/screencast-mcp"] } },
    });
    expect(f.execs).toContain("claude mcp add --scope user screencast -- cmd /c npx -y @tmhs/screencast-mcp");
    expect(f.text()).toMatch(/Claude Code: added/);
  });

  it("asks before writing and skips when the answer is no", async () => {
    const f = fakeDeps({ dirs: [join(HOME, ".cursor")], confirm: false });
    await runSetup(opts(["--clients", "cursor"]), f.deps);
    expect(f.files.has(CURSOR)).toBe(false);
    expect(f.text()).toMatch(/Cursor: skipped/);
    const g = fakeDeps({ dirs: [join(HOME, ".cursor")], confirm: true });
    await runSetup(opts(["--clients", "cursor"]), g.deps);
    expect(g.files.has(CURSOR)).toBe(true);
    expect(g.dirs.has(join(HOME, ".cursor"))).toBe(true);
  });

  it("keeps a different existing entry unless --force", async () => {
    const mine = JSON.stringify({ mcpServers: { screencast: { command: "node", args: ["dist/index.js"] } } });
    const f = fakeDeps({ files: { [CURSOR]: mine } });
    await runSetup(opts(["--yes", "--clients", "cursor"]), f.deps);
    expect(f.files.get(CURSOR)).toBe(mine);
    expect(f.text()).toMatch(/different "screencast" entry; kept it/);
  });

  it("--test records a clip and opens the GIF", async () => {
    const f = fakeDeps({});
    expect(await runSetup(opts(["--test", "--clients", "none"]), f.deps)).toBe(0);
    expect(f.clips()).toBe(1);
    expect(f.opened).toEqual(["C:/rec/test.gif"]);
    const dry = fakeDeps({});
    await runSetup(opts(["--test", "--dry-run", "--clients", "none"]), dry.deps);
    expect(dry.clips()).toBe(0);
  });
});
