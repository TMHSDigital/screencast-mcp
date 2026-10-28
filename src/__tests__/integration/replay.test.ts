/**
 * Instant replay against real ffmpeg (#197): a lavfi source written through
 * the same segment-ring args start_recording uses, so rotation keeps disk
 * bounded, save_replay cuts the requested length while the buffer runs, and a
 * stopped buffer saves whole. Skipped when ffmpeg is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryWorks } from "../../utils/ffmpeg.js";
import { captureKeyframeArgs, resolveQuality } from "../../utils/targets.js";
import {
  parseSegmentList,
  saveReplay,
  segmentListPath,
  segmentOutputArgs,
  replayWrap,
  type ReplayBuffer,
} from "../../utils/replay.js";
import { parseEventsJsonl } from "../../utils/events.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AVAILABLE = binaryWorks(FFMPEG) && binaryWorks(FFPROBE);

function probe(path: string): { duration: number; frames: number; audio: boolean } {
  const res = spawnSync(
    FFPROBE,
    ["-v", "error", "-count_frames", "-show_entries", "format=duration:stream=codec_type,nb_read_frames", "-of", "json", path],
    { encoding: "utf8" },
  );
  const data = JSON.parse(res.stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; nb_read_frames?: string }> };
  const video = data.streams.find((s) => s.codec_type === "video");
  return {
    duration: Number(data.format.duration),
    frames: Number(video?.nb_read_frames ?? 0),
    audio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const segmentFiles = (dir: string) => readdirSync(dir).filter((f) => /^seg\d+\.ts$/.test(f));

describe.skipIf(!AVAILABLE)("instant replay buffer (#197)", { timeout: 90_000 }, () => {
  let root = "";
  let child: ChildProcess | null = null;
  let buf: ReplayBuffer;
  const startMs = Date.now();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "screencast-replay-"));
    const dir = join(root, "buf-test");
    const bufferSec = 4;
    buf = {
      dir,
      bufferSec,
      segmentSec: 2,
      wrap: replayWrap(bufferSec),
      events: { raw: join(dir, "events.raw"), keys: "masked", startMs, frame: { x: 0, y: 0, w: 320, h: 240 } },
    };
    mkdirSync(dir, { recursive: true });
    // A click every 0.5 s of wall clock, so any slice holds a predictable count.
    const lines: string[] = [];
    for (let ms = 0; ms <= 60_000; ms += 500) lines.push(`${startMs + ms},down,10,20,left`);
    writeFileSync(buf.events!.raw, lines.join("\n") + "\n");
    // What start_recording builds for gdigrab, with a real-time lavfi source
    // (and audio) in place of the screen.
    const capture = [
      "-y", "-v", "error",
      "-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
      "-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      ...resolveQuality("draft"),
      ...captureKeyframeArgs(30),
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-t", "60",
      join(root, "unused.mp4"),
    ];
    child = spawn(FFMPEG, segmentOutputArgs(capture, buf), { stdio: ["pipe", "ignore", "pipe"] });
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child?.once("exit", r));
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("rotates segments so the ring never outgrows the buffer", async () => {
    // 14 s is more than a lap of the 7-slot (14 s) ring.
    let most = 0;
    const until = Date.now() + 14_500;
    while (Date.now() < until) {
      most = Math.max(most, segmentFiles(buf.dir).length);
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(child?.exitCode).toBeNull();
    expect(most).toBeLessThanOrEqual(buf.wrap);
    expect(segmentFiles(buf.dir)).toHaveLength(buf.wrap);
    const entries = parseSegmentList(readFileSync(segmentListPath(buf.dir), "utf8"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(buf.wrap);
    expect(entries.at(-1)!.end).toBeGreaterThan(10);
  });

  it("saves the requested length while the buffer keeps running", async () => {
    const out = join(root, "live.mp4");
    const started = Date.now();
    const res = await saveReplay(buf, { ffmpeg: FFMPEG, ffprobe: FFPROBE, lastSec: 3, output: out });
    const elapsed = Date.now() - started;
    expect(child?.exitCode).toBeNull();
    const media = probe(out);
    expect(media.duration).toBeGreaterThan(2.9);
    expect(media.duration).toBeLessThan(3.15);
    expect(media.frames).toBeGreaterThanOrEqual(87);
    expect(media.frames).toBeLessThanOrEqual(93);
    expect(media.audio).toBe(true);
    expect(res.durationSec).toBeCloseTo(3, 1);
    expect(res.toSec - res.fromSec).toBeCloseTo(3, 1);
    expect(res.fromSec).toBeGreaterThan(9);
    // Well within "about a second" on a dev box; generous for slow CI.
    expect(elapsed).toBeLessThan(5_000);
    // The event slice is re-timed to the clip: a click every 0.5 s.
    const events = parseEventsJsonl(readFileSync(res.eventsPath!, "utf8"));
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.length).toBeLessThanOrEqual(7);
    expect(events.every((e) => e.t >= 0 && e.t <= res.durationSec + 0.001)).toBe(true);
    // Snapshot directories are cleaned up.
    expect(readdirSync(buf.dir).filter((f) => f.startsWith("save-"))).toEqual([]);
  });

  it("re-encodes frame-exact on request", async () => {
    const out = join(root, "exact.mp4");
    await saveReplay(buf, { ffmpeg: FFMPEG, ffprobe: FFPROBE, lastSec: 2.5, output: out, reencode: true, quality: "draft" });
    const media = probe(out);
    expect(media.duration).toBeGreaterThan(2.4);
    expect(media.duration).toBeLessThan(2.65);
    expect(media.frames).toBeGreaterThanOrEqual(73);
    expect(media.frames).toBeLessThanOrEqual(77);
  });

  it("saves the whole buffer after a graceful stop", async () => {
    child!.stdin!.write("q");
    child!.stdin!.end();
    await waitFor(() => child!.exitCode !== null, 10_000);
    expect(child!.exitCode).toBe(0);
    const out = join(root, "stopped.mp4");
    const res = await saveReplay(buf, { ffmpeg: FFMPEG, ffprobe: FFPROBE, lastSec: buf.bufferSec, output: out, live: false });
    expect(res.includesLive).toBe(false);
    const media = probe(out);
    expect(media.duration).toBeGreaterThan(3.9);
    expect(media.duration).toBeLessThan(4.15);
    expect(existsSync(out)).toBe(true);
  });
});
