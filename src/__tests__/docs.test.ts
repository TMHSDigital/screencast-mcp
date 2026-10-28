/**
 * Docs drift guard (#202). mcp-tools.json, the README tool and toolset tables,
 * the home page tool tables, docs/tools/, llms.txt, the sitemap, and the
 * workflow pages are all generated from the live tool registry by
 * scripts/build-tool-docs.mjs (`npm run docs`). This test regenerates them
 * in memory from src/ and fails when a committed copy differs, so a tool
 * added, renamed, or re-described without `npm run docs` cannot ship stale
 * docs. The checks below that keep hand-written pages honest stay as they were.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { defined } from "./testUtils.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createServer } from "../server.js";
import { toolsetOf } from "../utils/toolsets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A plain .mjs build helper: imported by URL, typed by hand.
interface Tool {
  name: string;
}
const toolDocs = (await import(pathToFileURL(join(root, "scripts", "tool-docs.mjs")).href)) as {
  collectTools: (create: typeof createServer, setOf: typeof toolsetOf) => Promise<Tool[]>;
  buildAll: (o: { tools: Tool[]; root: string }) => Map<string, string>;
  staleFiles: (files: Map<string, string>, root: string) => string[];
};

let tools: Tool[] = [];
let files = new Map<string, string>();
beforeAll(async () => {
  tools = await toolDocs.collectTools(createServer, toolsetOf);
  files = toolDocs.buildAll({ tools, root });
});

const registered = (
  JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf8")) as Array<{
    name: string;
  }>
).map((t) => t.name);

describe("generated docs are fresh (#202)", () => {
  it("every generated file matches a regeneration from the registry (run `npm run docs`)", () => {
    const stale = toolDocs.staleFiles(files, root);
    expect(stale, `stale generated files; run \`npm run docs\`:\n${stale.join("\n")}`).toEqual([]);
  });
  it("covers every registered tool with a page, a README row, and a home-page row", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...registered].sort());
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const home = readFileSync(join(root, "docs", "index.html"), "utf8");
    const homeRows = [...home.matchAll(/<td><code><a href="tools\/([a-z_]+)\.html">/g)].map((m) => defined(m[1]));
    const readmeRows = [...readme.matchAll(/^\| \[`([a-z_]+)`\]\(/gm)].map((m) => defined(m[1]));
    for (const name of registered) {
      expect(existsSync(join(root, "docs", "tools", `${name}.html`)), `docs/tools/${name}.html`).toBe(true);
    }
    expect([...homeRows].sort()).toEqual([...registered].sort());
    expect([...readmeRows].sort()).toEqual([...registered].sort());
  });
});

// The workflow recipes (#129) reference tools by name in their call lists and
// link to each other and to media files; keep both honest.
const pages = [
  // 404.html links by absolute path and is not a page to index.
  ...readdirSync(join(root, "docs")).filter((f) => f !== "404.html"),
  ...readdirSync(join(root, "docs", "workflows")).map((f) => `workflows/${f}`),
  ...(existsSync(join(root, "docs", "tools")) ? readdirSync(join(root, "docs", "tools")).map((f) => `tools/${f}`) : []),
].filter((p) => p.endsWith(".html"));

describe("docs pages", () => {
  it("every relative link, image, stylesheet, and script resolves to a file", () => {
    const broken: string[] = [];
    for (const page of pages) {
      const src = readFileSync(join(root, "docs", page), "utf8");
      for (const [, ref] of src.matchAll(/(?:href|src)="([^"#]*)"/g)) {
        if (!ref || /^(https?:|data:|mailto:)/.test(ref)) continue;
        const target = join(root, "docs", dirname(page), ref);
        if (!existsSync(ref.endsWith("/") ? join(target, "index.html") : target)) broken.push(`${page} -> ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });
  it("every srcset image exists (reduced-motion stills, #224)", () => {
    const broken: string[] = [];
    for (const page of pages) {
      const src = readFileSync(join(root, "docs", page), "utf8");
      for (const [, ref = ""] of src.matchAll(/srcset="([^"]*)"/g)) {
        if (!existsSync(join(root, "docs", dirname(page), ref))) broken.push(`${page} -> ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });
  it("animated outputs have a still for reduced motion (#224)", () => {
    const missing: string[] = [];
    for (const page of pages) {
      const src = readFileSync(join(root, "docs", page), "utf8");
      for (const [tag, ref = ""] of src.matchAll(/<img src="([^"]+\.gif)"[^>]*>/g)) {
        if (!src.includes(`<source srcset="${ref.replace(/\.gif$/, "-still.webp")}" media="(prefers-reduced-motion: reduce)">${tag}`)) missing.push(`${page}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it("recipe call lists name only registered tools", () => {
    const unknown: string[] = [];
    for (const page of pages.filter((p) => p.startsWith("workflows/"))) {
      const src = readFileSync(join(root, "docs", page), "utf8");
      for (const [, tool = ""] of src.matchAll(/<b>([a-z_]+)<\/b>/g)) {
        if (!registered.includes(tool)) unknown.push(`${page}: ${tool}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("docs/sitemap.xml", () => {
  it("lists every page", () => {
    const sitemap = readFileSync(join(root, "docs", "sitemap.xml"), "utf8");
    const listed = [...sitemap.matchAll(/<loc>https:\/\/tmhsdigital\.github\.io\/screencast-mcp\/([^<]*)<\/loc>/g)].map((m) => m[1]);
    const expected = pages.map((p) => p.replace(/(^|\/)index\.html$/, "$1"));
    expect(listed.sort()).toEqual(expected.sort());
  });
});

describe("README", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  it("states the real tool count", () => {
    const counts = [...readme.matchAll(/\b(\d+)(?:<!--\/tool-count-->)? (?:typed )?tools\b/g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n === registered.length), `README says ${counts.join(", ")}; manifest has ${registered.length}`).toBe(true);
  });
});

// Checked-in agent instructions must describe this repo, not a phantom
// architecture or one maintainer's local tooling (#193).
describe("agent docs", () => {
  const files = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONTRIBUTING.md"];
  it.each(files)("%s references no nonexistent src/ path and no maintainer-only tools", (file) => {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).not.toMatch(/src\/providers|ProviderManager|ctx_execute|context-mode/);
    for (const [, path = ""] of text.matchAll(/`(src\/[\w./-]+?)\/?`/g)) {
      if (path.includes("<")) continue;
      expect(existsSync(join(root, path)), `${file} mentions ${path}`).toBe(true);
    }
  });
});
