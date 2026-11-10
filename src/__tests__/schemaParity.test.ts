/**
 * Each pipeline step advertises the same option schemas as its standalone
 * tool (#309). Descriptions are ignored: steps leave them out to keep
 * tools/list small (#214). Only options both sides have are compared.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.SCREENCAST_HOME = mkdtempSync(join(tmpdir(), "sc-parity-"));
const { createServer } = await import("../server.js");

type Json = Record<string, unknown>;

/** Step op -> its tool, and step option -> tool option where they differ. */
const PAIRS: Record<string, { tool: string; rename?: Record<string, string> }> = {
  trim: { tool: "trim" },
  crop: { tool: "crop" },
  scale: { tool: "scale" },
  speed: { tool: "speed" },
  redact: { tool: "redact_region" },
  callout: { tool: "callout" },
  reframe: { tool: "reframe" },
  zoom: { tool: "zoom" },
  cut_idle: { tool: "cut_idle" },
  burn_subtitles: { tool: "burn_subtitles" },
  backdrop: { tool: "backdrop" },
  keystroke_overlay: { tool: "keystroke_overlay" },
  cursor: { tool: "cursor" },
  export_preset: { tool: "export_preset" },
  export_gif: { tool: "export_gif" },
};
/** Deliberate differences, with the reason. */
const KNOWN: Record<string, string> = {
  // The step plans zoom only from clicks: "auto" and "changes" need an
  // analysis pass over the source that the pipeline does not run.
  "zoom.follow": "pipeline zoom follows clicks only",
  // In a step, keyframes is either given (non-empty) or replaced by follow.
  "zoom.keyframes": "a step's keyframes list may not be empty",
};
/** The audio step bundles two tools' options. */
const AUDIO: Record<string, [string, string]> = { normalize: ["normalize_audio", "target"], denoise: ["denoise", "strength"] };

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Json)
        .filter(([k]) => k !== "description" && k !== "$schema")
        .map(([k, x]) => [k, strip(x)]),
    );
  }
  return v;
}

describe("pipeline steps match their tools' schemas (#309)", () => {
  const tools = new Map<string, Json>();
  let steps: Json[] = [];

  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    const client = new Client({ name: "parity", version: "0" });
    await client.connect(b);
    for (const t of (await client.listTools()).tools) tools.set(t.name, t.inputSchema as Json);
    const stepsSchema = ((tools.get("pipeline")!.properties as Json).steps as Json).items as Json;
    steps = (stepsSchema.anyOf ?? stepsSchema.oneOf) as Json[];
  });

  it("covers every step op", () => {
    const ops = steps.map((s) => ((s.properties as Json).op as Json).const as string).sort();
    expect(ops).toEqual([...Object.keys(PAIRS), "audio"].sort());
  });

  it("gives every shared option the same schema", () => {
    const drift: string[] = [];
    for (const s of steps) {
      const props = s.properties as Json;
      const op = (props.op as Json).const as string;
      for (const [name, schema] of Object.entries(props)) {
        if (name === "op") continue;
        const [tool, option] = op === "audio" ? AUDIO[name]! : [PAIRS[op]!.tool, PAIRS[op]!.rename?.[name] ?? name];
        const toolProp = (tools.get(tool)?.properties as Json | undefined)?.[option];
        if (toolProp === undefined || KNOWN[`${op}.${name}`]) continue;
        if (JSON.stringify(strip(schema)) !== JSON.stringify(strip(toolProp))) {
          drift.push(`${op}.${name} vs ${tool}.${option}:\n  step ${JSON.stringify(strip(schema))}\n  tool ${JSON.stringify(strip(toolProp))}`);
        }
      }
    }
    expect(drift.join("\n")).toBe("");
  });
});
