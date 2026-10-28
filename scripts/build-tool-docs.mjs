// Regenerate everything derived from the tool registry (#202): mcp-tools.json,
// the README and home-page tool tables, docs/tools/, llms.txt, llms-full.txt,
// sitemap.xml, robots.txt, and the workflow/connect pages.
//
//   npm run docs          build, then write the files
//   npm run docs:check    build, then fail if any committed file is stale
//
// It reads the tools from the compiled server (dist/), so run it after a build.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAll, collectTools, staleFiles } from "./tool-docs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const dist = join(root, "dist", "server.js");
if (!existsSync(dist)) {
  console.error("dist/server.js is missing: run `npm run build` first (or `npm run docs`).");
  process.exit(1);
}
const { createServer } = await import(pathToFileURL(dist).href);
const { toolsetOf } = await import(pathToFileURL(join(root, "dist", "utils", "toolsets.js")).href);

const tools = await collectTools(createServer, toolsetOf);
const files = buildAll({ tools, root });
const stale = staleFiles(files, root);

if (check) {
  if (stale.length > 0) {
    console.error(`Generated docs are stale (${stale.length}):\n  ${stale.join("\n  ")}\nRun \`npm run docs\` and commit the result.`);
    process.exit(1);
  }
  console.log(`Generated docs are up to date (${files.size} files, ${tools.length} tools).`);
  process.exit(0);
}

for (const [path, content] of files) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
for (const entry of stale) {
  const m = /^(docs\/tools\/[^ ]+) \(no such tool\)$/.exec(entry);
  if (m) rmSync(join(root, m[1]));
}
console.log(`Wrote ${files.size} files for ${tools.length} tools${stale.length ? ` (${stale.length} changed)` : ""}.`);
process.exit(0);
