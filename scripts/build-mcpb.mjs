#!/usr/bin/env node
/**
 * Build a one-click Claude Desktop bundle (.mcpb) for the current version
 * (#127). Run after `npm run build`:
 *
 *   node scripts/build-mcpb.mjs [outDir]     (default outDir: ./mcpb-out)
 *
 * It stages the same files the npm package ships (package.json, dist/, assets/,
 * README, LICENSE) plus production node_modules, writes manifest.json from
 * package.json and mcp-tools.json (so the version and tool list never drift),
 * and packs it with the pinned @anthropic-ai/mcpb CLI.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./mcpb-manifest.mjs";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = resolve(process.argv[2] ?? join(root, "mcpb-out"));
const stage = join(outDir, "stage");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tools = JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf8"));
if (!existsSync(join(root, "dist", "index.js"))) {
  throw new Error("dist/index.js is missing: run `npm run build` first.");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of ["package.json", "package-lock.json", "dist", "assets", "README.md", "LICENSE"]) {
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}
writeFileSync(join(stage, "manifest.json"), JSON.stringify(buildManifest(pkg, tools), null, 2));
// Production dependencies only; no install scripts run.
execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
rmSync(join(stage, "package-lock.json"));

const bundle = join(outDir, `screencast-mcp-${pkg.version}.mcpb`);
execFileSync(npx, ["--yes", MCPB_CLI, "validate", join(stage, "manifest.json")], { stdio: "inherit", shell: process.platform === "win32" });
execFileSync(npx, ["--yes", MCPB_CLI, "pack", stage, bundle], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`\nBuilt ${bundle}`);
