/**
 * Recording one window through Windows Graphics Capture (#113).
 *
 * FFmpeg's gfxcapture source emits a frame only when the window repaints. A
 * static window therefore produces no frames at all, so ffmpeg reading it
 * directly stalls and ignores the graceful-stop "q". Recording goes through a
 * small recorder process instead (src/wgcRecorder.ts):
 *
 *   grab ffmpeg   gfxcapture (by HWND) -> raw yuv420p frames on stdout
 *   recorder      keeps the latest frame and writes it to the encoder at a
 *                 fixed rate, repeating it while the window is static
 *   encode ffmpeg raw frames on stdin -> the recording
 *
 * One RedrawWindow at start (the same repaint a window gets when uncovered)
 * produces the first frame. The recorder speaks ffmpeg's protocol to the
 * session code: "q" on stdin (or the duration cap) finalizes the file and
 * exits 0. Everything in this module is pure.
 */
import { ScreencastError } from "./errors.js";

export interface WgcRecorderConfig {
  ffmpeg: string;
  hwnd: number;
  fps: number;
  /** Encoder args from resolveQuality (codec, preset, crf, pix_fmt). */
  encode: string[];
  output: string;
  /** 0 = no cap. */
  maxDurationSec: number;
}

/** ffmpeg args that turn a window's WGC frames into raw yuv420p on stdout,
 * cropped to even dimensions for the encoder. */
export function buildWgcGrabArgs(hwnd: number, fps: number): string[] {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new ScreencastError("Invalid window handle.");
  return [
    "-hide_banner", "-nostats", "-loglevel", "info",
    "-f", "lavfi",
    "-i", `gfxcapture=hwnd=${hwnd}:max_framerate=${fps},hwdownload,format=bgra,crop=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
    // Without this the end of a frame waits in ffmpeg's output buffer until the
    // next frame pushes it out, so a window that repaints once never shows it.
    "-flush_packets", "1",
    "-f", "rawvideo", "-",
  ];
}

/** The raw frame size from the grab ffmpeg's output stream line, e.g.
 * "Stream #0:0: Video: rawvideo (I420 / 0x30323449), yuv420p, 602x352, ...". */
export function parseRawSize(stderr: string): { width: number; height: number } | null {
  const out = stderr.indexOf("Output #0");
  if (out < 0) return null;
  const m = /Video: rawvideo[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr.slice(out));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function yuv420FrameBytes(width: number, height: number): number {
  return (width * height * 3) / 2;
}

/** ffmpeg args that encode raw yuv420p frames from stdin at a fixed rate,
 * fragmented like gdigrab recordings so a killed recorder still leaves a
 * playable file. */
export function buildWgcEncodeArgs(width: number, height: number, cfg: WgcRecorderConfig): string[] {
  return [
    "-hide_banner", "-nostats", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${width}x${height}`, "-framerate", String(cfg.fps),
    "-i", "pipe:0",
    ...cfg.encode,
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    cfg.output,
  ];
}

/** Frames the output should have after `elapsedMs`: the first frame at 0, then
 * one per 1/fps second. Pacing to this keeps the video on wall-clock time even
 * when frames are repeated or skipped. */
export function framesDue(elapsedMs: number, fps: number): number {
  return Math.floor((elapsedMs * fps) / 1000) + 1;
}

/** What the recorder prints when its first frame is written: the same shape as
 * ffmpeg's input banner, so parseCaptureStart aligns the input event log
 * (#118) exactly as it does for gdigrab. */
export function startBanner(epochMs: number): string {
  return `Input #0, wgc, from 'window':\n  Duration: N/A, start: ${(epochMs / 1000).toFixed(6)}, bitrate: N/A\n`;
}

/** Keep a WGC capture flowing: repaint a 1x1 pixel area of the window every
 * `intervalMs` (RDW_INVALIDATE | RDW_ERASE | RDW_UPDATENOW). Measured: without
 * the erase a covered window emits no frames; one pixel is too small to flicker.
 * gfxcapture only emits frames when the window presents, and ffmpeg holds the
 * newest frame back until another arrives; without these tiny repaints the
 * first frame never comes from a static window, and its last change never
 * leaves ffmpeg. Runs in PowerShell until killed. */
export function nudgeScript(hwnd: number, intervalMs: number): string {
  return `Add-Type @"
using System;using System.Runtime.InteropServices;
public class ScNudge{
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
 [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h,ref RECT r,IntPtr g,uint f);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
"@
$r=New-Object ScNudge+RECT;$r.R=1;$r.B=1
while([ScNudge]::IsWindow([IntPtr]${hwnd})){[void][ScNudge]::RedrawWindow([IntPtr]${hwnd},[ref]$r,[IntPtr]::Zero,0x0105);Start-Sleep -Milliseconds ${intervalMs}}`;
}
