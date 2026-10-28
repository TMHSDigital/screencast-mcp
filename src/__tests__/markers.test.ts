/**
 * add_marker through the MCP tool layer (#174): live markers on the video
 * clock, kept in the session record (and so in get_session) and in the
 * sidecar, plus marking a stopped recording or a plain file with `at`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = mkdtempSync(join(tmpdir(), "sc-markers-tool-"));
process.env.SCREENCAST_HOME = home;
let client: Client;

beforeAll(async () => {
  const { createServer } = await import("../server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "markers-test", version: "0.0.0" });
  await client.connect(clientSide);
});
afterAll(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { isError: res.isError === true, text, json: res.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
}

describe("add_marker (#174)", () => {
  it("stamps a running recording on its video clock and keeps the markers through a stop", async () => {
    const { getStore } = await import("../context.js");
    const output = join(home, "rec.mp4");
    const store = getStore();
    store.create({
      id: "rec-live",
      target: "full",
      outputPath: output,
      fps: 30,
      quality: "standard",
      pid: null,
      status: "recording",
      startedAt: new Date().toISOString(),
      videoStartMs: Date.now() - 5_000,
    });

    const live = await call("add_marker", { sessionId: "rec-live", label: "bug appears" });
    expect(live.isError, live.text).toBe(false);
    const t = (live.json!.marker as { t: number }).t;
    expect(t).toBeGreaterThanOrEqual(5);
    expect(t).toBeLessThan(10);
    await call("add_marker", { sessionId: "rec-live", label: "earlier", at: 1 });

    // A stop patches other fields only; the markers stay (#235 merge).
    store.update("rec-live", { status: "stopped", stoppedAt: new Date().toISOString(), durationSec: 20 });
    const got = await call("get_session", { sessionId: "rec-live" });
    expect((got.json!.markers as Array<{ label: string }>).map((m) => m.label)).toEqual(["earlier", "bug appears"]);
    const sidecar = JSON.parse(readFileSync(join(home, "rec.markers.json"), "utf8"));
    expect(sidecar.sessionId).toBe("rec-live");
    expect(sidecar.markers).toHaveLength(2);

    // Stopped: "now" means nothing, a time inside the video is fine, past the end is not.
    const now = await call("add_marker", { sessionId: "rec-live", label: "late" });
    expect(now.isError).toBe(true);
    expect(now.text).toMatch(/Pass at/);
    expect((await call("add_marker", { sessionId: "rec-live", label: "x", at: 25 })).text).toMatch(/past the end/);
    const later = await call("add_marker", { sessionId: "rec-live", label: "fixed", at: 15 });
    expect(later.json!.count).toBe(3);
  });

  it("marks a plain file in its sidecar, with at", async () => {
    const video = join(home, "plain.mp4");
    writeFileSync(video, "not really a video");
    expect((await call("add_marker", { input: video, label: "x" })).text).toMatch(/Pass at/);
    const res = await call("add_marker", { input: video, label: "step 2", at: 3.5 });
    expect(res.isError, res.text).toBe(false);
    expect(existsSync(join(home, "plain.markers.json"))).toBe(true);
    expect((await call("add_marker", { label: "x" })).text).toMatch(/sessionId or input/);
    expect((await call("add_marker", { sessionId: "nope", label: "x" })).text).toMatch(/No session/);
  });
});
