/**
 * Fixture media for the evals, generated with ffmpeg lavfi at run time so no
 * binary is committed, plus the small probes the outcome checks use.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Fixtures {
  /** 6 s, 320x240, 30 fps test pattern with a 440 Hz tone. */
  demo: string;
  /** 8 s: 2 s motion + tone, 4 s frozen and silent, 2 s motion + tone. */
  idle: string;
  /** 6 s gray frame; from 3 s a fake API key is drawn inside SECRET_RECT. */
  secret: string;
  /** A light screen with a gray button, and the same screen with it green. */
  before: string;
  after: string;
}

/** Where the fake key is drawn in `secret` (with a few px of margin). */
export const SECRET_RECT = { x: 12, y: 98, width: 262, height: 36 } as const;
/** The button in before/after.png. */
export const BUTTON_RECT = { x: 100, y: 90, width: 120, height: 60 } as const;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function ffmpegTools(): { ffmpeg: string; ffprobe: string } {
  return { ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe" };
}

export function ffmpegAvailable(): boolean {
  const { ffmpeg, ffprobe } = ffmpegTools();
  return [ffmpeg, ffprobe].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
}

function run(bin: string, args: string[], cwd: string): void {
  const res = spawnSync(bin, ["-hide_banner", "-v", "error", "-y", ...args], { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`fixture generation failed: ${bin} ${args.join(" ")}\n${res.stderr ?? res.error?.message ?? ""}`);
  }
}

/** Generate every fixture into `dir` (which must exist). */
export function makeFixtures(dir: string, ffmpeg = ffmpegTools().ffmpeg): Fixtures {
  const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  const f: Fixtures = {
    demo: join(dir, "demo.mp4"),
    idle: join(dir, "idle.mp4"),
    secret: join(dir, "secret.mp4"),
    before: join(dir, "before.png"),
    after: join(dir, "after.png"),
  };
  run(ffmpeg, [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000",
    ...x264, "-c:a", "aac", "-shortest", f.demo,
  ], dir);
  // Freeze frame 60 (t=2 s) for 120 frames, with silence over the same span.
  run(ffmpeg, [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
    "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,2\\,6)\\,0\\,0.3*sin(2*PI*440*t)):d=8:s=48000",
    "-filter_complex", "[0:v]loop=loop=119:size=1:start=60,setpts=N/30/TB[v]",
    "-map", "[v]", "-map", "1:a", ...x264, "-c:a", "aac", "-shortest", f.idle,
  ], dir);
  // drawtext reads the bundled font by a bare relative name (cwd = dir), which
  // sidesteps escaping a Windows drive colon inside the filter string.
  copyFileSync(join(REPO, "assets", "fonts", "Inter-Bold.ttf"), join(dir, "eval-font.ttf"));
  run(ffmpeg, [
    "-f", "lavfi", "-i", "color=c=0x808080:size=320x240:rate=30:duration=6",
    "-vf", "drawtext=fontfile=eval-font.ttf:text='API_KEY=sk-live-4f9a2c':x=20:y=106:fontsize=20:fontcolor=white:enable='gte(t,3)'",
    ...x264, f.secret,
  ], dir);
  const b = BUTTON_RECT;
  for (const [out, color] of [[f.before, "0x9e9e9e"], [f.after, "0x2e9e44"]] as const) {
    run(ffmpeg, [
      "-f", "lavfi", "-i", `color=c=0xe0e0e0:size=320x240,drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=${color}:t=fill`,
      "-frames:v", "1", out,
    ], dir);
  }
  return f;
}

export interface Probe {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  format: string;
}

/** ffprobe a file; throws when it cannot be read as media. */
export function probe(path: string, ffprobe = ffmpegTools().ffprobe): Probe {
  if (!existsSync(path)) throw new Error(`missing output: ${path}`);
  const res = spawnSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], {
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`ffprobe failed on ${path}: ${res.stderr}`);
  const json = JSON.parse(res.stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const d = Number(json.format?.duration);
  return {
    durationSec: Number.isFinite(d) ? d : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: video !== undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    format: json.format?.format_name ?? "",
  };
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

/** Gray pixels of a rectangle of the frame at `t` seconds. */
export function regionPixels(
  path: string,
  t: number,
  r: { x: number; y: number; width: number; height: number },
  ffmpeg = ffmpegTools().ffmpeg,
): Buffer {
  const res = spawnSync(ffmpeg, [
    "-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
    "-vf", `crop=${r.width}:${r.height}:${r.x}:${r.y},format=gray`, "-f", "rawvideo", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  return res.stdout ?? Buffer.alloc(0);
}

export function maxLuma(px: Buffer): number {
  let m = -1;
  for (const v of px) if (v > m) m = v;
  return m;
}

export function meanLuma(px: Buffer): number {
  if (px.length === 0) return -1;
  let s = 0;
  for (const v of px) s += v;
  return s / px.length;
}
