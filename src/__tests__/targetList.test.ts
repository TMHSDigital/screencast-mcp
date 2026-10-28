import { describe, it, expect } from "vitest";
import { buildTargetList } from "../utils/targetList.js";
import { parseTarget } from "../utils/targets.js";
import { selectWindow, type WindowQuery } from "../utils/windows.js";
import { parseMonitors, type Monitor } from "../utils/monitors.js";
import { envSettings, parseDevices, parseFfmpegVersion } from "../utils/capabilities.js";

const MONITORS: Monitor[] = [
  { index: 0, x: 0, y: 0, width: 2560, height: 1440, primary: true, dpi: 144 },
  { index: 1, x: 2560, y: 0, width: 1920, height: 1080, primary: false },
];
const DESKTOP: WindowQuery = {
  virtual: { x: 0, y: 0, w: 4480, h: 1440 },
  windows: [
    { title: "notes.txt - Editor", left: 100, top: 100, right: 901, bottom: 700, minimized: false, hwnd: 101, exe: "editor.exe", pid: 11 },
    { title: "notes.txt - Editor", left: 300, top: 300, right: 900, bottom: 700, minimized: false, hwnd: 102, exe: "editor.exe", pid: 11 },
    { title: "Settings", left: 0, top: 0, right: 800, bottom: 600, minimized: false, hwnd: 202, exe: "SystemSettings.exe", cloaked: true },
    { title: "Mail", left: 0, top: 0, right: 800, bottom: 600, minimized: true, hwnd: 303, exe: "mail.exe" },
    { title: "Offscreen", left: -5000, top: -5000, right: -4000, bottom: -4000, minimized: false, hwnd: 404, exe: "ghost.exe" },
  ],
};

describe("buildTargetList (#213)", () => {
  const list = buildTargetList(MONITORS, DESKTOP, { wgcAvailable: true });

  it("lists the desktop and each monitor with its DPI scale", () => {
    expect(list.full).toEqual({ target: "full", bounds: { x: 0, y: 0, width: 4480, height: 1440 } });
    expect(list.monitors.map((m) => [m.target, m.dpi, m.scale, m.primary])).toEqual([
      ["monitor:0", 144, 1.5, true],
      ["monitor:1", null, null, false],
    ]);
  });

  it("lists windows in Z-order with hwnd targets and capture flags", () => {
    const byHwnd = Object.fromEntries(list.windows.map((w) => [w.hwnd, w]));
    expect(list.windows.map((w) => w.target)).toEqual([
      "window:hwnd=101", "window:hwnd=102", "window:hwnd=202", "window:hwnd=303", "window:hwnd=404",
    ]);
    expect(byHwnd[101]).toMatchObject({ exe: "editor.exe", pid: 11, capturable: true, wgcCapturable: true, bounds: { x: 100, y: 100, width: 801, height: 600 } });
    expect(byHwnd[101].reason).toBeUndefined();
    expect(byHwnd[202]).toMatchObject({ cloaked: true, capturable: false, wgcCapturable: true, pid: null });
    expect(byHwnd[202].reason).toMatch(/cloaked/);
    expect(byHwnd[303]).toMatchObject({ minimized: true, capturable: false, wgcCapturable: false });
    expect(byHwnd[303].reason).toMatch(/minimized/);
    expect(byHwnd[404]).toMatchObject({ capturable: false, wgcCapturable: false });
  });

  it("marks nothing wgc-capturable without gfxcapture", () => {
    const noWgc = buildTargetList(MONITORS, DESKTOP, { wgcAvailable: false });
    expect(noWgc.windows.some((w) => w.wgcCapturable)).toBe(false);
    expect(noWgc.wgcAvailable).toBe(false);
  });

  it("filters by exe, title, and capturability", () => {
    const pick = (filter: Parameters<typeof buildTargetList>[2]["filter"]) =>
      buildTargetList(MONITORS, DESKTOP, { wgcAvailable: true, filter }).windows.map((w) => w.hwnd);
    expect(pick({ exe: "Editor.EXE" })).toEqual([101, 102]);
    expect(pick({ exe: "editor" })).toEqual([101, 102]);
    expect(pick({ titleContains: "SETT" })).toEqual([202]);
    expect(pick({ capturableOnly: true })).toEqual([101, 102, 202]);
  });

  it("returns targets that resolve back to the same monitor or window", () => {
    for (const t of [list.full, ...list.monitors]) expect(() => parseTarget(t.target)).not.toThrow();
    for (const w of list.windows.filter((e) => e.capturable || e.wgcCapturable)) {
      const parsed = parseTarget(w.target);
      expect(parsed.kind).toBe("window");
      const title = parsed.kind === "window" ? parsed.title : "";
      expect(selectWindow(DESKTOP, title, { allowCloaked: !w.capturable }).hwnd).toBe(w.hwnd);
    }
  });

  it("falls back to a title target when enumeration gave no handle", () => {
    const q: WindowQuery = { virtual: DESKTOP.virtual, windows: [{ title: "Untitled", left: 0, top: 0, right: 100, bottom: 100, minimized: false }] };
    expect(buildTargetList([], q, { wgcAvailable: true }).windows[0]).toMatchObject({ target: "window:Untitled", hwnd: null, capturable: true, wgcCapturable: false });
  });
});

describe("parseMonitors DPI (#213)", () => {
  it("keeps a reported DPI and drops a missing one", () => {
    const ms = parseMonitors([{ X: 0, Y: 0, Width: 1920, Height: 1080, Primary: true, Dpi: 120 }, { X: 1920, Y: 0, Width: 1920, Height: 1080, Dpi: 0 }]);
    expect(ms[0].dpi).toBe(120);
    expect("dpi" in ms[1]).toBe(false);
  });
});

describe("capabilities parsing (#195)", () => {
  it("reads the release from a version string", () => {
    expect(parseFfmpegVersion("ffmpeg version 8.0-full_build-www.gyan.dev Copyright (c) 2000-2025")).toEqual({ version: "8.0-full_build-www.gyan.dev", major: 8, inferred: false });
    expect(parseFfmpegVersion("ffmpeg version n7.1.1 Copyright")).toMatchObject({ major: 7, inferred: false });
    expect(parseFfmpegVersion("ffprobe version 6.1.1-3ubuntu5 Copyright")).toMatchObject({ major: 6 });
  });

  it("infers a git build's release from libavutil", () => {
    const text = "ffmpeg version 2025-08-20-git-abc123-full_build Copyright\n  libavutil      60.  8.100 / 60.  8.100\n";
    expect(parseFfmpegVersion(text)).toEqual({ version: "2025-08-20-git-abc123-full_build", major: 8, inferred: true });
    expect(parseFfmpegVersion("ffmpeg version N-118000-g1234\n libavutil      59. 39.100 / 59. 39.100")).toMatchObject({ major: 7, inferred: true });
  });

  it("returns nulls for unrecognized output", () => {
    expect(parseFfmpegVersion("")).toEqual({ version: null, major: null, inferred: false });
  });

  it("parses device names from ffmpeg -devices", () => {
    const text = [
      "Devices:",
      " D. = Demuxing supported",
      " .E = Muxing supported",
      " ---",
      " D  dshow           DirectShow capture",
      " D  gdigrab         GDI API Windows frame grabber",
      " D  lavfi           Libavfilter virtual input device",
      "  E sdl,sdl2        SDL2 output device",
    ].join("\n");
    expect(parseDevices(text)).toEqual(["dshow", "gdigrab", "lavfi", "sdl", "sdl2"]);
  });

  it("reports set settings and nulls for unset or blank ones", () => {
    const env = envSettings({ SCREENCAST_HOME: "C:\\sc", FFMPEG_PATH: "  " });
    expect(env.SCREENCAST_HOME).toBe("C:\\sc");
    expect(env.FFMPEG_PATH).toBeNull();
    expect(env.SCREENCAST_WHISPER_MODEL).toBeNull();
  });
});
