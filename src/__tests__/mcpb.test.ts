/**
 * #127: the Claude Desktop bundle's manifest is generated from package.json
 * and mcp-tools.json, so it cannot drift from the server it ships.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const tools = JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf8")) as Array<{ name: string; description: string }>;
// A plain .mjs build helper: imported by URL, typed by hand.
const { buildManifest } = (await import(pathToFileURL(join(root, "scripts", "mcpb-manifest.mjs")).href)) as {
  buildManifest: (p: unknown, t: unknown) => Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe("MCPB manifest (#127)", () => {
  const m = buildManifest(pkg, tools);

  it("tracks package.json's version, description, license, and Node range", () => {
    expect(m.manifest_version).toBe("0.3");
    expect(m.version).toBe(pkg.version);
    expect(m.description).toBe(pkg.description);
    expect(m.license).toBe(pkg.license);
    expect(m.compatibility.runtimes.node).toBe(pkg.engines.node);
    expect(m.compatibility.platforms).toEqual(["win32"]);
  });

  it("lists exactly the registered tools", () => {
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it("launches dist/index.js and maps every env var to a declared user_config entry", () => {
    expect(m.server.entry_point).toBe("dist/index.js");
    expect(m.server.mcp_config.args).toEqual(["${__dirname}/dist/index.js"]);
    for (const value of Object.values(m.server.mcp_config.env) as string[]) {
      const key = value.match(/^\$\{user_config\.(\w+)\}$/)?.[1];
      expect(key && m.user_config[key]).toBeTruthy();
      expect(m.user_config[key!].required).toBe(false);
    }
  });

  it("has an icon that ships in the bundle (#216)", () => {
    expect(m.icon).toBe("assets/icon.png");
    expect(existsSync(join(root, m.icon))).toBe(true);
  });

  it("exposes every environment variable the README documents (#216)", () => {
    expect(Object.keys(m.server.mcp_config.env).sort()).toEqual(readmeEnvVars(readme));
  });
});

/** The variable names in the README's Configuration table, sorted. */
function readmeEnvVars(md: string): string[] {
  const section = md.split(/^## Configuration\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const names = new Set<string>();
  for (const line of section.split("\n")) {
    const firstCell = line.startsWith("|") ? line.split("|")[1] : "";
    for (const [, name] of firstCell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) names.add(name);
  }
  expect(names.size).toBeGreaterThan(0);
  return [...names].sort();
}
