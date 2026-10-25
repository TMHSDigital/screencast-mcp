/**
 * Window-to-rectangle resolution for the `window:<title>` capture target.
 *
 * gdigrab's own `title=` input grabs the window's GDI surface, which comes back
 * blank/black for GPU- or DirectComposition-composited windows (Chrome,
 * Electron editors, UWP apps) - i.e. most modern software. Instead we resolve
 * the window to the on-screen rectangle it currently occupies and capture that
 * rectangle through the same desktop (monitor/region) path that is known to
 * work. This captures the window "as displayed": it must be visible, on top,
 * and not minimized.
 *
 * Enumeration (getRawWindows) is impure (PowerShell + user32 P/Invoke, DPI
 * aware). The matching, clamping, and even-dimension math (selectWindow) is
 * pure so it is unit-tested without Windows.
 */
import { ScreencastError } from "./errors.js";
import { runPowerShell } from "./monitors.js";

export interface RawWindow {
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  minimized: boolean;
  /** The window handle, for capturing the window itself (WGC backend, #113). */
  hwnd?: number;
}

export interface WindowQuery {
  /** Virtual desktop bounds, used to clamp an over-sized/off-screen window. */
  virtual: { x: number; y: number; w: number; h: number };
  /** Visible top-level windows with a non-empty title, in Z-order (top first). */
  windows: RawWindow[];
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The exact title of the window that was matched. */
  matchedTitle: string;
  /** How many windows matched the requested title (>1 => topmost was chosen). */
  matchCount: number;
  /** Whether the title matched exactly or only as a substring (#89). */
  matchKind: "exact" | "substring";
  /** Titles of every matching window, topmost first (at most MAX_CANDIDATES). */
  candidates: string[];
  /** The matched window handle, when enumeration provided one. */
  hwnd?: number;
}

export interface SelectWindowOptions {
  /** Refuse the substring fallback: only a case-insensitive exact title matches. */
  exactOnly?: boolean;
}

/** How many candidate titles a match reports. */
export const MAX_CANDIDATES = 5;

/**
 * Choose a window by title and reduce it to a clamped, even-sized rectangle.
 *
 * Matching: a case-insensitive EXACT title match wins; if none, a
 * case-insensitive SUBSTRING match is used (unless exactOnly). With several
 * matches the topmost (first in Z-order) is chosen. Pure: takes the enumerated
 * query, returns the rectangle or throws a ScreencastError the caller can
 * surface verbatim.
 */
export function selectWindow(
  query: WindowQuery,
  wanted: string,
  opts: SelectWindowOptions = {},
): WindowBounds {
  const all = Array.isArray(query.windows) ? query.windows : [];
  const needle = wanted.trim().toLowerCase();
  const exact = all.filter((w) => w.title.toLowerCase() === needle);
  const substring = all.filter((w) => w.title.toLowerCase().includes(needle));
  const quote = (ws: RawWindow[]) => ws.slice(0, MAX_CANDIDATES).map((w) => `"${w.title}"`).join(", ");

  if (exact.length === 0 && opts.exactOnly) {
    throw new ScreencastError(
      `No visible window titled exactly "${wanted}" (exactTitle is on).` +
        (substring.length > 0 ? ` Windows containing it: ${quote(substring)}.` : ""),
    );
  }
  const matchKind = exact.length > 0 ? "exact" : "substring";
  const matches = exact.length > 0 ? exact : substring;

  if (matches.length === 0) {
    throw new ScreencastError(
      `No visible window matching title "${wanted}". Open the window (it must ` +
        `be on screen and not minimized), or use an exact/substring of its title.`,
    );
  }
  const chosen = matches[0]; // EnumWindows Z-order: index 0 is the topmost.
  if (chosen.minimized) {
    throw new ScreencastError(
      `Window "${chosen.title}" is minimized. Restore it before capturing - ` +
        `window capture grabs whatever is on screen at the window's rectangle.`,
    );
  }

  const v = query.virtual;
  const x = Math.max(chosen.left, v.x);
  const y = Math.max(chosen.top, v.y);
  const right = Math.min(chosen.right, v.x + v.w);
  const bottom = Math.min(chosen.bottom, v.y + v.h);
  let width = right - x;
  let height = bottom - y;
  if (width <= 0 || height <= 0) {
    throw new ScreencastError(
      `Window "${chosen.title}" has no visible on-screen area to capture ` +
        `(off-screen or fully occluded by the desktop edge).`,
    );
  }
  // libx264 + yuv420p requires even dimensions; gdigrab region must match.
  width -= width % 2;
  height -= height % 2;
  if (width <= 0 || height <= 0) {
    throw new ScreencastError(`Window "${chosen.title}" is too small to capture.`);
  }
  return {
    x, y, width, height,
    matchedTitle: chosen.title,
    ...(chosen.hwnd !== undefined ? { hwnd: chosen.hwnd } : {}),
    matchCount: matches.length,
    matchKind,
    candidates: matches.slice(0, MAX_CANDIDATES).map((w) => w.title),
  };
}

/** The window-match fields a capture tool returns, with a warning when the
 * match was ambiguous or only a substring, so an agent notices before it
 * records the wrong window (#89). Pure. */
export function windowMatchReport(w: WindowBounds): Record<string, unknown> {
  const reasons: string[] = [];
  if (w.matchKind === "substring") reasons.push("the title matched only as a substring");
  if (w.matchCount > 1) reasons.push(`${w.matchCount} windows matched and the topmost was used`);
  return {
    matchedWindow: w.matchedTitle,
    matchCount: w.matchCount,
    matchKind: w.matchKind,
    region: { x: w.x, y: w.y, width: w.width, height: w.height },
    ...(reasons.length > 0
      ? {
          windowWarning:
            `Check this is the intended window: ${reasons.join(", and ")}. ` +
            `Candidates: ${w.candidates.map((t) => `"${t}"`).join(", ")}. ` +
            "Pass the full title with exactTitle: true to match only that window.",
        }
      : {}),
  };
}

// Per-monitor-DPI-aware enumeration of top-level windows + virtual screen
// bounds. Runs as a single PowerShell process; passed base64 (EncodedCommand)
// so no quoting of the C# shim is needed. Kept verbatim-small for startup cost.
// Bounds come from DWMWA_EXTENDED_FRAME_BOUNDS (9), the visible frame:
// GetWindowRect includes the invisible resize border (about 8 px on Windows
// 10/11), so a window: capture also grabbed a strip of whatever was behind it.
const PS_ENUM = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class WinShim{
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc f,IntPtr l);
 public delegate bool EnumWindowsProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
 [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
 public struct RECT{public int Left,Top,Right,Bottom;}
 static List<IntPtr> _h;
 static bool Col(IntPtr h,IntPtr l){_h.Add(h);return true;}
 public static IntPtr[] Z(){_h=new List<IntPtr>();EnumWindows(Col,IntPtr.Zero);return _h.ToArray();}
 public static string T(IntPtr h){int n=GetWindowTextLength(h);if(n==0)return "";var s=new StringBuilder(n+1);GetWindowText(h,s,s.Capacity);return s.ToString();}
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,int a,out RECT r,int n);
 public static int[] R(IntPtr h){RECT r;if(DwmGetWindowAttribute(h,9,out r,Marshal.SizeOf(typeof(RECT)))!=0){GetWindowRect(h,out r);}return new int[]{r.Left,r.Top,r.Right,r.Bottom};}
 public static bool Ic(IntPtr h){return IsIconic(h);}
 public static bool Vis(IntPtr h){return IsWindowVisible(h);}
 public static int SM(int i){return GetSystemMetrics(i);}
}
"@
try{[void][WinShim]::SetProcessDpiAwarenessContext([IntPtr](-4))}catch{}
$ws=New-Object System.Collections.ArrayList
foreach($h in [WinShim]::Z()){
 if(-not [WinShim]::Vis($h)){continue}
 $t=[WinShim]::T($h)
 if([string]::IsNullOrEmpty($t)){continue}
 $r=[WinShim]::R($h)
 [void]$ws.Add([pscustomobject]@{title=$t;left=$r[0];top=$r[1];right=$r[2];bottom=$r[3];minimized=[bool][WinShim]::Ic($h);hwnd=[int64]$h})
}
$v=[pscustomobject]@{x=[WinShim]::SM(76);y=[WinShim]::SM(77);w=[WinShim]::SM(78);h=[WinShim]::SM(79)}
[pscustomobject]@{virtual=$v;windows=@($ws)}|ConvertTo-Json -Compress -Depth 4
`;

/** Enumerate live windows on Windows. Throws on non-Windows or failure. */
export async function getRawWindows(): Promise<WindowQuery> {
  if (process.platform !== "win32") {
    throw new ScreencastError("Window capture is implemented for Windows (gdigrab) only.");
  }
  // Not cached: windows move and restack between calls, unlike monitors.
  const stdout = await runPowerShell(PS_ENUM, "windows");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new ScreencastError(`Could not parse window geometry: ${(err as Error).message}`);
  }
  const obj = parsed as { virtual?: WindowQuery["virtual"]; windows?: RawWindow | RawWindow[] };
  const windows = Array.isArray(obj.windows) ? obj.windows : obj.windows ? [obj.windows] : [];
  const v = obj.virtual ?? { x: 0, y: 0, w: 0, h: 0 };
  return { virtual: v, windows };
}

/** Resolve a window title to its current on-screen rectangle (Windows). */
export async function resolveWindowBounds(
  title: string,
  opts: SelectWindowOptions = {},
): Promise<WindowBounds> {
  return selectWindow(await getRawWindows(), title, opts);
}
