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
});
