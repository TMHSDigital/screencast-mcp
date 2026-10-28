/**
 * Opt-in toolsets, server instructions, and the tools/list size budget (#214).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseToolsets, serverInstructions, TOOLSETS, toolsetOf } from "../utils/toolsets.js";

const home = mkdtempSync(join(tmpdir(), "sc-toolsets-"));
process.env.SCREENCAST_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

/**
 * Budget for the default tools/list, in bytes of compact JSON (~4 bytes per
 * token). It was 83.4 KB before #214 and about 71 KB after; 0.45.0's six new
 * tools (save_replay, bug_report, backdrop, keystroke_overlay, add_marker,
 * chapters) took it to about 84.4 KB, and 0.46.0's index_recording,
 * search_recording, step_guide, cut_by_transcript, and pipeline recipes to
 * about 91 KB. Raise it only deliberately, after trying to say the new thing in
 * fewer words; SCREENCAST_TOOLSETS trims it per client.
 */
const TOOLS_LIST_BUDGET_BYTES = 92_000;

const manifest = JSON.parse(readFileSync(join(process.cwd(), "mcp-tools.json"), "utf8")) as Array<{
  name: string;
  toolset?: string;
}>;

async function connect(toolsets?: string) {
  const { createServer } = await import("../server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ toolsets }).connect(serverSide);
  const client = new Client({ name: "toolsets-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("parseToolsets", () => {
  it("enables everything when unset, empty, or all", () => {
    for (const v of [undefined, "", " ", "all", "ALL", "capture,all"]) {
      const s = parseToolsets(v);
      expect(s.all).toBe(true);
      expect(s.enabled).toEqual(Object.keys(TOOLSETS));
    }
  });
  it("selects the named toolsets plus core, ignoring case and spaces", () => {
    const s = parseToolsets(" Capture , watch ");
    expect(s.enabled).toEqual(["core", "capture", "watch"]);
    expect(s.all).toBe(false);
    expect(s.unknown).toEqual([]);
  });
  it("reports unknown names, and falls back to all when nothing known is named", () => {
    expect(parseToolsets("capture,bogus").unknown).toEqual(["bogus"]);
    const typo = parseToolsets("captur");
    expect(typo.all).toBe(true);
    expect(typo.unknown).toEqual(["captur"]);
  });
});

describe("toolset membership", () => {
  it("puts every tool in exactly one toolset, matching mcp-tools.json", () => {
    const all = Object.values(TOOLSETS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(manifest.map((t) => t.name).sort());
    for (const t of manifest) expect(t.toolset, t.name).toBe(toolsetOf(t.name));
  });
});

describe("server instructions", () => {
  it("are sent at initialize and map the workflow", async () => {
    const client = await connect();
    try {
      const text = client.getInstructions() ?? "";
      expect(text).toMatch(/pipeline/);
      expect(text).toMatch(/start_recording/);
      expect(text).toMatch(/redact/);
      expect(text).not.toMatch(/Enabled toolsets/);
      expect(text.length).toBeLessThan(2_500);
    } finally {
      await client.close();
    }
  });
  it("name the enabled toolsets and skip the disabled ones", () => {
    const text = serverInstructions(parseToolsets("capture"));
    expect(text).toMatch(/Enabled toolsets: core, capture/);
    expect(text).not.toMatch(/pipeline/);
  });
});

describe("tools/list", () => {
  it(`stays within the ${TOOLS_LIST_BUDGET_BYTES}-byte budget by default`, async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      const bytes = JSON.stringify({ tools }).length;
      expect(bytes, `tools/list is ${bytes} bytes`).toBeLessThanOrEqual(TOOLS_LIST_BUDGET_BYTES);
    } finally {
      await client.close();
    }
  });

  it("lists only the selected toolsets, and the rest cannot be called", async () => {
    const client = await connect("capture");
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...TOOLSETS.core, ...TOOLSETS.capture].sort());
      const res = await client.callTool({ name: "pipeline", arguments: { input: "x.mp4", steps: [] } });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
