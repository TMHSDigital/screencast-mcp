/**
 * bug_report (#198) end to end through the MCP tool layer, on a lavfi fixture
 * with real ffmpeg: the package folder, the clip window, the size-bounded
 * GIF, steps from a sidecar event log, the overwrite guard, and output
 * confinement. The secret-scan case needs Windows OCR and skips without it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks, probeMedia } from "../../utils/ffmpeg.js";
import { bundledFontPath } from "../../utils/fonts.js";
import { ocrStatus } from "../../utils/capabilities.js";
import { formatEventsJsonl, type InputEvent } from "../../utils/events.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(process.env.FFPROBE_PATH || "ffprobe");
const OCR = AVAILABLE && process.platform === "win32" && (await ocrStatus()).available;

const SECRET = "ghp_Abc123Def456Ghi789Jkl012";

describe.skipIf(!AVAILABLE)("bug_report against real ffmpeg (#198)", { timeout: 300_000 }, () => {
  let dir = "";
  let home = "";
  let video = "";
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "screencast-bug-it-"));
    home = mkdtempSync(join(tmpdir(), "screencast-bug-home-"));
    process.env.SCREENCAST_HOME = home;
    // 6 s of dark screen with a secret line throughout and an error from 3 s.
    // ffmpeg runs in `dir` so the font and text files are plain relative names.
    copyFileSync(bundledFontPath("bold"), join(dir, "font.ttf"));
    writeFileSync(join(dir, "secret.txt"), `export TOKEN=${SECRET}`);
    writeFileSync(join(dir, "error.txt"), "Error: disk full");
    video = join(dir, "rec.mp4");
    const text = (file: string, y: number, enable = "") =>
      `drawtext=fontfile=font.ttf:textfile=${file}:fontsize=28:fontcolor=white:x=40:y=${y}${enable}`;
    const res = spawnSync(
      FFMPEG,
      [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=c=0x202020:size=640x360:rate=15:duration=6",
        "-vf", `${text("secret.txt", 60)},${text("error.txt", 200, ":enable='gte(t,3)'")}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "rec.mp4",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(res.status, res.stderr).toBe(0);
    const events: InputEvent[] = [
      { t: 0.5, type: "move", x: 50, y: 50, inFrame: true },
      { t: 1, type: "down", x: 120, y: 80, inFrame: true, button: "left" },
      { t: 1.1, type: "up", x: 120, y: 80, inFrame: true, button: "left" },
      { t: 2, type: "key", x: 120, y: 80, inFrame: true, keys: "Ctrl+S" },
    ];
    writeFileSync(join(dir, "rec.events.jsonl"), formatEventsJsonl(events));

    const { createServer } = await import("../../server.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    client = new Client({ name: "bug-it", version: "0" });
    await client.connect(b);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.SCREENCAST_ALLOWED_DIRS;
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    return {
      isError: res.isError === true,
      text,
      images: (res.content as Array<{ type: string }>).filter((c) => c.type === "image").length,
      data: res.structuredContent as Record<string, unknown> | undefined,
    };
  }

  it("writes the clip, GIF, contact sheet, steps, and report into one folder", async () => {
    const out = join(home, "pkg");
    const res = await call("bug_report", {
      input: video,
      title: "Save fails",
      actual: "An error dialog",
      expected: "It saves",
      clipSec: 3,
      redact: false,
      maxBytes: 2_000_000,
      outputDir: out,
    });
    expect(res.isError, res.text).toBe(false);
    const data = res.data!;
    expect(data.outputDir).toBe(out);
    expect(res.images).toBe(1);
    for (const f of ["report.md", "report.json", "clip.mp4", "repro.gif", "contact-sheet.png"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    const clip = await probeMedia(join(out, "clip.mp4"));
    expect(clip.durationSec).toBeGreaterThan(2.7);
    expect(clip.durationSec).toBeLessThan(3.3);
    expect(statSync(join(out, "repro.gif")).size).toBeLessThanOrEqual(2_000_000);

    const md = readFileSync(join(out, "report.md"), "utf8");
    expect(md).toContain("# Save fails");
    expect(md).toContain("1. `0:01.0` Click at (120, 80)");
    expect(md).toContain("2. `0:02.0` Press Ctrl+S");
    expect(md).toContain("clip 0:03.0-0:06.0");
    expect(md).toContain("Not scanned for secrets");
    expect(md).not.toContain(dir); // no local paths in the shareable report
    const json = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as { steps: unknown[]; ocr: string };
    expect(json.steps).toHaveLength(2);
    expect(json.ocr).toBe(OCR ? "read" : "unavailable");

    // The same folder again is refused, then replaced with overwrite.
    const again = await call("bug_report", { input: video, clipSec: 2, redact: false, gif: false, outputDir: out });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already holds a report/);
    expect(existsSync(join(out, "report.md"))).toBe(true);
    const replaced = await call("bug_report", {
      input: video, clipSec: 2, redact: false, gif: false, outputDir: out, overwrite: true,
    });
    expect(replaced.isError, replaced.text).toBe(false);
    expect((await probeMedia(join(out, "clip.mp4"))).durationSec).toBeLessThan(2.4);
  });

  it("keeps the package inside the allowed directories (#221)", async () => {
    process.env.SCREENCAST_ALLOWED_DIRS = join(home, "only-here");
    try {
      const res = await call("bug_report", { input: video, redact: false, outputDir: join(dir, "elsewhere") });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/outside the allowed directories/);
      expect(existsSync(join(dir, "elsewhere"))).toBe(false);
    } finally {
      delete process.env.SCREENCAST_ALLOWED_DIRS;
    }
  });

  it.runIf(!OCR)("refuses to package unscanned media when the secret scan cannot run", async () => {
    const res = await call("bug_report", { input: video });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/redact: false/);
  });

  it.runIf(OCR)("boxes the secret out of the clip, masks it in the report, and quotes the error (Windows OCR)", async () => {
    const res = await call("bug_report", { input: video, clipSec: 6, gif: false });
    expect(res.isError, res.text).toBe(false);
    const data = res.data as { outputDir: string; clipPath: string; errors: string[]; redaction: { found: number } };
    expect(data.redaction.found).toBeGreaterThan(0);
    expect(data.errors.some((e) => /disk full/i.test(e))).toBe(true);
    const md = readFileSync(join(data.outputDir, "report.md"), "utf8");
    expect(md).not.toContain(SECRET);
    expect(md).toMatch(/disk full/i);

    // The source still shows the token; the packaged clip does not.
    const before = await call("find_text", { input: video, scanEverySec: 2, query: "ghp_", returnImage: false });
    expect((before.data as { matchCount: number }).matchCount).toBeGreaterThan(0);
    const after = await call("find_text", { input: data.clipPath, scanEverySec: 1, query: "ghp_", returnImage: false });
    expect((after.data as { matchCount: number }).matchCount).toBe(0);
  });
});
