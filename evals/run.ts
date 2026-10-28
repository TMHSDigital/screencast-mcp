/**
 * Agent eval runner (#223). Drives the built server (dist/index.js) over stdio
 * through the MCP SDK client, against fixture videos generated with ffmpeg at
 * run time, and prints a Markdown score table.
 *
 *   npm run build && npm run eval                 # oracle mode: no model, no network
 *   npm run eval -- --agent anthropic             # a real model (needs the SDK + credentials)
 *   npm run eval -- --task cut-dead-air,media-info --json evals/results/run.json
 *
 * Oracle mode replays each task's known-good calls. It checks the harness, the
 * fixtures and the outcome checkers (and catches handler regressions); it
 * exits non-zero on any failure. Model mode scores tool selection, argument
 * validity and outcomes for the model in EVAL_MODEL (default
 * claude-sonnet-5-5); see evals/anthropic.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { anthropicAgent } from "./anthropic.js";
import { ffmpegAvailable, ffmpegTools, makeFixtures } from "./fixtures.js";
import { formatTable, oracleAgent, runSuite, type Connect, type EvalAgent } from "./harness.js";
import { TASKS } from "./tasks.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const agentName = arg("agent") ?? process.env.EVAL_AGENT ?? "oracle";
  let agent: EvalAgent;
  if (agentName === "oracle") agent = oracleAgent;
  else if (agentName === "anthropic") agent = anthropicAgent();
  else throw new Error(`unknown --agent ${agentName} (oracle | anthropic)`);

  const only = arg("task")?.split(",").map((s) => s.trim()).filter(Boolean);
  const tasks = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  if (tasks.length === 0) throw new Error(`no task matches --task ${only?.join(",") ?? ""}`);

  if (!ffmpegAvailable()) throw new Error("ffmpeg and ffprobe must be on PATH (or set FFMPEG_PATH / FFPROBE_PATH).");
  const server = resolve(arg("server") ?? join(REPO, "dist", "index.js"));

  const dir = mkdtempSync(join(tmpdir(), "sc-eval-"));
  const home = join(dir, "home");
  mkdirSync(home);
  try {
    const fixtures = makeFixtures(dir);
    const ctx = { dir, fixtures, ...ffmpegTools() };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.SCREENCAST_HOME = home;
    // Evals must never prompt; capture tools are blocked by the harness anyway.
    delete env.SCREENCAST_CONFIRM_CAPTURE;
    const connect: Connect = async () => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "ignore" });
      const client = new Client({ name: "screencast-eval", version: "0.0.0" });
      await client.connect(transport);
      return { client, close: () => client.close() };
    };
    process.stderr.write(`Running ${tasks.length} task(s) with ${agent.name} against ${server}\n`);
    const summary = await runSuite(tasks, agent, ctx, connect, (s) =>
      process.stderr.write(`  ${s.pass ? "pass" : "FAIL"}  ${s.id} (${s.ms} ms)\n`),
    );
    process.stdout.write(`${formatTable(summary)}\n`);
    const out = arg("json");
    if (out) {
      const record = { date: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, ...summary };
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), `${JSON.stringify(record, null, 2)}\n`);
    }
    // Oracle mode is a self-check: every task must pass.
    return agent === oracleAgent && summary.passed !== summary.tasks ? 1 : 0;
  } finally {
    if (!process.env.EVAL_KEEP) rmSync(dir, { recursive: true, force: true });
    else process.stderr.write(`Kept eval files in ${dir}\n`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
