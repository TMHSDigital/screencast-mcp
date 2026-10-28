/**
 * Drift guard for the MCP Registry listing (#90): server.json must describe the
 * same package the npm publish ships. The registry rejects a publish whose npm
 * package's mcpName does not match server.json's name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

describe("server.json matches package.json", () => {
  it("uses package.json's mcpName as the registry name", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toMatch(/^io\.github\.TMHSDigital\//);
  });
  it("points at the published npm package over stdio", () => {
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, transport: { type: "stdio" } });
  });
  it("keeps the description in sync and within the registry's 100-character limit", () => {
    expect(server.description).toBe(pkg.description);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
  it("lists every environment variable the README documents, none required (#216)", () => {
    const vars = server.packages[0].environmentVariables as Array<{ name: string; isRequired: boolean }>;
    expect(vars.map((v) => v.name).sort()).toEqual(readmeEnvVars(readme));
    for (const v of vars) expect(v.isRequired).toBe(false);
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
