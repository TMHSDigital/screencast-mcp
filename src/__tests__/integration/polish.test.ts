/**
 * Pipeline polish ops and recipes against real ffmpeg (#244): one call turns a
 * raw recording (idle gap, quiet audio, an event log with a click, a marker)
 * into a cut, zoomed, loudness-normalized mp4 whose video and audio stay in
 * step and whose chapters and subtitles land on the cut timeline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks, runCapture, runFfmpeg, runFfmpegBuffer, probeMedia } from "../../utils/ffmpeg.js";
import { buildLoudnessMeasureArgs, loudnessTarget, parseLoudnorm } from "../../utils/audio.js";
import { probeChapters, writeMarkers } from "../../utils/chapters.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);

const home = mkdtempSync(join(tmpdir(), "sc-polish-it-"));
process.env.SCREENCAST_HOME = home;
// No whisper model: recipes leave captions out (with a note) rather than fail.
process.env.SCREENCAST_WHISPER_MODEL = "";
const p = (name: string) => join(home, name);

async function streams(f: string): Promise<{ video: number; audio: number }> {
  const r = await runCapture(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", f]);
  const s = JSON.parse(r.stdout).streams as Array<{ codec_type: string; duration: string }>;
  return Object.fromEntries(s.map((x) => [x.codec_type, Number(x.duration)])) as { video: number; audio: number };
}

/** The bottom strip of the frame at `t`, as gray bytes. */
const strip = (f: string, t: number) =>
  runFfmpegBuffer(["-v", "error", "-ss", String(t), "-i", f, "-frames:v", "1", "-vf", "crop=iw:ih/4:0:ih*3/4,format=gray", "-f", "rawvideo", "-"]);
const meanDiff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

describe.skipIf(!AVAILABLE)("pipeline polish ops and recipes against real ffmpeg (#244)", { timeout: 300_000 }, () => {
  const raw = p("raw.mp4"); // 3 s action, 4 s frozen + silent, 3 s action; quiet audio
  const srt = p("raw-captions.srt");
  let client: Client;

  beforeAll(async () => {
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=3", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30:d=4", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=3",
      "-f", "lavfi", "-i", "sine=f=440:d=3:r=48000", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=4", "-f", "lavfi", "-i", "sine=f=660:d=3:r=48000",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v];[3][4][5]concat=n=3:v=0:a=1,volume=0.05[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", raw,
    ]);
    // A click at 8 s (after the idle gap) and a marker there too, both on the source's clock.
    writeFileSync(p("raw.events.jsonl"), `${JSON.stringify({ t: 8, type: "down", x: 240, y: 60, inFrame: true })}\n`);
    writeMarkers(raw, [{ t: 0, label: "Start" }, { t: 8, label: "After the wait" }]);
    writeFileSync(srt, "1\n00:00:08,000 --> 00:00:09,500\nCAPTION TEXT HERE\n");
    const { createServer } = await import("../../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "polish-it", version: "0.0.0" });
    await client.connect(clientSide);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function call(args: Record<string, unknown>) {
    const res = await client.callTool({ name: "pipeline", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("dryRun shows a recipe's expanded steps and what it left out", async () => {
    const r = await call({ input: raw, recipe: "tutorial", dryRun: true });
    expect((r.expandedSteps as Array<{ op: string }>).map((s) => s.op)).toEqual(["cut_idle", "zoom", "audio", "export_preset"]);
    expect(String(r.warnings)).toMatch(/captions left out/);
    expect(r.measuredOnRun).toEqual(["step 3: noisefloor", "step 3: loudness"]);
    expect(r.steps).toEqual(["cut_idle 1 stretch(es), 3.2s removed", "zoom 2 keyframe(s) from 1 click(s)", "audio: denoise light, normalize to -14 LUFS", "export_preset youtube"]);
  });

  it("tutorial: one call cuts idle, zooms to the click, normalizes, and keeps A/V and chapters in step", async () => {
    const out = p("tutorial.mp4");
    const r = await call({ input: raw, recipe: "tutorial", chapters: true, quality: "draft", output: out });
    expect(r.processes).toBe(1);
    // 4 s idle minus 0.4 s kept at each edge.
    expect(r.durationSec).toBeCloseTo(6.8, 1);
    const info = await probeMedia(out);
    expect([info.width, info.height]).toEqual([1920, 1080]);
    expect(info.durationSec!).toBeCloseTo(6.8, 1);
    const d = await streams(out);
    expect(Math.abs(d.video - d.audio)).toBeLessThan(1 / 30 + 0.025); // a frame, plus AAC's last packet
    // Normalized to YouTube's -14 LUFS from about -40.
    const loud = parseLoudnorm((await runCapture(FFMPEG, buildLoudnessMeasureArgs(out, loudnessTarget("youtube")))).stderr);
    expect(Math.abs(loud.input_i - -14)).toBeLessThan(1.5);
    // The marker at source 8 s moves back by the 3.2 s cut.
    const chapters = await probeChapters(out);
    expect(chapters.map((c) => c.title)).toEqual(["Start", "After the wait"]);
    expect(chapters[1]!.start).toBeCloseTo(4.8, 1);
    expect((r.steps as string[]).join(" | ")).toMatch(/zoom \d+ keyframe\(s\) from 1 click/);
  });

  it("burn_subtitles after cut_idle shows a source-clock cue on the cut timeline", async () => {
    const plain = p("subs-off.mp4");
    const subbed = p("subs-on.mp4");
    await call({ input: raw, steps: [{ op: "cut_idle" }], quality: "draft", output: plain });
    await call({ input: raw, steps: [{ op: "cut_idle" }, { op: "burn_subtitles", subtitles: srt }], quality: "draft", output: subbed });
    // Cue 8-9.5 s on the source is 4.8-6.3 s after the cut.
    expect(meanDiff(await strip(plain, 5.5), await strip(subbed, 5.5))).toBeGreaterThan(2);
    expect(meanDiff(await strip(plain, 2), await strip(subbed, 2))).toBeLessThan(1);
    expect(meanDiff(await strip(plain, 6.6), await strip(subbed, 6.6))).toBeLessThan(1);
  });

  it("an audio-only pipeline denoises and normalizes, keeping the video's length", async () => {
    const out = p("audio-only.mp4");
    await call({ input: raw, steps: [{ op: "audio", denoise: "light", normalize: "podcast" }], quality: "draft", output: out });
    const d = await streams(out);
    expect(d.video).toBeCloseTo(10, 1);
    expect(Math.abs(d.video - d.audio)).toBeLessThan(0.06);
    const loud = parseLoudnorm((await runCapture(FFMPEG, buildLoudnessMeasureArgs(out, loudnessTarget("podcast")))).stderr);
    expect(Math.abs(loud.input_i - -16)).toBeLessThan(1.5);
  });

  it("pr_demo writes a GIF within the 10 MB budget", async () => {
    const out = p("demo.gif");
    const r = await call({ input: raw, recipe: "pr_demo", output: out });
    expect(r.processes).toBe(2);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeLessThanOrEqual(10_000_000);
    expect((await probeMedia(out)).durationSec!).toBeCloseTo(6.8, 0);
  });
});
