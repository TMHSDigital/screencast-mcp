/**
 * Every path-like string field of every registered tool is covered by the
 * per-call path check (argPaths.ts). The check matches argument names, so a
 * tool that names a path field something new would otherwise skip the
 * network-path refusal and input confinement.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.SCREENCAST_HOME = mkdtempSync(join(tmpdir(), "sc-argcov-"));
const { createServer } = await import("../server.js");
const { INPUT_KEYS, LOCAL_ONLY_KEYS } = await import("../utils/argPaths.js");

/** String fields that mention a file in their description but hold no path. */
const NOT_PATHS = new Set<string>([]);

const PATHISH = /\b(path|file|folder|directory)\b|\.(mp4|json|jsonl|srt|vtt|png|ttf|bin|log|edit\.json)\b/i;
/** Names that read as a path even with no description (compose `inputs[].path`). */
const PATHISH_NAME = /(path|file|dir|folder|edit)$/i;

type Schema = { type?: string | string[]; enum?: unknown[]; description?: string; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[] };

function walk(schema: Schema | undefined, name: string, out: Array<{ name: string; description: string }>): void {
  if (!schema) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const pathish = PATHISH.test(schema.description ?? "") || PATHISH_NAME.test(name);
  if (types.includes("string") && !schema.enum && name && pathish) out.push({ name, description: schema.description ?? "" });
  for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, k, out);
  if (schema.items) walk(schema.items, name, out);
  for (const v of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) walk(v, name, out);
}

describe("path argument coverage", () => {
  it("every path-like string field of every tool is checked", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    await client.close();
    const missed: string[] = [];
    for (const tool of tools) {
      const fields: Array<{ name: string; description: string }> = [];
      walk(tool.inputSchema as Schema, "", fields);
      for (const f of fields) {
        if (!INPUT_KEYS.has(f.name) && !LOCAL_ONLY_KEYS.has(f.name) && !NOT_PATHS.has(f.name)) missed.push(`${tool.name}.${f.name}: ${f.description}`);
      }
    }
    expect(missed).toEqual([]);
  });
});
