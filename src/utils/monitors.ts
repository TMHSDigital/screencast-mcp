/**
 * Monitor geometry discovery.
 *
 * gdigrab has no native "capture monitor N" selector: you capture the whole
 * virtual desktop and crop to a monitor's bounds with -offset_x / -offset_y /
 * -video_size. To do that correctly on a multi-monitor setup (for example a
 * 4480x1440 dual-monitor desktop where the second display starts at x=2560),
 * we need each monitor's pixel bounds. On Windows those come from
 * System.Windows.Forms.Screen.AllScreens via PowerShell. The enumeration must be
 * per-monitor-DPI-aware, or Screen.Bounds returns LOGICAL (DPI-scaled)
 * coordinates while gdigrab works in PHYSICAL pixels - on a scaled display that
 * makes monitor:N capture a cropped top-left slice (e.g. 1280x800 of a 1920x1200
 * screen at 150%). So the shim sets DPI awareness before reading bounds, exactly
 * as the window-bounds shim in windows.ts does.
 *
 * `parseMonitors` is pure so the offset math is unit-tested without Windows.
 */
import { errorMessage, ScreencastError } from "./errors.js";
import { runPowerShell } from "./powershell.js";

export interface Monitor {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  /** Effective DPI (96 = 100% scaling), when Windows reported it (#213). */
  dpi?: number;
}

interface RawScreen {
  X?: number;
  Y?: number;
  Width?: number;
  Height?: number;
  Primary?: boolean;
  Dpi?: number;
}

/** Normalize raw PowerShell screen objects into ordered Monitor records.
 * Primary monitor is sorted first so monitor:0 is the primary display. */
export function parseMonitors(raw: unknown): Monitor[] {
  const arr: RawScreen[] = Array.isArray(raw) ? raw : raw ? [raw as RawScreen] : [];
  const screens = arr.map((s) => ({
    x: Number(s.X ?? 0),
    y: Number(s.Y ?? 0),
    width: Number(s.Width ?? 0),
    height: Number(s.Height ?? 0),
    primary: Boolean(s.Primary),
    ...(Number(s.Dpi) > 0 ? { dpi: Number(s.Dpi) } : {}),
  }));
  screens.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
  return screens.map((s, index) => ({ index, ...s }));
}

// Set per-monitor-DPI-awareness-v2 (-4) before reading Screen.AllScreens so the
// bounds are PHYSICAL pixels (matching gdigrab), not DPI-scaled logical ones.
// Passed base64 (EncodedCommand) so the C# shim needs no quoting through argv.
const PS_SCRIPT = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class DpiShim{ [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
 public struct PT{public int X,Y;}
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(PT p,uint f);
 [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m,int t,out uint x,out uint y);
 public static int Dpi(int x,int y){try{PT p=new PT();p.X=x;p.Y=y;uint dx,dy;if(GetDpiForMonitor(MonitorFromPoint(p,2),0,out dx,out dy)==0)return (int)dx;}catch{}return 0;} }
"@
try{[void][DpiShim]::SetProcessDpiAwarenessContext([IntPtr](-4))}catch{}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ X=$_.Bounds.X; Y=$_.Bounds.Y; Width=$_.Bounds.Width; Height=$_.Bounds.Height; Primary=$_.Primary; Dpi=[DpiShim]::Dpi($_.Bounds.X,$_.Bounds.Y) }
} | ConvertTo-Json -Compress
`;

/** How long a monitor layout is reused before it is queried again (#88). The
 * layout changes only when a display is plugged in or rearranged, while an
 * agent's screenshot loop can call this every few seconds. */
export const MONITOR_CACHE_MS = 5_000;

let cache: { at: number; monitors: Promise<Monitor[]> } | null = null;

async function queryMonitors(): Promise<Monitor[]> {
  const stdout = await runPowerShell(PS_SCRIPT, "monitors");
  try {
    return parseMonitors(JSON.parse(stdout));
  } catch (err) {
    throw new ScreencastError(
      `Could not parse monitor geometry: ${errorMessage(err)}`,
    );
  }
}

/** Query live monitor geometry on Windows, reusing a result from the last
 * MONITOR_CACHE_MS. Concurrent callers share one query; a failure is not
 * cached. Throws on non-Windows or failure. */
export function getMonitors(now: number = Date.now()): Promise<Monitor[]> {
  if (process.platform !== "win32") {
    return Promise.reject(
      new ScreencastError("Monitor enumeration is implemented for Windows (gdigrab) only."),
    );
  }
  if (cache && now - cache.at < MONITOR_CACHE_MS) return cache.monitors;
  const entry = { at: now, monitors: queryMonitors() };
  cache = entry;
  entry.monitors.catch(() => {
    if (cache === entry) cache = null;
  });
  return entry.monitors;
}

/** Drop the cached layout (tests, or after a capture failure). */
export function clearMonitorCache(): void {
  cache = null;
}
