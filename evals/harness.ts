/**
 * Agent eval harness (#223): the types, the MCP session wrapper, the scripted
 * "oracle" agent and the scorer. Kept free of src/ imports so it drives the
 * server only through MCP, exactly as an agent would.
 *
 * A task is scored on three things:
 *   - selection: an expected tool was called and no forbidden one was;
 *   - args:      no tool call came back as an error (bad or invalid params);
 *   - outcome:   the task's checks pass against the files the calls produced.
 * A task passes when all three hold.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Fixtures } from "./fixtures.js";

/** One tool call as the agent made it, with what the server answered. */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** The text blocks of the result, joined. */
  text: string;
  /** structuredContent, or the text parsed as a JSON object when it is one. */
  data: Record<string, unknown> | undefined;
  /** True when the harness refused the call (live capture) without sending it. */
  blocked?: boolean;
}

export interface EvalContext {
  /** Scratch dir holding the fixtures; outputs land under SCREENCAST_HOME. */
  dir: string;
  fixtures: Fixtures;
  ffmpeg: string;
  ffprobe: string;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface EvalTask {
  id: string;
  /** What the user asks for, in their words; paths are filled in from ctx. */
  prompt: (ctx: EvalContext) => string;
  /** At least one of these must be called (and succeed) for selection to pass. */
  expectTools: string[];
  /** Calling any of these fails selection (on top of the live-capture tools). */
  forbidTools?: string[];
  /** The calls a correct agent would make: drives oracle mode. */
  oracle: (ctx: EvalContext) => Array<{ name: string; args: Record<string, unknown> }>;
  /** Outcome checks. `answer` is the agent's final text, or null in oracle mode. */
  check: (ctx: EvalContext, calls: ToolCallRecord[], answer: string | null) => Promise<CheckResult[]> | CheckResult[];
  /** Platforms the task can run on (default: all). */
  platforms?: NodeJS.Platform[];
}

/** What an agent sees of the server. */
export interface EvalSession {
  instructions: string | undefined;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>>;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallRecord>;
}

export interface EvalAgent {
  name: string;
  /** Work the task through `session`; resolve with the final answer text (null when there is none). */
  run(task: EvalTask, prompt: string, session: EvalSession, ctx: EvalContext): Promise<string | null>;
}

export interface TaskScore {
  id: string;
  selection: boolean;
  args: boolean;
  outcome: boolean;
  pass: boolean;
  calls: string[];
  checks: CheckResult[];
  error?: string;
  ms: number;
}

/** Tools that capture the live screen. An eval never runs them: it must not
 * record the machine it runs on, and they are always the wrong choice for a
 * task about an existing file. */
export const LIVE_CAPTURE_TOOLS = ["start_recording", "stop_recording", "screenshot", "wait_for_change"];

function isLiveCapture(name: string, args: Record<string, unknown>): boolean {
  return LIVE_CAPTURE_TOOLS.includes(name) || (name === "find_text" && args.target !== undefined);
}

function parseData(structured: unknown, text: string): Record<string, unknown> | undefined {
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** An EvalSession over a connected MCP client that records every call. */
export function recordingSession(client: Client): EvalSession & { calls: ToolCallRecord[] } {
  const calls: ToolCallRecord[] = [];
  return {
    calls,
    instructions: client.getInstructions(),
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
    },
    async call(name, args) {
      if (isLiveCapture(name, args)) {
        const rec: ToolCallRecord = {
          name,
          args,
          isError: true,
          blocked: true,
          text: "Blocked by the eval harness: live screen capture is not allowed in evals. Work on the given files.",
          data: undefined,
        };
        calls.push(rec);
        return rec;
      }
      let rec: ToolCallRecord;
      try {
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
        const content = Array.isArray(res.content) ? (res.content as Array<{ type: string; text?: string }>) : [];
        const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        rec = { name, args, isError: res.isError === true, text, data: parseData(res.structuredContent, text) };
      } catch (err) {
        // Protocol-level failures (unknown tool, schema rejection) count as bad calls.
        rec = { name, args, isError: true, text: err instanceof Error ? err.message : String(err), data: undefined };
      }
      calls.push(rec);
      return rec;
    },
  };
}

/** Scripted agent: makes exactly the task's oracle calls. It validates the
 * harness, the fixtures and the outcome checkers without any model. */
export const oracleAgent: EvalAgent = {
  name: "oracle",
  async run(task, _prompt, session, ctx) {
    for (const step of task.oracle(ctx)) {
      await session.call(step.name, step.args);
    }
    return null;
  },
};

/** The last successful call to one of `tools`. */
export function lastOk(calls: ToolCallRecord[], tools: string[]): ToolCallRecord | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c && !c.isError && tools.includes(c.name)) return c;
  }
  return undefined;
}

/** outputPath of the last successful call to one of `tools`. */
export function outputOf(calls: ToolCallRecord[], tools: string[]): string | undefined {
  const p = lastOk(calls, tools)?.data?.outputPath;
  return typeof p === "string" ? p : undefined;
}

/** Run one task with one agent on a fresh session and score it. */
export async function scoreTask(
  task: EvalTask,
  agent: EvalAgent,
  session: EvalSession & { calls: ToolCallRecord[] },
  ctx: EvalContext,
): Promise<TaskScore> {
  const started = Date.now();
  let answer: string | null = null;
  let error: string | undefined;
  try {
    answer = await agent.run(task, task.prompt(ctx), session, ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const calls = session.calls;
  const forbidden = [...LIVE_CAPTURE_TOOLS, ...(task.forbidTools ?? [])];
  const selection =
    calls.some((c) => task.expectTools.includes(c.name)) &&
    !calls.some((c) => c.blocked === true || forbidden.includes(c.name));
  const args = calls.length > 0 && calls.every((c) => !c.isError);
  let checks: CheckResult[];
  try {
    checks = await task.check(ctx, calls, answer);
  } catch (err) {
    checks = [{ name: "checks ran", pass: false, detail: err instanceof Error ? err.message : String(err) }];
  }
  const outcome = checks.length > 0 && checks.every((c) => c.pass);
  return {
    id: task.id,
    selection,
    args,
    outcome,
    pass: selection && args && outcome && error === undefined,
    calls: calls.map((c) => (c.isError ? `${c.name}!` : c.name)),
    checks,
    ...(error !== undefined ? { error } : {}),
    ms: Date.now() - started,
  };
}

/** Opens a fresh connection to the server under test. */
export type Connect = () => Promise<{ client: Client; close: () => Promise<void> }>;

/** Run `tasks` with `agent`, each on its own fresh server connection. */
export async function runSuite(
  tasks: EvalTask[],
  agent: EvalAgent,
  ctx: EvalContext,
  connect: Connect,
  onScore?: (s: TaskScore) => void,
): Promise<EvalSummary> {
  const scores: TaskScore[] = [];
  for (const task of tasks) {
    if (task.platforms && !task.platforms.includes(process.platform)) continue;
    const { client, close } = await connect();
    try {
      const s = await scoreTask(task, agent, recordingSession(client), ctx);
      scores.push(s);
      onScore?.(s);
    } finally {
      await close();
    }
  }
  return summarize(agent.name, scores);
}

export interface EvalSummary {
  agent: string;
  tasks: number;
  passed: number;
  selection: number;
  args: number;
  outcome: number;
  scores: TaskScore[];
}

export function summarize(agent: string, scores: TaskScore[]): EvalSummary {
  const count = (f: (s: TaskScore) => boolean) => scores.filter(f).length;
  return {
    agent,
    tasks: scores.length,
    passed: count((s) => s.pass),
    selection: count((s) => s.selection),
    args: count((s) => s.args),
    outcome: count((s) => s.outcome),
    scores,
  };
}

/** A Markdown results table, for the terminal and for pasting into issues. */
export function formatTable(summary: EvalSummary): string {
  const mark = (b: boolean) => (b ? "yes" : "NO");
  const rows = summary.scores.map((s) => {
    const failed = s.checks.filter((c) => !c.pass).map((c) => c.name + (c.detail ? ` (${c.detail})` : ""));
    const note = [s.error, ...failed].filter(Boolean).join("; ");
    return `| ${s.id} | ${mark(s.selection)} | ${mark(s.args)} | ${mark(s.outcome)} | ${s.calls.join(", ") || "-"} | ${note.replace(/\|/g, "/")} |`;
  });
  const pct = (n: number) => (summary.tasks === 0 ? "0" : ((100 * n) / summary.tasks).toFixed(0));
  return [
    `Agent: ${summary.agent}. Passed ${summary.passed}/${summary.tasks} (${pct(summary.passed)}%): ` +
      `selection ${summary.selection}, args ${summary.args}, outcome ${summary.outcome}.`,
    "",
    "| task | selection | args | outcome | calls | failures |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
