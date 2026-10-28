/**
 * cut_by_transcript against real ffmpeg (#173): a synthetic SRT drives the
 * cuts on a lavfi fixture whose picture flashes white and whose audio beeps
 * at the same moment. After the cut, the file is as long as the kept
 * transcript, video and audio streams match, the flash and the beep still
 * coincide (A/V sync), and the re-timed SRT lines up with the new timeline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { binaryWorks, runCapture, runFfmpeg } from "../../utils/ffmpeg.js";
import { parseSrt } from "../../utils/captions.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);

const home = mkdtempSync(join(tmpdir(), "sc-transcript-it-"));
process.env.SCREENCAST_HOME = home;
const p = (name: string) => join(home, name);

const SRT = `1
00:00:00,000 --> 00:00:02,000
Welcome to the demo.

2
00:00:02,000 --> 00:00:04,000
Um.

3
00:00:04,000 --> 00:00:06,000
First we open the settings page.

4
00:00:06,000 --> 00:00:09,000
Then the flash happens here.
`;

async function streamDurations(f: string): Promise<{ video: number; audio: number }> {
  const r = await runCapture(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", f]);
  const s = JSON.parse(r.stdout).streams as Array<{ codec_type: string; duration: string }>;
  return Object.fromEntries(s.map((x) => [x.codec_type, Number(x.duration)])) as { video: number; audio: number };
}

/** When the white flash starts (end of the first black stretch) and when the
 * beep starts (end of the first silence). */
async function flashAndBeep(f: string): Promise<{ flash: number; beep: number }> {
  const r = await runCapture(FFMPEG, [
    "-hide_banner", "-nostats", "-i", f,
    "-vf", "blackdetect=d=0.1:pix_th=0.1", "-af", "silencedetect=n=-40dB:d=0.1", "-f", "null", "-",
  ]);
  const flash = Number(r.stderr.match(/black_end:\s*([\d.]+)/)?.[1]);
  const beep = Number(r.stderr.match(/silence_end:\s*([\d.]+)/)?.[1]);
  return { flash, beep };
}

describe.skipIf(!AVAILABLE)("cut_by_transcript against real ffmpeg (#173)", { timeout: 120_000 }, () => {
  const src = p("narrated.mp4");
  const srt = p("narrated.srt");
  let client: Client;

  beforeAll(async () => {
    // 10 s: black with a white flash at 7-7.3 s, silence with a beep at 7-7.3 s.
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i",
      "color=c=black:s=160x120:r=30:d=10,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,7,7.3)'",
      "-f", "lavfi", "-i", "sine=f=1000:d=10,volume='between(t,7,7.3)':eval=frame",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", src,
    ]);
    writeFileSync(srt, SRT);
    const { createServer } = await import("../../server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "transcript-it", version: "0.0.0" });
    await client.connect(clientSide);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function call(args: Record<string, unknown>) {
    const res = await client.callTool({ name: "cut_by_transcript", arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("the fixture's flash and beep coincide at 7 s", async () => {
    const at = await flashAndBeep(src);
    expect(at.flash).toBeCloseTo(7, 1);
    expect(at.beep).toBeCloseTo(7, 1);
  });

  it("dryRun reports the cuts and the edited text without writing", async () => {
    const res = await call({ input: src, srt, remove: ["first we open the settings page"], fillers: true, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.cuts).toEqual([{ start: 2, end: 6, text: "Um. First we open the settings page.", exact: true }]);
    expect(res.text).toBe("Welcome to the demo. Then the flash happens here.");
    expect(res.outputPath).toBeUndefined();
  });

  it("cuts a quoted sentence and a filler, keeping audio and video in sync", async () => {
    const res = await call({ input: src, srt, remove: ["first we open the settings page"], fillers: true, output: p("cut.mp4") });
    expect(res.removedSec).toBe(4);
    expect(res.newDurationSec).toBe(6);
    const d = await streamDurations(p("cut.mp4"));
    expect(d.video).toBeCloseTo(6, 1);
    expect(Math.abs(d.video - d.audio)).toBeLessThan(0.1);
    const at = await flashAndBeep(p("cut.mp4"));
    expect(at.flash).toBeCloseTo(3, 1);
    expect(Math.abs(at.flash - at.beep)).toBeLessThan(0.05);
    // The re-timed transcript still lines up: the last cue now starts at 2 s,
    // so the flash (1 s into it) still lands 1 s into its line.
    expect(res.srtPath).toBe(p("cut.srt"));
    expect(parseSrt(readFileSync(p("cut.srt"), "utf8"))).toEqual([
      { start: 0, end: 2, text: "Welcome to the demo." },
      { start: 2, end: 5, text: "Then the flash happens here." },
    ]);
  });

  it("cuts by cue number and refuses an existing re-timed transcript", async () => {
    const res = await call({ input: src, srt, remove: [1], output: p("cue.mp4") });
    expect(res.removedSec).toBe(2);
    const at = await flashAndBeep(p("cue.mp4"));
    expect(at.flash).toBeCloseTo(5, 1);
    expect(Math.abs(at.flash - at.beep)).toBeLessThan(0.05);
    writeFileSync(p("taken.srt"), "");
    await expect(call({ input: src, srt, remove: [1], output: p("taken.mp4") })).rejects.toThrow(/already exists/);
  });
});
