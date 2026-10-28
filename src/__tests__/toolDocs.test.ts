/**
 * #202: the pure pieces of the tool-reference generator (scripts/tool-docs.mjs).
 * docs.test.ts checks the committed output is fresh; this checks the renderers.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Row {
  name: string;
  type: string;
  required: boolean;
  description: string;
  constraints: string[];
}
interface Tool {
  name: string;
  toolset: string;
  description?: string;
  title?: string;
  annotations?: Record<string, boolean>;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
// A plain .mjs build helper: imported by URL, typed by hand.
const g = (await import(pathToFileURL(join(root, "scripts", "tool-docs.mjs")).href)) as {
  typeLabel: (s: unknown) => string;
  constraints: (s: unknown) => string[];
  paramRows: (s: unknown) => Row[];
  requiredArgs: (s: unknown) => Record<string, unknown>;
  formatJson: (v: unknown) => string;
  summary: (d: string) => string;
  sinceVersions: (changelog: string, names: string[]) => Record<string, string>;
  replaceRegion: (text: string, name: string, content: string) => string;
  replaceCount: (text: string, n: number) => string;
  renderReadmeToolsets: (tools: Tool[]) => string;
  renderReadmeTools: (tools: Tool[]) => string;
  renderManifest: (tools: Tool[]) => string;
  renderSitemap: (paths: string[]) => string;
};

const schema = {
  type: "object",
  properties: {
    input: { type: "string", minLength: 1, description: "Path to the video." },
    fps: { type: "integer", minimum: 1, maximum: 120, description: "Frames per second." },
    mode: { type: "string", enum: ["even", "scenes"] },
    audio: {
      type: "object",
      properties: { source: { type: "string", enum: ["system", "none"] } },
      required: ["source"],
    },
    regions: {
      type: "array",
      minItems: 1,
      items: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
    },
    steps: {
      type: "array",
      items: {
        anyOf: [
          { type: "object", properties: { op: { const: "trim" }, start: { type: "number", exclusiveMinimum: 0 } }, required: ["op"] },
          { type: "object", properties: { op: { const: "crop" }, width: { type: "integer" } }, required: ["op"] },
        ],
      },
    },
    dryRun: { type: "boolean", default: false },
  },
  required: ["input", "regions"],
  $schema: "http://json-schema.org/draft-07/schema#",
};

describe("schema rendering", () => {
  it("labels types like TypeScript", () => {
    expect(g.typeLabel({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(g.typeLabel({ type: "array", items: { type: "number" } })).toBe("number[]");
    expect(g.typeLabel({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } })).toBe("(string | number)[]");
    expect(g.typeLabel({ const: "trim" })).toBe('"trim"');
    expect(g.typeLabel({})).toBe("any");
  });
  it("states bounds and defaults", () => {
    expect(g.constraints({ minimum: 1, maximum: 120 })).toEqual(["≥ 1", "≤ 120"]);
    expect(g.constraints({ exclusiveMinimum: 0, default: 3, minItems: 2 })).toEqual(["> 0", "at least 2 items", "default 3"]);
  });
  it("flattens nested objects, object arrays, and tagged unions", () => {
    const rows = g.paramRows(schema);
    expect(rows.map((r) => r.name)).toEqual([
      "input", "fps", "mode", "audio", "audio.source", "regions", "regions[].x",
      "steps", "steps[trim].start", "steps[crop].width", "dryRun",
    ]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.input).toMatchObject({ required: true, type: "string", description: "Path to the video." });
    expect(byName["audio.source"]).toMatchObject({ required: true, type: '"system" | "none"' });
    expect(byName.fps?.constraints).toEqual(["≥ 1", "≤ 120"]);
    expect(byName.dryRun?.required).toBe(false);
  });
  it("builds a minimal call from the required arguments", () => {
    const args = g.requiredArgs(schema);
    expect(args).toEqual({ input: "recording.mp4", regions: [{ x: 1 }] });
    expect(g.requiredArgs({ type: "object", properties: { target: { type: "string" } }, required: ["target"] })).toEqual({ target: "window:Notepad" });
    expect(g.formatJson({ input: "a.mp4", start: 0 })).toBe('{ "input": "a.mp4", "start": 0 }');
    expect(g.formatJson({})).toBe("{}");
  });
});

describe("text helpers", () => {
  it("takes the first sentence as the summary", () => {
    expect(g.summary("Cut a clip. For several segments use clip.")).toBe("Cut a clip.");
    expect(g.summary("Read events, e.g. clicks. Then sample.")).toBe("Read events, e.g. clicks.");
    expect(g.summary("No period at all")).toBe("No period at all");
  });
  it("dates each tool from the oldest CHANGELOG section that names it", () => {
    const changelog = "# Changelog\n\n## Unreleased\n\n- `newtool` added.\n\n## [0.2.0]\n\n- `trim` gains exact.\n\n## [0.1.0]\n\n- `trim` and `crop`.\n";
    expect(g.sinceVersions(changelog, ["trim", "crop", "newtool", "ghost"])).toEqual({ trim: "v0.1.0", crop: "v0.1.0", newtool: "next release" });
  });
  it("replaces only the marked region, and fails loudly without markers", () => {
    const text = "a\n<!-- tools:start -->\nold\n<!-- tools:end -->\nb";
    expect(g.replaceRegion(text, "tools", "new")).toBe("a\n<!-- tools:start -->\nnew\n<!-- tools:end -->\nb");
    expect(() => g.replaceRegion("no markers", "tools", "x")).toThrow(/missing/);
    expect(g.replaceCount("behind <!--tool-count-->3<!--/tool-count--> tools", 55)).toBe("behind <!--tool-count-->55<!--/tool-count--> tools");
  });
});

describe("renderers", () => {
  const tools: Tool[] = [
    { name: "doctor", toolset: "core", title: "Doctor", description: "Check the setup.", inputSchema: { type: "object", properties: {} } },
    { name: "trim", toolset: "edit", title: "Trim", description: "Cut | a clip.", annotations: { readOnlyHint: false }, inputSchema: schema },
    { name: "player_frames", toolset: "watch", title: "Frames", description: "For the player.", _meta: { ui: { visibility: ["app"] } } },
  ];
  it("groups the README tables by toolset with linked names and escaped pipes", () => {
    const md = g.renderReadmeTools(tools);
    expect(md).toMatch(/^3 tools in 3 toolsets/);
    expect(md.indexOf("### Core")).toBeLessThan(md.indexOf("### Watch"));
    expect(md).toContain("| [`trim`](https://tmhsdigital.github.io/screencast-mcp/tools/trim.html) | Cut \\| a clip. |");
    expect(md).toContain("app-only");
    expect(g.renderReadmeToolsets(tools).split("\n").slice(2)).toEqual(["| `watch` | `player_frames` |", "| `edit` | `trim` |", "| `core` (always) | `doctor` |"]);
  });
  it("writes the manifest without the JSON Schema dialect line and flags app-only tools", () => {
    const manifest = JSON.parse(g.renderManifest(tools)) as Array<Record<string, unknown>>;
    expect(manifest.map((t) => t.name)).toEqual(["doctor", "trim", "player_frames"]);
    expect((manifest[1]?.inputSchema as Record<string, unknown>).$schema).toBeUndefined();
    expect(manifest[2]?.appOnly).toBe(true);
    expect(manifest[0]?.appOnly).toBeUndefined();
  });
  it("lists pages in the sitemap with index.html folded to the folder", () => {
    expect(g.renderSitemap(["index.html", "tools/index.html", "tools/trim.html"])).toContain(
      "<loc>https://tmhsdigital.github.io/screencast-mcp/</loc></url>\n  <url><loc>https://tmhsdigital.github.io/screencast-mcp/tools/</loc></url>\n  <url><loc>https://tmhsdigital.github.io/screencast-mcp/tools/trim.html</loc>",
    );
  });
});
