/**
 * The built stdio entry point (#295): it answers over real stdio, exits
 * cleanly when the client goes away, and cancels a running edit on the way
 * out without leaving a .partial file (#237). Runs on every CI leg after
 * `npm run build`; the recording-disconnect case (#76) needs a desktop and
 * lives in captureSmoke.test.ts.
 *
 * src/index.ts runs in a child process, so these are process-level checks
 * and add no line coverage for it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryWorks } from "../../utils/ffmpeg.js";

const ENTRY = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
// App-only tools (the review player's) are hidden from a plain client.
const TOOLS = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../mcp-tools.json", import.meta.url)), "utf8")) as Array<{ name: string; appOnly?: boolean }>)
  .filter((t) => !t.appOnly)
  .map((t) => t.name);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const HAS_FFMPEG = binaryWorks(FFMPEG) && binaryWorks(process.env.FFPROBE_PATH || "ffprobe");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server over raw stdio, so closing stdin is a real client disconnect. */
function startServer(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, SCREENCAST_HOME: home };
  delete env.SCREENCAST_TOOLSETS;
  const srv = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  let out = "";
  let err = "";
  srv.stdout.on("data", (d) => (out += d));
  srv.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => srv.once("exit", (code) => r(code)));
  const send = (m: object) => srv.stdin.write(JSON.stringify(m) + "\n");
  /** The response to request `id`, once it arrives. */
  const response = async (id: number, ms = 30_000): Promise<Record<string, unknown>> => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.id === id) return msg;
      }
    }
    throw new Error(`no response to ${id}. stderr: ${err.slice(-400)}`);
  };
  const init = async () => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "entry", version: "0" } } });
    await response(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  /** Close stdin and wait (up to `ms`) for the exit code; undefined if it hung. */
  const disconnect = async (ms: number) => {
    srv.stdin.end();
    return Promise.race([exited, sleep(ms).then(() => undefined)]);
  };
  return { srv, send, response, init, disconnect, stderr: () => err };
}

describe.skipIf(!existsSync(ENTRY))("stdio entry point (#295)", { timeout: 90_000 }, () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "sc-entry-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("lists every tool over stdio, then exits 0 when the client disconnects", async () => {
    const s = startServer(home);
    try {
      await s.init();
      s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const list = (await s.response(2)).result as { tools: Array<{ name: string }> };
      expect(list.tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
      const code = await s.disconnect(5_000);
      expect(code, `server did not exit. stderr: ${s.stderr().slice(-400)}`).toBe(0);
      expect(s.stderr()).not.toMatch(/Uncaught|Unhandled/);
    } finally {
      s.srv.kill();
    }
  });

  it.skipIf(!HAS_FFMPEG)("cancels a running edit on disconnect and leaves no .partial file (#237)", async () => {
    const input = join(home, "long.mp4");
    const made = spawnSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=120:size=640x360:rate=30", "-c:v", "libx264", "-preset", "ultrafast", input]);
    expect(made.status, made.stderr?.toString()).toBe(0);
    const s = startServer(home);
    try {
      await s.init();
      // compress's "slow" preset keeps ffmpeg busy well past the disconnect.
      s.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compress", arguments: { input, level: "heavy" } } });
      const edits = join(home, "edits");
      for (const t0 = Date.now(); Date.now() - t0 < 20_000; await sleep(100)) {
        if (existsSync(edits) && readdirSync(edits).some((f) => f.endsWith(".partial") || f.includes(".partial."))) break;
      }
      const code = await s.disconnect(20_000);
      expect(code, `server did not exit. stderr: ${s.stderr().slice(-400)}`).toBe(0);
      expect(s.stderr()).toMatch(/cancelled 1 edit job/);
      expect(existsSync(edits) ? readdirSync(edits) : []).toEqual([]);
    } finally {
      s.srv.kill();
    }
  });
});
