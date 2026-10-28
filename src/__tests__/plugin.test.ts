/**
 * #177: the Claude Code plugin (plugin/) and its marketplace entry
 * (.claude-plugin/marketplace.json). The skills are prose for an agent, so the
 * drift guard is that every tool or recipe they name in code still exists,
 * and the bundled MCP server is this package.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

interface ManifestTool {
  name: string;
  inputSchema?: { properties?: Record<string, { enum?: string[] }> };
}
const tools = JSON.parse(read("mcp-tools.json")) as ManifestTool[];
const toolNames = new Set(tools.map((t) => t.name));
const recipes = tools.find((t) => t.name === "pipeline")?.inputSchema?.properties?.recipe?.enum ?? [];
const pkg = JSON.parse(read("package.json")) as { name: string };

const marketplace = JSON.parse(read(".claude-plugin", "marketplace.json")) as {
  name: string;
  owner: { name: string };
  plugins: Array<{ name: string; source: string; description: string }>;
};
const entry = marketplace.plugins[0];
const pluginDir = join(root, entry?.source ?? "missing");
const plugin = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as {
  name: string;
  version?: string;
  mcpServers: Record<string, { command: string; args: string[] }>;
};
const skillsDir = join(pluginDir, "skills");
const skills = readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md")));

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return {};
  return Object.fromEntries(
    (m[1] ?? "").split("\n").flatMap((line) => {
      const i = line.indexOf(":");
      return i > 0 ? [[line.slice(0, i).trim(), line.slice(i + 1).trim()]] : [];
    }),
  );
}

describe("Claude Code plugin (#177)", () => {
  it("lists one plugin whose source has a manifest with the same name", () => {
    expect(marketplace.name).toBeTruthy();
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(entry?.source).toMatch(/^\.\//);
    expect(plugin.name).toBe(entry?.name);
  });
  it("starts this package's MCP server through npx", () => {
    const servers = Object.values(plugin.mcpServers);
    expect(servers).toHaveLength(1);
    const args = servers[0]?.args ?? [];
    expect(args).toContain("npx");
    expect(args).toContain("-y");
    expect(args).toContain(pkg.name);
  });
  it("pins no version, so installs track the repo instead of a stale number", () => {
    expect(plugin.version).toBeUndefined();
  });
  it("ships the bug-repro, readme-demo, and verify-ui skills", () => {
    expect(skills.sort()).toEqual(expect.arrayContaining(["bug-repro", "readme-demo", "verify-ui"]));
  });
  it.each(skills)("skill %s has a matching name and a trigger description", (skill) => {
    const fm = frontmatter(readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8"));
    expect(fm.name).toBe(skill);
    expect(fm.description?.length ?? 0).toBeGreaterThan(80);
    expect(fm.description?.length ?? 0).toBeLessThanOrEqual(1024);
    expect(fm.description).toMatch(/Use (when|after)/);
  });
  it.each(skills)("skill %s names only registered tools and recipes", (skill) => {
    const text = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8");
    // `tool_name` or `tool_name {`, and a code line starting with a tool call.
    const named = [
      ...[...text.matchAll(/`([a-z]+(?:_[a-z]+)+)(?: \{[^`]*)?`/g)].map((m) => m[1] ?? ""),
      ...[...text.matchAll(/^([a-z]+(?:_[a-z]+)+) \{/gm)].map((m) => m[1] ?? ""),
    ];
    const unknown = named.filter((n) => !toolNames.has(n) && !recipes.includes(n));
    expect(unknown).toEqual([]);
    expect(named.filter((n) => toolNames.has(n)).length).toBeGreaterThan(2);
  });
});
