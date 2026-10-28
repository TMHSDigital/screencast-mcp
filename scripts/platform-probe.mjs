#!/usr/bin/env node
// Platform probe (#246): report what works on this machine through the built
// server (dist/index.js) over MCP, the way a client sees it.
//
//   node scripts/platform-probe.mjs            # doctor + an OCR round trip on a generated file
//   node scripts/platform-probe.mjs --capture  # also screenshot the desktop with gdigrab and WGC
//
// Report-only by default (exit 0); --strict exits 1 when ffmpeg, gdigrab or
// the OCR round trip fail. --capture grabs the real screen, so CI uses it on
// hosted runners; do not pass it on a machine showing anything private.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const strict = process.argv.includes("--strict");
const capture = process.argv.includes("--capture");
const home = mkdtempSync(join(tmpdir(), "sc-probe-"));
const env = { ...process.env, SCREENCAST_HOME: home };
delete env.SCREENCAST_CONFIRM_CAPTURE;

const client = new Client({ name: "platform-probe", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env, stderr: "inherit" }),
);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let data = res.structuredContent;
  if (!data) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  return { ok: res.isError !== true, text, data: data ?? {} };
}

const results = [];
const record = (check, pass, detail, required = false) => results.push({ check, pass, detail, required });

try {
  const doc = await call("doctor");
  const d = doc.data;
  record("server", doc.ok, `${d.server?.platform}-${d.server?.arch} node ${d.server?.node}`);
  record("ffmpeg", !!d.ffmpeg?.version, String(d.ffmpeg?.version ?? "missing"), true);
  for (const [filter, ok] of Object.entries(d.filters ?? {})) record(`filter ${filter}`, ok === true, ok ? "present" : "absent");
  for (const [device, ok] of Object.entries(d.devices ?? {})) record(`device ${device}`, ok === true, ok ? "present" : "absent", device === "gdigrab");
  record("ocr languages", d.ocr?.available === true, (d.ocr?.languages ?? []).join(", ") || String(d.ocr?.error ?? "none"));
  for (const p of d.problems ?? []) record("doctor problem", false, p);

  // OCR round trip on a rendered file: proves the PowerShell/WinRT bridge
  // (Windows.Media.Ocr) without touching the screen.
  const card = await call("title_card", { text: "PROBE 4096", duration: 1, width: 640, height: 240, fontSize: 64 });
  if (card.ok && card.data.outputPath) {
    const found = await call("find_text", { input: card.data.outputPath, timestamp: 0.5, query: "4096", returnImage: false });
    record("ocr round trip", found.ok && Number(found.data.matchCount) > 0, found.ok ? `matchCount ${found.data.matchCount}` : found.text, true);
  } else {
    record("ocr round trip", false, `title_card failed: ${card.text}`, true);
  }

  if (capture) {
    for (const backend of ["gdigrab", "wgc"]) {
      const shot = await call("screenshot", { target: "full", backend, returnImage: false });
      record(`screenshot ${backend}`, shot.ok, shot.ok ? String(shot.data.outputPath) : shot.text.split("\n")[0]);
    }
  }
} finally {
  await client.close();
  rmSync(home, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.pass ? "ok  " : "FAIL"}  ${r.check.padEnd(22)} ${r.detail}`);
const failed = results.filter((r) => r.required && !r.pass);
if (strict && failed.length > 0) {
  console.error(`Required checks failed: ${failed.map((r) => r.check).join(", ")}`);
  process.exitCode = 1;
}
