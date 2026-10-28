// The tool reference, generated from the live registry (#202). One source,
// the server's own tools/list (titles, annotations, and the zod schemas as
// JSON Schema), renders:
//   - mcp-tools.json (the manifest the .mcpb bundle and the tests read)
//   - the README tools and toolsets tables (between marker comments)
//   - the tool tables on docs/index.html (between marker comments)
//   - docs/tools/<name>.html, one reference page per tool, and docs/tools/
//   - docs/llms.txt, docs/llms-full.txt, docs/sitemap.xml, docs/robots.txt
// plus the workflow and connect pages from build-docs-pages.mjs.
//
// Pure apart from collectTools (which drives a server in memory) and the
// file reads in buildAll. build-tool-docs.mjs writes or checks the result;
// src/__tests__/docs.test.ts fails when a committed file is stale.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SITE, esc, page } from "./site-shell.mjs";
import { PAGES as WORKFLOW_PAGES, WORKFLOWS } from "./build-docs-pages.mjs";

// Must match src/utils/player.ts: a client that advertises MCP Apps also sees
// the app-only tools (player_frames), so the reference covers every tool.
const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Lists every registered tool through an in-memory MCP client, exactly as a
 * client sees it, tagged with its toolset. */
export async function collectTools(createServer, toolsetOf) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ toolsets: "all" }).connect(serverSide);
  const client = new Client(
    { name: "screencast-docs", version: "0.0.0" },
    { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } } },
  );
  await client.connect(clientSide);
  await tick(); // let the server act on the initialized notification
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ ...t, toolset: toolsetOf(t.name) ?? "other" }));
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------- toolsets

const TOOLSET_INFO = {
  core: { title: "Core", blurb: "Always loaded, whatever `SCREENCAST_TOOLSETS` selects." },
  capture: {
    title: "Capture",
    blurb: "Record or screenshot the desktop, a monitor, a window, or a region. Every capture is an explicit tool call: nothing records on its own.",
  },
  watch: {
    title: "Watch",
    blurb: "Turn footage into something a model can read: frames, contact sheets, diffs, OCR, and a searchable text timeline.",
  },
  edit: {
    title: "Edit",
    blurb: "Cut, convert, compress, and redact. A tool that writes a file refuses to replace an existing `output` unless `overwrite: true`; default output paths are always unique.",
  },
  produce: {
    title: "Produce",
    blurb: "Annotate, frame, and assemble a finished piece. Tools that combine clips normalize each input to a common resolution, fps, and audio rate first.",
  },
  audio: { title: "Audio", blurb: "Extract, clean up, level, transcribe, and score the soundtrack." },
};

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const setTitle = (set) => TOOLSET_INFO[set]?.title ?? titleCase(set);

/** Toolsets in display order (core first), each with its tools in
 * registration order. */
export function groupByToolset(tools) {
  const order = [...Object.keys(TOOLSET_INFO)];
  for (const t of tools) if (!order.includes(t.toolset)) order.push(t.toolset);
  return order
    .map((set) => ({ set, title: setTitle(set), blurb: TOOLSET_INFO[set]?.blurb ?? "", tools: tools.filter((t) => t.toolset === set) }))
    .filter((g) => g.tools.length > 0);
}

// ------------------------------------------------------------ text helpers

/** Markdown inline code and bold to HTML, escaping everything else. */
export const mdInline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

/** The first sentence of a description (the one-line summary). */
export function summary(description) {
  const text = String(description ?? "").trim();
  const m = /^([\s\S]+?[.!?])(?=\s+[A-Z(`"]|$)/.exec(text);
  return (m ? m[1] : text).replace(/\s+/g, " ");
}

const mdCell = (s) => String(s).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
const isAppOnly = (t) => Array.isArray(t._meta?.ui?.visibility) && t._meta.ui.visibility.length > 0 && !t._meta.ui.visibility.includes("model");
const toolUrl = (name) => `${SITE}tools/${name}.html`;

// -------------------------------------------------------- JSON Schema view

function deref(schema, root) {
  let s = schema;
  for (let i = 0; i < 10 && s && typeof s === "object" && typeof s.$ref === "string"; i++) {
    const path = s.$ref.replace(/^#\//, "").split("/");
    s = path.reduce((o, k) => (o == null ? o : o[k]), root);
  }
  return s ?? {};
}

/** A short TypeScript-like type for a schema. */
export function typeLabel(schema, root = schema) {
  const s = deref(schema, root);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts)) return [...new Set(alts.map((a) => typeLabel(a, root)))].join(" | ");
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (t === "array") {
    const item = s.items ? typeLabel(s.items, root) : "any";
    return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
  }
  return t ?? "any";
}

/** Bounds and defaults, as short phrases. */
export function constraints(schema) {
  const out = [];
  if (schema.minimum !== undefined) out.push(`≥ ${schema.minimum}`);
  if (schema.exclusiveMinimum !== undefined) out.push(`> ${schema.exclusiveMinimum}`);
  if (schema.maximum !== undefined) out.push(`≤ ${schema.maximum}`);
  if (schema.exclusiveMaximum !== undefined) out.push(`< ${schema.exclusiveMaximum}`);
  if (schema.minLength !== undefined && schema.minLength > 1) out.push(`at least ${schema.minLength} characters`);
  if (schema.maxLength !== undefined) out.push(`at most ${schema.maxLength} characters`);
  if (schema.minItems !== undefined && schema.minItems > 0) out.push(`at least ${schema.minItems} items`);
  if (schema.maxItems !== undefined) out.push(`at most ${schema.maxItems} items`);
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`);
  return out;
}

/** One row per parameter, nested objects and object arrays flattened to
 * dotted names (`audio.source`, `regions[].x`). A union of objects told apart
 * by a constant field (pipeline steps) gets one block of rows per variant. */
export function paramRows(schema, root = schema, prefix = "", depth = 0) {
  const s = deref(schema, root);
  const required = new Set(s.required ?? []);
  const rows = [];
  for (const [key, raw] of Object.entries(s.properties ?? {})) {
    const p = deref(raw, root);
    const name = prefix + key;
    rows.push({
      name,
      type: typeLabel(p, root),
      required: required.has(key),
      description: p.description ?? "",
      constraints: constraints(p),
    });
    if (depth >= 3) continue;
    rows.push(...nestedRows(p, root, name, depth));
  }
  return rows;
}

function nestedRows(p, root, name, depth) {
  if (p.type === "object" && p.properties) return paramRows(p, root, `${name}.`, depth + 1);
  if (p.type === "array" && p.items) {
    const item = deref(p.items, root);
    if (item.type === "object" && item.properties) return paramRows(item, root, `${name}[].`, depth + 1);
    const alts = (item.anyOf ?? item.oneOf ?? []).map((a) => deref(a, root));
    const rows = [];
    for (const alt of alts) {
      if (alt.type !== "object" || !alt.properties) continue;
      const tag = Object.entries(alt.properties).find(([, v]) => deref(v, root).const !== undefined);
      // steps[trim].start: the variant's tag value in the brackets.
      const label = tag ? `${name}[${String(deref(tag[1], root).const)}].` : `${name}[].`;
      rows.push(...paramRows(alt, root, label, depth + 1).filter((r) => !tag || r.name !== label + tag[0]));
    }
    return rows;
  }
  return [];
}

// ---------------------------------------------------------------- examples

function exampleString(name, s) {
  const n = name.toLowerCase();
  const d = String(s.description ?? "").toLowerCase();
  if (n === "target") return "window:Notepad";
  if (n.includes("sessionid")) return "rec-20260101-120000-ab12";
  if (n === "a" || n === "b" || /image|screenshot|png/.test(n) || /\bpng\b|screenshot/.test(d)) return n === "b" ? "after.png" : "before.png";
  if (/srt|subtitle|transcript/.test(n)) return "captions.srt";
  if (/music/.test(n)) return "music.mp3";
  if (/model/.test(n)) return "ggml-base.en.bin";
  if (/input|video|path|file|clip|output|source/.test(n)) return "recording.mp4";
  if (/query|text|label|title|name/.test(n)) return "Save";
  return "…";
}

/** A placeholder value that satisfies the schema, for a minimal example. */
export function exampleValue(schema, name = "", root = schema) {
  const s = deref(schema, root);
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts) && alts.length > 0) return exampleValue(alts.find((a) => deref(a, root).type !== "null") ?? alts[0], name, root);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "string":
      return exampleString(name, s);
    case "integer":
    case "number":
      if (s.minimum !== undefined) return s.minimum;
      if (s.exclusiveMinimum !== undefined) return type === "integer" ? s.exclusiveMinimum + 1 : s.exclusiveMinimum + 1;
      return 1;
    case "boolean":
      return true;
    case "array": {
      const n = Math.max(s.minItems ?? 1, 1);
      const singular = name.replace(/s$/, "");
      return Array.from({ length: n }, () => exampleValue(s.items ?? {}, singular, root));
    }
    case "object":
      return requiredArgs(s, root);
    default:
      return null;
  }
}

/** Only the required arguments, with placeholder values. */
export function requiredArgs(schema, root = schema) {
  const s = deref(schema, root);
  const out = {};
  for (const key of s.required ?? []) out[key] = exampleValue(s.properties?.[key] ?? {}, key, root);
  return out;
}

/** JSON on one line when it is short, indented otherwise. */
export function formatJson(value) {
  const flat = JSON.stringify(value);
  if (flat.length <= 80) return flat.replace(/^\{(.+)\}$/, "{ $1 }").replace(/","/g, '", "').replace(/":/g, '": ').replace(/,"/g, ', "');
  return JSON.stringify(value, null, 2);
}

// ------------------------------------------------------------- changelog

/** The release each tool first appears in, from CHANGELOG.md: the oldest
 * section that names it in backticks. "Unreleased" reads "the next release". */
export function sinceVersions(changelog, names) {
  const sections = [];
  const re = /^## \[?([^\]\n]+?)\]?\s*$/gm;
  let m;
  const marks = [];
  while ((m = re.exec(changelog))) marks.push({ version: m[1], at: m.index });
  marks.forEach((mark, i) => sections.push({ version: mark.version, text: changelog.slice(mark.at, marks[i + 1]?.at ?? changelog.length) }));
  const out = {};
  for (const name of names) {
    const hit = [...sections].reverse().find((s) => s.text.includes(`\`${name}\``));
    if (hit) out[name] = /unreleased/i.test(hit.version) ? "next release" : `v${hit.version}`;
  }
  return out;
}

// -------------------------------------------------------------- renderers

/** mcp-tools.json: the registered tools as a client sees them. */
export function renderManifest(tools) {
  const entries = tools.map((t) => {
    const { $schema: _drop, ...inputSchema } = t.inputSchema ?? {};
    return {
      name: t.name,
      toolset: t.toolset,
      title: t.title,
      ...(isAppOnly(t) ? { appOnly: true } : {}),
      annotations: t.annotations,
      description: t.description,
      inputSchema,
    };
  });
  return JSON.stringify(entries, null, 2) + "\n";
}

/** The README tools tables, grouped by toolset. */
export function renderReadmeTools(tools) {
  const groups = groupByToolset(tools);
  const lines = [
    `${tools.length} tools in ${groups.length} toolsets, generated from the server's own schemas by \`npm run docs\` (do not edit between the markers). Each name links to its reference page with every parameter, an example call, and what it returns; [\`mcp-tools.json\`](mcp-tools.json) is the same list as JSON, and [\`llms-full.txt\`](${SITE}llms-full.txt) all of it in one file.`,
  ];
  for (const g of groups) {
    lines.push("", `### ${g.title}`, "");
    if (g.blurb) lines.push(g.blurb, "");
    lines.push("| Tool | What it does |", "| --- | --- |");
    for (const t of g.tools) lines.push(`| [\`${t.name}\`](${toolUrl(t.name)}) | ${mdCell(t.description ?? "")}${isAppOnly(t) ? " *(app-only: called by the review player, not the agent)*" : ""} |`);
  }
  return lines.join("\n");
}

/** The README toolsets table (Configuration section). */
export function renderReadmeToolsets(tools) {
  const groups = groupByToolset(tools);
  const selectable = groups.filter((g) => g.set !== "core");
  const core = groups.find((g) => g.set === "core");
  const row = (label, g) => `| ${label} | ${g.tools.map((t) => `\`${t.name}\``).join(", ")} |`;
  return ["| Toolset | Tools |", "| --- | --- |", ...selectable.map((g) => row(`\`${g.set}\``, g)), ...(core ? [row("`core` (always)", core)] : [])].join("\n");
}

/** The home page's chapters: where each toolset's rows go. */
const HOME_CHAPTER = { core: "capture", capture: "capture", watch: "watch", edit: "edit", audio: "edit", produce: "produce" };

export function renderHomeRows(tools, chapter) {
  return tools
    .filter((t) => (HOME_CHAPTER[t.toolset] ?? "produce") === chapter)
    .map((t) => `            <tr><td><code><a href="tools/${t.name}.html">${t.name}</a></code></td><td>${mdInline(summary(t.description))}</td></tr>`)
    .join("\n");
}

const tcAt = (i) => `00:${String(i * 5).padStart(2, "0")}`;

function chips(t, since) {
  const a = t.annotations ?? {};
  const items = [`<span class="chip set">${esc(t.toolset)}</span>`];
  items.push(a.readOnlyHint ? `<span class="chip">read-only</span>` : `<span class="chip warn">writes</span>`);
  if (a.destructiveHint && !a.readOnlyHint) items.push(`<span class="chip warn">destructive</span>`);
  if (a.idempotentHint) items.push(`<span class="chip">idempotent</span>`);
  if (a.openWorldHint) items.push(`<span class="chip">open world</span>`);
  if (isAppOnly(t)) items.push(`<span class="chip">app-only</span>`);
  if (since) items.push(`<span class="chip">since ${esc(since)}</span>`);
  return `      <p class="chips">${items.join("")}</p>`;
}

function paramTable(rows, emptyText, { output = false } = {}) {
  if (rows.length === 0) return `      <p>${emptyText}</p>`;
  const described = rows.some((r) => r.description || r.constraints.length);
  const tr = (r) => {
    const depth = (r.name.match(/\.|\]\./g) ?? []).length;
    const req = r.required ? ` <span class="req">${output ? "always" : "required"}</span>` : "";
    const notes = r.constraints.length ? ` <span class="bounds">${esc(r.constraints.join(", "))}</span>` : "";
    const desc = described ? `<td>${mdInline(r.description)}${notes}</td>` : "";
    return `          <tr${depth ? ` class="nested d${Math.min(depth, 3)}"` : ""}><td><code>${esc(r.name)}</code>${req}</td><td><code class="type">${esc(r.type)}</code></td>${desc}</tr>`;
  };
  return `      <div class="table-scroll">
      <table class="params">
        <thead><tr><th>${output ? "Field" : "Name"}</th><th>Type</th>${described ? "<th>Description</th>" : ""}</tr></thead>
        <tbody>
${rows.map(tr).join("\n")}
        </tbody>
      </table>
      </div>`;
}

/** Which workflow recipes call each tool, from the generated recipe pages. */
export function workflowUses(tools) {
  const uses = {};
  for (const t of tools) uses[t.name] = [];
  for (const w of WORKFLOWS) {
    const html = WORKFLOW_PAGES.get(`workflows/${w.slug}.html`) ?? "";
    for (const t of tools) if (html.includes(`<b>${t.name}</b>`) || w.chain.split(/[\s→(),]+/).includes(t.name)) uses[t.name].push(w);
  }
  return uses;
}

export function renderToolPage(t, { prev, next, since, workflows }) {
  const inputRows = paramRows(t.inputSchema ?? {});
  const outputRows = t.outputSchema ? paramRows(t.outputSchema).filter((r) => !r.name.includes(".") || r.name.split(".").length <= 2) : [];
  const example = `${t.name} ${formatJson(requiredArgs(t.inputSchema ?? {}))}`;
  let i = 0;
  const mark = (label) => `      <div class="tc-mark"><span class="tc">${tcAt(i++)}</span><span>${label}</span></div>`;
  const sections = [
    `    <section class="chapter">
${mark("PARAMETERS")}
${paramTable(inputRows, "No parameters.")}
    </section>`,
    `    <section class="chapter">
${mark("A MINIMAL CALL")}
      <pre class="copyable"><code>${esc(example)}</code></pre>
      <p>The required arguments only, with placeholder values. Everything else takes its default.</p>
    </section>`,
    `    <section class="chapter">
${mark("WHAT COMES BACK")}
${outputRows.length ? `      <p>Structured content (<code>structuredContent</code>), alongside a text summary${/inline|image/i.test(t.description ?? "") ? " and any inline images" : ""}:</p>\n${paramTable(outputRows, "", { output: true })}` :"      <p>A text result; this tool declares no structured output.</p>"}
    </section>`,
  ];
  if (workflows.length) {
    sections.push(`    <section class="chapter">
${mark("SEEN IN")}
      <ul class="recipes">
${workflows.map((w) => `        <li><a href="../workflows/${w.slug}.html"><span class="tc">REC ${w.n}</span><span class="name">${esc(w.name)}</span><span class="chain">${esc(w.chain).replace(/ → /g, " &rarr; ")}</span></a></li>`).join("\n")}
      </ul>
    </section>`);
  }
  const body = `      <h1>${esc(t.title ?? t.name)}</h1>
      <p class="tool-id"><code>${t.name}</code></p>
      <p class="lede">${mdInline(t.description ?? "")}</p>
${chips(t, since)}
    </section>

${sections.join("\n\n")}
      <nav class="pager" aria-label="More tools">
        <span>${prev ? `<a href="${prev.name}.html">&larr; ${prev.name}</a>` : `<a href="./">&larr; All tools</a>`}</span>
        <span>${next ? `<a href="${next.name}.html">${next.name} &rarr;</a>` : `<a href="./">All tools &rarr;</a>`}</span>
      </nav>
`;
  return page({
    path: `tools/${t.name}.html`,
    title: `${t.name}`,
    description: esc(summary(t.description)),
    root: "../",
    crumbs: `<a href="../">SCREENCAST-MCP</a> / <a href="./">TOOLS</a> / ${esc(t.toolset.toUpperCase())}`,
    body,
  });
}

export function renderToolsIndex(tools) {
  const groups = groupByToolset(tools);
  const body = `      <h1>Tools</h1>
      <p class="lede">${tools.length} tools in ${groups.length} toolsets, each with its parameters, a minimal call, and what it returns. Generated from the server's own schemas, so this reference cannot drift from the code. Agents can read all of it in one file: <a href="../llms-full.txt">llms-full.txt</a>.</p>
    </section>

${groups
  .map(
    (g, i) => `    <section class="chapter" id="${g.set}">
      <div class="tc-mark"><span class="tc">${tcAt(i)}</span><span>${esc(g.title.toUpperCase())}${g.set === "core" ? " / ALWAYS ON" : ""}</span></div>
${g.blurb ? `      <p>${mdInline(g.blurb)}</p>\n` : ""}      <table>
        <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
        <tbody>
${g.tools.map((t) => `          <tr><td><code><a href="${t.name}.html">${t.name}</a></code></td><td>${mdInline(summary(t.description))}</td></tr>`).join("\n")}
        </tbody>
      </table>
    </section>`,
  )
  .join("\n\n")}
`;
  return page({
    path: "tools/index.html",
    title: "Tools",
    description: `Reference for all ${tools.length} screencast-mcp tools: parameters, example calls, and results, generated from the server's schemas.`,
    root: "../",
    crumbs: `<a href="../">SCREENCAST-MCP</a> / TOOLS`,
    body,
    type: "website",
  });
}

const PITCH = "An MCP server (stdio) that lets AI agents record the Windows screen, watch the footage as frames, and edit it with ffmpeg. Install: `npx -y @tmhs/screencast-mcp`. Capture is Windows-only; the watch and edit tools run anywhere ffmpeg runs.";

export function renderLlms(tools) {
  const lines = [
    "# Screencast MCP",
    "",
    `> ${PITCH}`,
    "",
    "Every tool is an explicit call: nothing records on its own. Tools return file paths plus structured results; screenshot, sample_frames, and contact_sheet also return images inline.",
    "",
    "## Docs",
    "",
    `- [Connect your client](${SITE}connect.html): set up Claude Code, Claude Desktop, Cursor, or VS Code`,
    `- [Workflows](${SITE}workflows/): copy-paste recipes from a prompt to the tool calls and the real output`,
    ...WORKFLOWS.map((w) => `- [${w.name}](${SITE}workflows/${w.slug}.html): ${w.description}`),
    `- [Tool reference](${SITE}tools/): every tool's parameters, a minimal call, and its result`,
    `- [Record test runs in CI](${SITE}ci.html): the \`screencast-mcp record -- <command>\` CLI and the GitHub Action for windows-latest`,
    "",
    "## Tools",
    "",
    ...tools.map((t) => `- [${t.name}](${toolUrl(t.name)}): ${summary(t.description)}`),
    "",
    "## Optional",
    "",
    `- [Full tool reference](${SITE}llms-full.txt): every tool and parameter in one file`,
    `- [mcp-tools.json](https://github.com/TMHSDigital/screencast-mcp/blob/main/mcp-tools.json): the tool list with JSON Schemas`,
    `- [README](https://github.com/TMHSDigital/screencast-mcp#readme): configuration, safety, and the threat model`,
    "",
  ];
  return lines.join("\n");
}

export function renderLlmsFull(tools, since) {
  const out = ["# Screencast MCP: full tool reference", "", `> ${PITCH}`, "", `${tools.length} tools. Generated from the server's schemas; the same content is on ${SITE}tools/.`, ""];
  for (const g of groupByToolset(tools)) {
    out.push(`# ${g.title} toolset`, "");
    if (g.blurb) out.push(g.blurb, "");
    for (const t of g.tools) {
      out.push(`## ${t.name}`, "");
      if (t.title) out.push(`**${t.title}**${since[t.name] ? ` (since ${since[t.name]})` : ""}${isAppOnly(t) ? " (app-only)" : ""}`, "");
      out.push(t.description ?? "", "");
      const rows = paramRows(t.inputSchema ?? {});
      if (rows.length) {
        out.push("Parameters:", "");
        for (const r of rows) {
          const extra = [r.required ? "required" : "", ...r.constraints].filter(Boolean).join(", ");
          out.push(`- \`${r.name}\` (${r.type}${extra ? `; ${extra}` : ""})${r.description ? `: ${r.description.replace(/\s*\n\s*/g, " ")}` : ""}`);
        }
        out.push("");
      }
      out.push("Minimal call:", "", "```json", JSON.stringify(requiredArgs(t.inputSchema ?? {})), "```", "");
    }
  }
  return out.join("\n");
}

export function renderSitemap(paths) {
  const locs = paths.map((p) => `  <url><loc>${SITE}${p.replace(/(^|\/)index\.html$/, "$1")}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.join("\n")}
</urlset>
`;
}

export const ROBOTS = `User-agent: *
Allow: /

Sitemap: ${SITE}sitemap.xml
`;

/** Replaces the text between `<!-- name:start -->` and `<!-- name:end -->`. */
export function replaceRegion(text, name, content, file = "file") {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error(`${file} is missing the ${start} ... ${end} markers.`);
  return text.slice(0, a + start.length) + "\n" + content + "\n" + text.slice(b);
}

/** Replaces `<!--tool-count-->N<!--/tool-count-->` everywhere. */
export const replaceCount = (text, n) => text.replace(/<!--tool-count-->\d*<!--\/tool-count-->/g, `<!--tool-count-->${n}<!--/tool-count-->`);

const lf = (s) => s.replace(/\r\n/g, "\n");

/** Every generated file: repo-relative path -> content. */
export function buildAll({ tools, root }) {
  const read = (p) => lf(readFileSync(join(root, p), "utf8"));
  const files = new Map();
  const since = sinceVersions(read("CHANGELOG.md"), tools.map((t) => t.name));
  const uses = workflowUses(tools);

  files.set("mcp-tools.json", renderManifest(tools));

  let readme = read("README.md");
  readme = replaceRegion(readme, "tools", renderReadmeTools(tools), "README.md");
  readme = replaceRegion(readme, "toolsets", renderReadmeToolsets(tools), "README.md");
  files.set("README.md", replaceCount(readme, tools.length));

  let home = read("docs/index.html");
  for (const chapter of ["capture", "watch", "edit", "produce"]) home = replaceRegion(home, `tools:${chapter}`, renderHomeRows(tools, chapter), "docs/index.html");
  files.set("docs/index.html", replaceCount(home, tools.length));

  for (const [path, html] of WORKFLOW_PAGES) files.set(`docs/${path}`, html);

  files.set("docs/tools/index.html", renderToolsIndex(tools));
  tools.forEach((t, i) => {
    files.set(`docs/tools/${t.name}.html`, renderToolPage(t, { prev: tools[i - 1], next: tools[i + 1], since: since[t.name], workflows: uses[t.name] }));
  });

  files.set("docs/llms.txt", renderLlms(tools));
  files.set("docs/llms-full.txt", renderLlmsFull(tools, since));
  files.set("docs/robots.txt", ROBOTS);
  const pages = ["index.html", "connect.html", ...[...WORKFLOW_PAGES.keys()].filter((p) => p !== "connect.html").sort(), "tools/index.html", ...tools.map((t) => `tools/${t.name}.html`)];
  files.set("docs/sitemap.xml", renderSitemap(pages));
  return files;
}

/** Generated files whose committed copy differs, plus tool pages for tools
 * that no longer exist. */
export function staleFiles(files, root) {
  const stale = [];
  for (const [path, content] of files) {
    const full = join(root, path);
    if (!existsSync(full) || lf(readFileSync(full, "utf8")) !== content) stale.push(path);
  }
  const dir = join(root, "docs", "tools");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (!files.has(`docs/tools/${f}`)) stale.push(`docs/tools/${f} (no such tool)`);
  }
  return stale;
}
