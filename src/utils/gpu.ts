/**
 * GPU capture (#199): the ddagrab backend (Desktop Duplication, an FFmpeg
 * filter source) and hardware H.264 encoders (NVENC, Quick Sync, AMF).
 *
 * ddagrab hands frames over as D3D11 textures. NVENC (and AMF on recent
 * builds) encodes them without a trip through system memory ("zero copy");
 * any other encoder gets them through hwdownload. Which encoder works is
 * learned once per process with a tiny trial encode and cached, so `auto`
 * costs one probe and falls back to libx264 on a machine without one.
 *
 * ddagrab selects a display by its DXGI output index, which is not the
 * monitor:<i> order (Screen.AllScreens). The outputs' desktop rectangles are
 * read through DXGI itself and matched by geometry.
 *
 * Argument builders and parsers are pure; the probes are thin wrappers.
 */
import { ScreencastError } from "./errors.js";
import { runCapture } from "./ffmpeg.js";
import { runPowerShell } from "./monitors.js";
import { QUALITY_PRESETS, resolveQuality, type Quality } from "./targets.js";

export type HwEncoder = "nvenc" | "qsv" | "amf";
export type VideoEncoder = "x264" | HwEncoder;
export type EncoderChoice = "auto" | VideoEncoder;

export const HW_ENCODERS: readonly HwEncoder[] = ["nvenc", "qsv", "amf"];

/** The FFmpeg H.264 encoder behind each choice. */
export const ENCODER_CODECS: Record<VideoEncoder, string> = {
  x264: "libx264",
  nvenc: "h264_nvenc",
  qsv: "h264_qsv",
  amf: "h264_amf",
};

/** The quality presets as each hardware encoder's speed preset and constant
 * quality level (lower = better), roughly matching x264's CRF 28 / 23 / 18. */
export const HW_QUALITY: Record<HwEncoder, Record<Quality, { preset: string; q: number }>> = {
  nvenc: { draft: { preset: "p1", q: 30 }, standard: { preset: "p4", q: 25 }, high: { preset: "p6", q: 20 } },
  qsv: { draft: { preset: "veryfast", q: 30 }, standard: { preset: "medium", q: 25 }, high: { preset: "slower", q: 20 } },
  amf: { draft: { preset: "speed", q: 30 }, standard: { preset: "balanced", q: 25 }, high: { preset: "quality", q: 20 } },
};

/**
 * Encoder args for a quality preset. `gpuFrames` means the input is ddagrab's
 * D3D11 frames handed straight to the encoder (no pixel format to set); system
 * memory frames go to a hardware encoder as NV12 (4:2:0, web-safe). Pure.
 */
export function encoderArgs(encoder: VideoEncoder, quality: Quality, opts: { gpuFrames?: boolean } = {}): string[] {
  if (!QUALITY_PRESETS[quality]) throw new ScreencastError(`Unknown quality preset "${quality}".`);
  if (encoder === "x264") return resolveQuality(quality);
  const { preset, q } = HW_QUALITY[encoder][quality];
  const codec = ["-c:v", ENCODER_CODECS[encoder]];
  const rate =
    encoder === "nvenc"
      ? ["-preset", preset, "-rc", "vbr", "-cq", String(q), "-b:v", "0"]
      : encoder === "qsv"
        ? ["-preset", preset, "-global_quality", String(q)]
        : ["-quality", preset, "-rc", "cqp", "-qp_i", String(q), "-qp_p", String(q)];
  return [...codec, ...rate, ...(opts.gpuFrames ? [] : ["-pix_fmt", "nv12"])];
}

/** A trial encode of a few synthetic frames: succeeds only where the encoder,
 * its driver, and a capable GPU are all present. Pure. */
export function buildEncoderProbeArgs(encoder: HwEncoder): string[] {
  return [
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30",
    "-frames:v", "3",
    ...encoderArgs(encoder, "draft"),
    "-f", "null", "-",
  ];
}

/** A two-frame ddagrab capture to nowhere: with an encoder, whether it takes
 * D3D11 frames directly (zero copy); without, whether Desktop Duplication works
 * here at all (it does not over some remote sessions). Pure. */
export function buildDdaProbeArgs(encoder?: HwEncoder): string[] {
  return [
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", `ddagrab=framerate=10${encoder ? "" : ",hwdownload,format=bgra"}`,
    "-frames:v", "2",
    ...(encoder ? encoderArgs(encoder, "draft", { gpuFrames: true }) : []),
    "-f", "null", "-",
  ];
}

export type Runner = (args: string[]) => Promise<boolean>;

const PROBE_TIMEOUT_MS = 20_000;

/** Run ffmpeg and report whether it exited 0 (a timeout or spawn error is false). */
export function ffmpegRunner(ffmpeg: string): Runner {
  return async (args) => {
    try {
      const res = await runCapture(ffmpeg, args, PROBE_TIMEOUT_MS, { closeStdin: true });
      return res.code === 0;
    } catch {
      return false;
    }
  };
}

const probes = new Map<string, Promise<boolean>>();

/** Run a probe once per process (keyed by ffmpeg path and probe), sharing it
 * between concurrent callers. */
function cachedProbe(ffmpeg: string, key: string, args: string[], run: Runner): Promise<boolean> {
  const k = `${ffmpeg}\u0000${key}`;
  let p = probes.get(k);
  if (!p) {
    p = run(args);
    probes.set(k, p);
  }
  return p;
}

/** Forget every cached probe (test seam). */
export function clearGpuProbeCache(): void {
  probes.clear();
  dxgiCache = null;
}

/** Which hardware encoders pass a trial encode here. Cached per process. */
export async function probeHwEncoders(ffmpeg: string, run: Runner = ffmpegRunner(ffmpeg)): Promise<Record<HwEncoder, boolean>> {
  const results = await Promise.all(
    HW_ENCODERS.map((e) => cachedProbe(ffmpeg, `enc:${e}`, buildEncoderProbeArgs(e), run)),
  );
  return Object.fromEntries(HW_ENCODERS.map((e, i) => [e, results[i]])) as Record<HwEncoder, boolean>;
}

/** The largest frame each hardware H.264 encoder takes (#253). NVENC's H.264
 * encoder stops at 4096 px a side; Quick Sync and AMF at about 4096x2304
 * (4K DCI-ish). A super-ultrawide or 5K display is over the line; libx264
 * has no such limit. */
export const HW_MAX_FRAME: Record<HwEncoder, { width: number; height: number }> = {
  nvenc: { width: 4096, height: 4096 },
  qsv: { width: 4096, height: 2304 },
  amf: { width: 4096, height: 2304 },
};

/** Whether a hardware encoder takes frames of this size. Pure. */
export function encoderFits(encoder: HwEncoder, frame: { width: number; height: number }): boolean {
  const max = HW_MAX_FRAME[encoder];
  return frame.width <= max.width && frame.height <= max.height;
}

export interface EncoderPick {
  encoder: VideoEncoder;
  /** ddagrab frames go to the encoder without a copy to system memory. */
  gpuFrames: boolean;
  /** Why `auto` settled on x264, when it did. */
  note?: string;
}

/**
 * Settle the encoder for a recording. `auto` takes the first hardware encoder
 * that passes its trial encode and takes the capture's frame size, else
 * libx264; an explicit hardware encoder that fails its trial, or cannot take
 * the frame size, is an error. With ddagrab, a second trial decides whether
 * the encoder takes D3D11 frames directly or needs hwdownload.
 *
 * The trial encode is 256x256, so it cannot tell whether the encoder takes the
 * real capture size: `frame` (the capture's width and height, when known) is
 * checked against HW_MAX_FRAME instead (#253).
 */
export async function resolveEncoder(
  choice: EncoderChoice,
  backend: "gdigrab" | "ddagrab",
  ffmpeg: string,
  run: Runner = ffmpegRunner(ffmpeg),
  frame?: { width: number; height: number },
): Promise<EncoderPick> {
  if (choice === "x264") return { encoder: "x264", gpuFrames: false };
  const fits = (e: HwEncoder) => !frame || encoderFits(e, frame);
  const size = frame ? `${frame.width}x${frame.height}` : "";
  if (choice !== "auto" && !fits(choice)) {
    const max = HW_MAX_FRAME[choice];
    throw new ScreencastError(
      `The ${choice} encoder (${ENCODER_CODECS[choice]}) cannot encode a ${size} frame (at most ${max.width}x${max.height}).`,
      'Use encoder: "x264" (or "auto", which picks libx264 for it), or record a smaller target.',
    );
  }
  const available = await probeHwEncoders(ffmpeg, run);
  const pick: HwEncoder | undefined =
    choice === "auto" ? HW_ENCODERS.find((e) => available[e] && fits(e)) : available[choice] ? choice : undefined;
  if (!pick) {
    if (choice === "auto") {
      const working = HW_ENCODERS.filter((e) => available[e]);
      return {
        encoder: "x264",
        gpuFrames: false,
        note:
          working.length > 0
            ? `The capture is ${size}, larger than the hardware encoders here take (${working
                .map((e) => `${e}: ${HW_MAX_FRAME[e].width}x${HW_MAX_FRAME[e].height}`)
                .join(", ")}); using libx264.`
            : "No hardware encoder passed a trial encode; using libx264.",
      };
    }
    throw new ScreencastError(
      `The ${choice} encoder (${ENCODER_CODECS[choice]}) failed a trial encode on this machine.`,
      'Use encoder: "auto" (falls back to libx264) or "x264"; doctor lists the encoders that work here.',
    );
  }
  const gpuFrames =
    backend === "ddagrab" && (await cachedProbe(ffmpeg, `dda:${pick}`, buildDdaProbeArgs(pick), run));
  return { encoder: pick, gpuFrames };
}

/**
 * Start a capture with the picked encoder, and when a hardware encoder makes
 * it exit during startup, retry once with libx264 (#253): an encoder that
 * passed its small trial encode can still refuse the real capture (its size,
 * a session limit, a busy GPU). `launch` starts and settles one attempt;
 * `canFallback` says whether libx264 can take this capture at all;
 * `beforeRetry` clears what the failed attempt left. The returned pick carries
 * a note when it fell back, and `failure` says why the hardware attempt ended.
 */
export async function startWithEncoderFallback<T extends { settled: "running" | "exited" }>(
  pick: EncoderPick,
  launch: (p: EncoderPick) => Promise<T>,
  opts: { why: (run: T) => string; canFallback?: () => Promise<boolean>; beforeRetry?: () => void },
): Promise<{ run: T; pick: EncoderPick; failure?: string }> {
  const first = await launch(pick);
  if (first.settled === "running" || pick.encoder === "x264") return { run: first, pick };
  const fallback: EncoderPick = { encoder: "x264", gpuFrames: false };
  if (opts.canFallback && !(await opts.canFallback())) return { run: first, pick };
  const name = `${pick.encoder} (${ENCODER_CODECS[pick.encoder]})`;
  const why = opts.why(first).trim();
  const failure = `the ${name} encoder exited at start${why ? `:\n${why}` : ""}`;
  opts.beforeRetry?.();
  const run = await launch(fallback);
  if (run.settled === "exited") return { run, pick: fallback, failure };
  const last = why.split("\n").at(-1) ?? "";
  return {
    run,
    pick: { ...fallback, note: `The ${name} encoder exited at start; recording with libx264 instead.${last ? ` ffmpeg said: ${last}` : ""}` },
    failure,
  };
}

/** Whether Desktop Duplication captures here (cached per process). */
export function ddagrabWorks(ffmpeg: string, run: Runner = ffmpegRunner(ffmpeg)): Promise<boolean> {
  return cachedProbe(ffmpeg, "dda", buildDdaProbeArgs(), run);
}

// ---------------------------------------------------------------------------
// DXGI outputs (which display ddagrab's output_idx is)

export interface DxgiOutput {
  adapter: number;
  /** ddagrab's output_idx (per adapter). */
  output: number;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

/** Parse the DXGI script's `adapter,output,x,y,w,h,name` lines. Pure. */
export function parseDxgiOutputs(stdout: string): DxgiOutput[] {
  const out: DxgiOutput[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(",");
    if (parts.length < 7) continue;
    const n = parts.slice(0, 6).map(Number);
    if (n.some((v) => !Number.isInteger(v))) continue;
    const [adapter = 0, output = 0, x = 0, y = 0, w = 0, h = 0] = n;
    if (w <= 0 || h <= 0) continue;
    out.push({ adapter, output, x, y, w, h, name: parts.slice(6).join(",") });
  }
  return out;
}

// DXGI reports desktop rectangles in physical pixels (DPI-independent), the
// same space as monitor bounds and gdigrab. COM interfaces are declared only up
// to the methods used; earlier vtable slots are placeholders.
const PS_DXGI = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ScDxgi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DESC { [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name; public int L, T, R, B; public int Attached; public int Rot; public IntPtr Mon; }
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IF1 { void a(); void b(); void c(); void d(); void e(); void f(); void g(); void h(); void i();
    [PreserveSig] int EnumAdapters1(uint i, [MarshalAs(UnmanagedType.Interface)] out IA1 a); }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IA1 { void a(); void b(); void c(); void d();
    [PreserveSig] int EnumOutputs(uint i, [MarshalAs(UnmanagedType.Interface)] out IO o); }
  [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IO { void a(); void b(); void c(); void d(); [PreserveSig] int GetDesc(out DESC d); }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IF1 f);
  public static string List() {
    Guid g = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); IF1 f;
    if (CreateDXGIFactory1(ref g, out f) != 0) return "";
    StringBuilder sb = new StringBuilder(); IA1 a;
    for (uint ai = 0; f.EnumAdapters1(ai, out a) == 0; ai++) { IO o;
      for (uint oi = 0; a.EnumOutputs(oi, out o) == 0; oi++) { DESC d;
        if (o.GetDesc(out d) == 0) sb.AppendFormat("{0},{1},{2},{3},{4},{5},{6}\\n", ai, oi, d.L, d.T, d.R - d.L, d.B - d.T, d.Name); } }
    return sb.ToString(); } }
"@
[ScDxgi]::List()
`;

/** How long a DXGI layout is reused (displays rarely change mid-session). */
const DXGI_CACHE_MS = 5_000;
let dxgiCache: { at: number; outputs: Promise<DxgiOutput[]> } | null = null;

/** The DXGI outputs (displays) and their desktop rectangles. Windows only. */
export function getDxgiOutputs(): Promise<DxgiOutput[]> {
  if (dxgiCache && Date.now() - dxgiCache.at < DXGI_CACHE_MS) return dxgiCache.outputs;
  const outputs = runPowerShell(PS_DXGI, "DXGI outputs").then(parseDxgiOutputs);
  dxgiCache = { at: Date.now(), outputs };
  outputs.catch(() => {
    dxgiCache = null;
  });
  return outputs;
}

export interface DdaSource {
  /** ddagrab output_idx. */
  output: number;
  /** Crop inside that output, when the rectangle is not the whole display. */
  crop?: { x: number; y: number; w: number; h: number };
}

const evenDown = (n: number) => n - (n % 2);

/**
 * Map a desktop rectangle to the ddagrab output that holds it. ddagrab captures
 * one display of the default (first) adapter, so a rectangle that spans
 * displays, or sits on a display another GPU drives, is an error that points
 * at gdigrab. Width and height are rounded down to even (H.264 4:2:0). Pure.
 */
export function planDdaSource(rect: { x: number; y: number; w: number; h: number }, outputs: DxgiOutput[]): DdaSource {
  const holds = (o: DxgiOutput) => rect.x >= o.x && rect.y >= o.y && rect.x + rect.w <= o.x + o.w && rect.y + rect.h <= o.y + o.h;
  const host = outputs.find(holds);
  if (!host) {
    throw new ScreencastError(
      `backend "ddagrab" captures one display, and ${rect.x},${rect.y} ${rect.w}x${rect.h} is not inside a single one.`,
      'Use a monitor:<i> target, a region inside one display, or backend "gdigrab".',
    );
  }
  if (host.adapter !== 0) {
    throw new ScreencastError(
      `That display (${host.name || `adapter ${host.adapter} output ${host.output}`}) is driven by a second GPU, which ddagrab cannot reach.`,
      'Use backend "gdigrab" for it.',
    );
  }
  const w = evenDown(rect.w);
  const h = evenDown(rect.h);
  if (w <= 0 || h <= 0) throw new ScreencastError("The capture rectangle is too small to record (needs at least 2x2 px).");
  const whole = rect.x === host.x && rect.y === host.y && w === host.w && h === host.h;
  return whole ? { output: host.output } : { output: host.output, crop: { x: rect.x - host.x, y: rect.y - host.y, w, h } };
}

/** The ddagrab input (lavfi, so audio and webcam inputs still index after it).
 * Cursor drawing stays on; `download` brings frames to system memory for an
 * encoder that cannot take D3D11 textures. Pure. */
export function buildDdaInputArgs(src: DdaSource, fps: number, opts: { download: boolean; drawMouse?: boolean }): string[] {
  const crop = src.crop
    ? `:offset_x=${src.crop.x}:offset_y=${src.crop.y}:video_size=${src.crop.w}x${src.crop.h}`
    : "";
  const mouse = opts.drawMouse === false ? 0 : 1;
  const graph = `ddagrab=output_idx=${src.output}:framerate=${fps}:draw_mouse=${mouse}${crop}${opts.download ? ",hwdownload,format=bgra" : ""}`;
  return ["-f", "lavfi", "-i", graph];
}
