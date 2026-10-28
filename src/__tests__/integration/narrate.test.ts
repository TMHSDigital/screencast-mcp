/**
 * narrate against real ffmpeg and the Windows speech engine (#175): a line
 * synthesized offline lands at its time (audio energy starts there and not
 * before), marker placement works, the SRT matches, and an overrun warns.
 * Skips off Windows or when no voice is installed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks, runCapture, runFfmpeg, probeMedia } from "../../utils/ffmpeg.js";
import { writeMarkers } from "../../utils/chapters.js";
import { ttsStatus } from "../../utils/narrate.js";
import { parseSrt } from "../../utils/captions.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(process.env.FFPROBE_PATH || "ffprobe");
const TTS = AVAILABLE && process.platform === "win32" && (await ttsStatus()).available;

const home = mkdtempSync(join(tmpdir(), "sc-narrate-it-"));
process.env.SCREENCAST_HOME = home;
const p = (name: string) => join(home, name);

/** RMS level (dBFS) of each 100 ms window, with its start time. */
async function levels(path: string): Promise<Array<{ t: number; db: number }>> {
  const res = await runCapture(FFMPEG, [
    "-hide_banner", "-nostats", "-i", path, "-vn",
    "-af", "aresample=48000,asetnsamples=4800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-",
  ]);
  const out: Array<{ t: number; db: number }> = [];
  let t = 0;
  for (const line of res.stdout.split(/\r?\n/)) {
    const pts = line.match(/pts_time:([\d.]+)/);
    if (pts) t = Number(pts[1]);
    const rms = line.match(/RMS_level=(-?inf|-?[\d.]+)/);
    if (rms) out.push({ t, db: rms[1]!.endsWith("inf") ? -Infinity : Number(rms[1]) });
  }
  return out;
}

describe.skipIf(!TTS)("narrate against the Windows speech engine (#175)", { timeout: 180_000 }, () => {
  const silent = p("silent.mp4"); // 10 s, no audio
  const tone = p("tone.mp4"); // 10 s with a quiet sine
  let client: Client;

  beforeAll(async () => {
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=duration=10:size=320x240:rate=15", ...enc, silent]);
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=10:size=320x240:rate=15",
      "-f", "lavfi", "-i", "sine=frequency=220:duration=10", // about -21 dBFS RMS
      ...enc, "-c:a", "aac", "-shortest", tone,
    ]);
    const { createServer } = await import("../../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "narrate-it", version: "0.0.0" });
    await client.connect(clientSide);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function call(args: Record<string, unknown>) {
    const res = await client.callTool({ name: "narrate", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("places a synthesized line at its time: silence before, speech after", async () => {
    const res = await call({ video: silent, lines: [{ t: 4, text: "This is the narration test." }] });
    const out = res.outputPath as string;
    const info = await probeMedia(out);
    expect(info.audioCodec).toBe("aac");
    expect(info.durationSec!).toBeCloseTo(10, 0);
    expect(res.warnings).toBeUndefined();

    const lv = await levels(out);
    const loud = lv.filter((w) => w.db > -45);
    expect(loud.length).toBeGreaterThan(5);
    // Nothing before the line; speech starts within half a second of t (the
    // engine leads with a little silence).
    expect(lv.filter((w) => w.t < 3.9).every((w) => w.db < -60)).toBe(true);
    expect(loud[0]!.t).toBeGreaterThanOrEqual(3.9);
    expect(loud[0]!.t).toBeLessThan(4.6);

    const srt = parseSrt(readFileSync(res.srtPath as string, "utf8"));
    expect(srt).toHaveLength(1);
    expect(srt[0]!.start).toBeCloseTo(4, 2);
    expect(srt[0]!.text).toBe("This is the narration test.");
    const spoken = (res.lines as Array<{ durationSec: number }>)[0]!.durationSec;
    expect(spoken).toBeGreaterThan(0.8);
  });

  it("starts lines at markers, keeps the markers, ducks the original, and warns on overlap", async () => {
    writeMarkers(tone, [{ t: 2, label: "Intro" }]);
    const res = await call({
      video: tone,
      lines: [{ marker: "intro", text: "Here is a fairly long first sentence for the demo." }, { t: 2.5, text: "Overlap." }],
      rate: 1.2,
    });
    expect(res.mixedWithOriginal).toBe(true);
    expect((res.lines as Array<{ t: number }>).map((l) => l.t)).toEqual([2, 2.5]);
    expect((res.warnings as string[]).join(" ")).toMatch(/past the next line/);
    const out = res.outputPath as string;
    expect(existsSync(out.replace(/\.mp4$/, ".markers.json"))).toBe(true);
    // The tone is untouched before the narration and back after it.
    const lv = await levels(out);
    const before = lv.filter((w) => w.t > 0.5 && w.t < 1.8);
    expect(before.length).toBeGreaterThan(5);
    expect(before.every((w) => w.db > -24)).toBe(true);
    expect(lv.filter((w) => w.t > 9 && w.t < 9.8).every((w) => w.db > -24)).toBe(true);

    // Ducking lowers the bed under the voice: the same mix without it is louder there.
    const flat = await call({ video: tone, lines: [{ t: 2, text: "Here is a fairly long first sentence for the demo." }], rate: 1.2, duck: false });
    const ducked = await call({ video: tone, lines: [{ t: 2, text: "Here is a fairly long first sentence for the demo." }], rate: 1.2 });
    const mean = async (path: string) => {
      const ws = (await levels(path)).filter((w) => w.t > 2.5 && w.t < 4);
      return ws.reduce((s, w) => s + 10 ** (w.db / 10), 0) / ws.length;
    };
    expect(await mean(ducked.outputPath as string)).toBeLessThan(await mean(flat.outputPath as string));
  });

  it("names the installed voices for an unknown voice", async () => {
    await expect(call({ video: silent, lines: [{ t: 1, text: "Hi." }], voice: "No Such Voice 123" })).rejects.toThrow(/Installed voices: /);
  });
});
