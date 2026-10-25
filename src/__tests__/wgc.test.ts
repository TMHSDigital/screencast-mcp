/** #113: recording one window through Windows Graphics Capture. */
import { describe, it, expect } from "vitest";
import { buildWgcEncodeArgs, buildWgcGrabArgs, framesDue, nudgeScript, parseRawSize, startBanner, yuv420FrameBytes, wgcStopFile } from "../utils/wgc.js";
import { parseCaptureStart } from "../utils/events.js";

const CFG = { ffmpeg: "ffmpeg", hwnd: 4242, fps: 15, encode: ["-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p"], output: "o.mp4", maxDurationSec: 0 };

describe("wgc recorder helpers", () => {
  it("grabs one window by handle as even-sized raw yuv420p, flushed per frame", () => {
    const a = buildWgcGrabArgs(4242, 15);
    const graph = a[a.indexOf("-i") + 1];
    expect(graph).toBe("gfxcapture=hwnd=4242:max_framerate=15,hwdownload,format=bgra,crop=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p");
    expect(a.slice(a.indexOf("-flush_packets"), a.indexOf("-flush_packets") + 2)).toEqual(["-flush_packets", "1"]);
    expect(a.slice(-3)).toEqual(["-f", "rawvideo", "-"]);
    expect(() => buildWgcGrabArgs(0, 15)).toThrow(/handle/);
  });

  it("reads the frame size from the output stream line, not the input", () => {
    const stderr = [
      "Input #0, lavfi, from 'gfxcapture=hwnd=1':",
      "  Stream #0:0: Video: wrapped_avframe, d3d11, 403x333, 30 fps",
      "Output #0, rawvideo, to 'pipe:':",
      "  Stream #0:0: Video: rawvideo (I420 / 0x30323449), yuv420p(progressive), 402x332, q=2-31, 30 fps",
    ].join("\n");
    expect(parseRawSize(stderr)).toEqual({ width: 402, height: 332 });
    expect(parseRawSize(stderr.split("Output")[0])).toBeNull();
    expect(yuv420FrameBytes(402, 332)).toBe(200196);
  });

  it("encodes raw frames from stdin at a fixed rate into a fragmented mp4", () => {
    const a = buildWgcEncodeArgs(400, 300, CFG);
    expect(a.join(" ")).toContain("-f rawvideo -pix_fmt yuv420p -s 400x300 -framerate 15 -i pipe:0 -c:v libx264");
    expect(a).toContain("+frag_keyframe+empty_moov+default_base_moof");
    expect(a.at(-1)).toBe("o.mp4");
  });

  it("paces frames to wall-clock time", () => {
    expect(framesDue(0, 15)).toBe(1);
    expect(framesDue(66, 15)).toBe(1);
    expect(framesDue(67, 15)).toBe(2);
    expect(framesDue(1000, 30)).toBe(31);
  });

  it("prints a start banner the event log aligns to, like gdigrab's", () => {
    expect(parseCaptureStart(startBanner(1792936190232))).toBe(1792936190232);
  });

  it("nudges with a 1x1 erase+invalidate+update repaint until the window is gone", () => {
    const s = nudgeScript(4242, 200);
    expect(s).toContain("$r.R=1;$r.B=1");
    expect(s).toContain("0x0105"); // INVALIDATE | ERASE | UPDATENOW: covered windows need the erase
    expect(s).toContain("while([ScNudge]::IsWindow([IntPtr]4242))");
    expect(s).toContain("Start-Sleep -Milliseconds 200");
  });
});

describe("wgc recorder cleanup and stop file (#208, #182)", () => {
  it("stops repainting once the recorder process is gone", () => {
    const s = nudgeScript(4242, 200, 777);
    expect(s).toContain("Get-Process -Id 777");
    expect(s).toContain("-and $p -and !$p.HasExited");
    expect(nudgeScript(4242, 200)).not.toContain("Get-Process");
  });
  it("puts the stop file next to the output", () => {
    expect(wgcStopFile("C:/r/rec.mp4")).toBe("C:/r/rec.mp4.stop");
  });
});
