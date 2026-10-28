/**
 * Drift guard: the tools table on the GitHub Pages site (docs/index.html) is
 * hand-mirrored from mcp-tools.json (the registered-tool manifest). Nothing
 * else keeps them in sync, so this test fails a PR that adds/removes a tool
 * without updating the site, or documents a tool that does not exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

// The workflow recipes (#129) reference tools by name in their call lists and
// link to each other and to media files; keep both honest.
const pages = ["index.html", "connect.html", ...readdirSync(join(root, "docs", "workflows")).map((f) => `workflows/${f}`)]
  .filter((p) => p.endsWith(".html"));

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
      for (const [, ref] of src.matchAll(/srcset="([^"]*)"/g)) {
        if (!existsSync(join(root, "docs", dirname(page), ref))) broken.push(`${page} -> ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });
  it("animated outputs have a still for reduced motion (#224)", () => {
    const missing: string[] = [];
    for (const page of pages) {
      const src = readFileSync(join(root, "docs", page), "utf8");
      for (const [tag, ref] of src.matchAll(/<img src="([^"]+\.gif)"[^>]*>/g)) {
        if (!src.includes(`<source srcset="${ref.replace(/\.gif$/, "-still.webp")}" media="(prefers-reduced-motion: reduce)">${tag}`)) missing.push(`${page}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it("recipe call lists name only registered tools", () => {
    const unknown: string[] = [];
    for (const page of pages.filter((p) => p.startsWith("workflows/"))) {
      const src = readFileSync(join(root, "docs", page), "utf8");
      for (const [, tool] of src.matchAll(/<b>([a-z_]+)<\/b>/g)) {
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
    const counts = [...readme.matchAll(/\b(\d+) (?:typed )?tools\b/g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n === registered.length), `README says ${counts.join(", ")}; manifest has ${registered.length}`).toBe(true);
  });
  it("documents every registered tool in a table", () => {
    const rows = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(registered.filter((t) => !rows.includes(t))).toEqual([]);
  });
});

// Checked-in agent instructions must describe this repo, not a phantom
// architecture or one maintainer's local tooling (#193).
describe("agent docs", () => {
  const files = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONTRIBUTING.md"];
  it.each(files)("%s references no nonexistent src/ path and no maintainer-only tools", (file) => {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).not.toMatch(/src\/providers|ProviderManager|ctx_execute|context-mode/);
    for (const [, path] of text.matchAll(/`(src\/[\w./-]+?)\/?`/g)) {
      if (path.includes("<")) continue;
      expect(existsSync(join(root, path)), `${file} mentions ${path}`).toBe(true);
    }
  });
});
