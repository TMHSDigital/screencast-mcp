/**
 * Drift guard: the tools table on the GitHub Pages site (docs/index.html) is
 * hand-mirrored from mcp-tools.json (the registered-tool manifest). Nothing
 * else keeps them in sync, so this test fails a PR that adds/removes a tool
 * without updating the site, or documents a tool that does not exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const registered = (
  JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf8")) as Array<{
    name: string;
  }>
).map((t) => t.name);

const html = readFileSync(join(root, "docs", "index.html"), "utf8");
const documented = [...html.matchAll(/<td><code>([a-z_]+)<\/code><\/td>/g)].map(
  (m) => m[1],
);

describe("docs/index.html tools table stays in sync with mcp-tools.json", () => {
  it("documents every registered tool", () => {
    const missing = registered.filter((t) => !documented.includes(t));
    expect(missing, `tools missing from docs/index.html: ${missing.join(", ")}`).toEqual([]);
  });
  it("documents no tool that is not registered", () => {
    const phantom = documented.filter((t) => !registered.includes(t));
    expect(phantom, `tools in docs/index.html but not registered: ${phantom.join(", ")}`).toEqual([]);
  });
  it("actually parsed the table (sanity check against a silent regex miss)", () => {
    expect(documented.length).toBeGreaterThan(0);
  });
});
