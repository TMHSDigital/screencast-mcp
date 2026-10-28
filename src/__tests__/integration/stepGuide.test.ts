/**
 * step_guide (#172) end to end through the MCP tool layer, on a lavfi fixture
 * with a synthetic event log and markers sidecar, with real ffmpeg: the guide
 * folder, ringed screenshots, marker headings, the self-contained HTML, the
 * overwrite guard, and output confinement. The OCR case (captions, secret
 * boxes) needs Windows OCR and skips without it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/** One pixel of a PNG as [r, g, b]. */
function pixel(png: string, x: number, y: number): number[] {
  const res = spawnSync(FFMPEG, ["-v", "error", "-i", png, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  expect(res.status, res.stderr?.toString()).toBe(0);
  return [...res.stdout];
}

describe.skipIf(!AVAILABLE)("step_guide against real ffmpeg (#172)", { timeout: 300_000 }, () => {
  let dir = "";
  let home = "";
  let video = "";
  let bare = "";
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "screencast-guide-it-"));
    home = mkdtempSync(join(tmpdir(), "screencast-guide-home-"));
    process.env.SCREENCAST_HOME = home;
    // 5 s of dark screen with a "Save" button label and a secret line.
    copyFileSync(bundledFontPath("bold"), join(dir, "font.ttf"));
    writeFileSync(join(dir, "secret.txt"), `export TOKEN=${SECRET}`);
    writeFileSync(join(dir, "save.txt"), "Save");
    const text = (file: string, x: number, y: number) =>
      `drawtext=fontfile=font.ttf:textfile=${file}:fontsize=28:fontcolor=white:x=${x}:y=${y}`;
    const res = spawnSync(
      FFMPEG,
      [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=c=0x202020:size=640x360:rate=15:duration=5",
        "-vf", `${text("save.txt", 400, 260)},${text("secret.txt", 40, 40)}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "rec.mp4",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(res.status, res.stderr).toBe(0);
    video = join(dir, "rec.mp4");
    bare = join(dir, "bare.mp4");
    copyFileSync(video, bare);
    const events: InputEvent[] = [
      { t: 0.5, type: "move", x: 50, y: 50, inFrame: true },
      { t: 1, type: "down", x: 120, y: 80, inFrame: true, button: "left" },
      { t: 1.1, type: "up", x: 120, y: 80, inFrame: true, button: "left" },
      { t: 2, type: "typing", x: 120, y: 80, inFrame: true, durationSec: 0.8 },
      { t: 3, type: "key", x: 120, y: 80, inFrame: true, keys: "Ctrl+S" },
      { t: 4, type: "down", x: 430, y: 275, inFrame: true, button: "left" },
    ];
    writeFileSync(join(dir, "rec.events.jsonl"), formatEventsJsonl(events));
    writeFileSync(
      join(dir, "rec.markers.json"),
      JSON.stringify({ markers: [{ t: 0.5, label: "Fill in the form" }, { t: 2.9, label: "Save it" }] }),
    );

    const { createServer } = await import("../../server.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    client = new Client({ name: "guide-it", version: "0" });
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
    return { isError: res.isError === true, text, data: res.structuredContent as Record<string, unknown> | undefined };
  }

  it("writes guide.md with ringed screenshots under marker headings, and a self-contained guide.html", async () => {
    const out = join(home, "guide");
    const res = await call("step_guide", { input: video, title: "Save a form", ocr: false, outputDir: out });
    expect(res.isError, res.text).toBe(false);
    const data = res.data as { outputDir: string; steps: Array<{ n?: number; caption: string; section?: string; image?: string }>; ocr: string };
    expect(data.outputDir).toBe(out);
    expect(data.ocr).toBe("off");
    expect(data.steps.map((s) => s.caption)).toEqual(["Click the marked spot", "Type text", "Press Ctrl+S", "Click the marked spot"]);
    expect(data.steps.map((s) => s.section)).toEqual(["Fill in the form", "Fill in the form", "Save it", "Save it"]);

    const images = readdirSync(join(out, "images")).sort();
    expect(images).toEqual(["step-01.png", "step-02.png", "step-03.png", "step-04.png"]);
    const shot = join(out, "images", "step-01.png");
    const size = await probeMedia(shot);
    expect([size.width, size.height]).toEqual([640, 360]);
    // The ring passes through (click.x + radius, click.y); the background is 0x202020.
    const [r, g] = pixel(shot, 120 + 17, 80);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(120);
    expect(pixel(join(out, "images", "step-02.png"), 120 + 17, 80)[0]).toBeLessThan(60); // typing: no ring

    const md = readFileSync(join(out, "guide.md"), "utf8");
    expect(md).toContain("# Save a form");
    expect(md).toContain("## Fill in the form");
    expect(md).toContain("## Save it");
    expect(md).toContain("1. Click the marked spot <sub>0:01.0</sub>");
    expect(md).toContain("![Step 1](images/step-01.png)");
    expect(md).toContain("3. Press **Ctrl+S**");
    expect(md).toContain("not scanned for secrets");
    expect(md).not.toContain(dir); // no local paths in the shareable guide

    const html = readFileSync(join(out, "guide.html"), "utf8");
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(4);
    expect(html).not.toContain("images/step-");

    // The same folder again is refused, then replaced with overwrite.
    const again = await call("step_guide", { input: video, ocr: false, outputDir: out });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already holds a guide/);
    const replaced = await call("step_guide", { input: video, ocr: false, format: "md", outputDir: out, overwrite: true, title: "Again" });
    expect(replaced.isError, replaced.text).toBe(false);
    expect(readFileSync(join(out, "guide.md"), "utf8")).toContain("# Again");
  });

  it("writes only the HTML page, with no images folder, for format html", async () => {
    const out = join(home, "html-only");
    const res = await call("step_guide", { input: video, ocr: false, format: "html", outputDir: out });
    expect(res.isError, res.text).toBe(false);
    expect(readdirSync(out)).toEqual(["guide.html"]);
  });

  it("refuses a recording without an event log", async () => {
    const res = await call("step_guide", { input: bare, ocr: false });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no input event log/);
  });

  it("keeps the guide inside the allowed directories (#221)", async () => {
    process.env.SCREENCAST_ALLOWED_DIRS = join(home, "only-here");
    try {
      const res = await call("step_guide", { input: video, ocr: false, outputDir: join(dir, "elsewhere") });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/outside the allowed directories/);
      expect(existsSync(join(dir, "elsewhere"))).toBe(false);
    } finally {
      delete process.env.SCREENCAST_ALLOWED_DIRS;
    }
  });

  it.runIf(!OCR)("refuses OCR captions where Windows OCR is unavailable", async () => {
    const res = await call("step_guide", { input: video });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/ocr: false/);
  });

  it.runIf(OCR)("captions the click from OCR and boxes the secret out (Windows OCR)", async () => {
    const res = await call("step_guide", { input: video, format: "md" });
    expect(res.isError, res.text).toBe(false);
    const data = res.data as { outputDir: string; steps: Array<{ caption: string }>; redactions: number };
    expect(data.steps[3]!.caption).toMatch(/^Click Save/);
    expect(data.redactions).toBeGreaterThan(0);
    const md = readFileSync(join(data.outputDir, "guide.md"), "utf8");
    expect(md).toContain("Click **Save**");
    expect(md).not.toContain(SECRET);
    // The secret line is boxed black in the screenshot.
    expect(pixel(join(data.outputDir, "images", "step-01.png"), 60, 50)).toEqual([0, 0, 0]);
  });
});
