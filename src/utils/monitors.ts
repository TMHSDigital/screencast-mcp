/**
 * Monitor geometry discovery.
 *
 * gdigrab has no native "capture monitor N" selector: you capture the whole
 * virtual desktop and crop to a monitor's bounds with -offset_x / -offset_y /
 * -video_size. To do that correctly on a multi-monitor setup (for example a
 * 4480x1440 dual-monitor desktop where the second display starts at x=2560),
 * we need each monitor's pixel bounds. On Windows those come from
 * System.Windows.Forms.Screen.AllScreens via PowerShell.
 *
 * `parseMonitors` is pure so the offset math is unit-tested without Windows.
 */
import { spawnSync } from "node:child_process";
import { ScreencastError } from "./errors.js";

export interface Monitor {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

interface RawScreen {
  X?: number;
  Y?: number;
  Width?: number;
  Height?: number;
  Primary?: boolean;
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
  }));
  screens.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
  return screens.map((s, index) => ({ index, ...s }));
}

const PS_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; " +
  "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
  "[pscustomobject]@{ X=$_.Bounds.X; Y=$_.Bounds.Y; Width=$_.Bounds.Width; " +
  "Height=$_.Bounds.Height; Primary=$_.Primary } } | ConvertTo-Json -Compress";

/** Query live monitor geometry on Windows. Throws on non-Windows or failure. */
export function getMonitors(): Monitor[] {
  if (process.platform !== "win32") {
    throw new ScreencastError(
      "Monitor enumeration is implemented for Windows (gdigrab) only.",
    );
  }
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
    { encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) {
    throw new ScreencastError(
      `Could not enumerate monitors: ${res.stderr || "powershell failed"}`,
    );
  }
  try {
    return parseMonitors(JSON.parse(res.stdout));
  } catch (err) {
    throw new ScreencastError(
      `Could not parse monitor geometry: ${(err as Error).message}`,
    );
  }
}
