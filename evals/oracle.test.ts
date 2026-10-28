/**
 * The eval harness itself (#223), in oracle mode: fixtures generate, the
 * known-good calls pass every check, and a wrong-tool agent is scored down
 * without its live-capture call ever reaching the server. Runs the server
 * in-process over an in-memory transport, so no build is needed. Needs
 * ffmpeg; skipped without it unless REQUIRE_FFMPEG is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ffmpegAvailable, ffmpegTools, makeFixtures } from "./fixtures.js";
import { oracleAgent, runSuite, type Connect, type EvalAgent, type EvalContext } from "./harness.js";
import { TASKS } from "./tasks.js";

const RUN = ffmpegAvailable() || !!process.env.REQUIRE_FFMPEG;

describe.runIf(RUN)("eval harness (oracle mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-evaltest-"));
  let ctx: EvalContext;
  let connect: Connect;

  beforeAll(async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    process.env.SCREENCAST_HOME = home;
    ctx = { dir, fixtures: makeFixtures(dir), ...ffmpegTools() };
    const { createServer } = await import("../src/server.js");
    connect = async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const server = createServer();
      await server.connect(serverSide);
      const client = new Client({ name: "eval-test", version: "0.0.0" });
      await client.connect(clientSide);
      return {
        client,
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    };
  }, 60_000);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pick = (...ids: string[]) => TASKS.filter((t) => ids.includes(t.id));

  it("passes the redaction and dead-air tasks with the oracle's calls", async () => {
    const summary = await runSuite(pick("redact-api-key", "cut-dead-air"), oracleAgent, ctx, connect);
    expect(summary.tasks).toBe(2);
    for (const s of summary.scores) expect(s, JSON.stringify(s.checks)).toMatchObject({ pass: true });
  }, 120_000);

  it("scores a wrong-tool agent down and never runs its capture call", async () => {
    const screenshotter: EvalAgent = {
      name: "screenshotter",
      async run(_task, _prompt, session) {
        await session.call("screenshot", { target: "full" });
        return "It is 6 seconds long at 320x240.";
      },
    };
    const summary = await runSuite(pick("media-info"), screenshotter, ctx, connect);
    const s = summary.scores[0];
    expect(s).toBeDefined();
    expect(s?.pass).toBe(false);
    expect(s?.selection).toBe(false);
    expect(s?.calls).toEqual(["screenshot!"]);
    // The answer is right, but nothing was probed: the outcome check fails too.
    expect(s?.outcome).toBe(false);
  }, 60_000);
});
