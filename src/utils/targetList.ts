/**
 * The capture-target catalogue behind list_targets (#213): every monitor and
 * visible top-level window, each with a ready-to-use `target` string in the
 * exact syntax screenshot / start_recording accept, so an agent picks a target
 * instead of guessing a window title.
 *
 * Pure: takes the enumerated monitors and windows. Whether a window can be
 * captured is decided by running the same selectWindow the capture tools use on
 * the returned target, so a target reported capturable resolves to that window.
 */
import type { Monitor } from "./monitors.js";
import { virtualDesktopBounds } from "./targets.js";
import { parseWindowSelector, selectWindow, type RawWindow, type WindowQuery } from "./windows.js";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorEntry {
  target: string;
  index: number;
  primary: boolean;
  bounds: Bounds;
  /** Effective DPI (96 = 100%), null when Windows did not report it. */
  dpi: number | null;
  /** Display scaling factor (dpi / 96), e.g. 1.5 for 150%. */
  scale: number | null;
}

export interface WindowEntry {
  target: string;
  title: string;
  exe: string | null;
  pid: number | null;
  hwnd: number | null;
  /** The window's visible frame on the desktop, in physical pixels. */
  bounds: Bounds;
  minimized: boolean;
  cloaked: boolean;
  /** The default (gdigrab) backend can capture it. */
  capturable: boolean;
  /** backend: "wgc" can capture it (needs FFmpeg 8's gfxcapture). */
  wgcCapturable: boolean;
  /** Why it cannot be captured with the default backend. */
  reason?: string;
}

export interface TargetFilter {
  /** Only windows of this executable ("Code.exe" or "code"). */
  exe?: string;
  /** Only windows whose title contains this (case-insensitive). */
  titleContains?: string;
  /** Leave out windows neither backend can capture. */
  capturableOnly?: boolean;
}

export interface TargetList {
  full: { target: "full"; bounds: Bounds };
  monitors: MonitorEntry[];
  windows: WindowEntry[];
  wgcAvailable: boolean;
}

function windowTarget(w: RawWindow): string {
  return w.hwnd !== undefined ? `window:hwnd=${w.hwnd}` : `window:${w.title}`;
}

/** The first sentence of a capture error, as a short reason. */
function firstSentence(message: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(message);
  return m ? m[0] : message;
}

/** Can `target` be resolved to the window `w` with these options? */
function resolves(query: WindowQuery, w: RawWindow, allowCloaked: boolean): { ok: boolean; reason?: string } {
  try {
    selectWindow(query, windowTarget(w).slice("window:".length), { allowCloaked, exactOnly: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: firstSentence((err as Error).message) };
  }
}

/** Build the catalogue. Windows stay in Z-order (topmost first). Pure. */
export function buildTargetList(
  monitors: Monitor[],
  query: WindowQuery,
  opts: { wgcAvailable: boolean; filter?: TargetFilter },
): TargetList {
  const filter = opts.filter ?? {};
  const exe = filter.exe ? parseWindowSelector(`exe=${filter.exe}`) : null;
  const wantedExe = exe?.kind === "exe" ? exe.exe : null;
  const needle = filter.titleContains?.trim().toLowerCase() || null;

  const v = virtualDesktopBounds(monitors);
  const desktop = monitors.length > 0 ? v : query.virtual;

  const windows: WindowEntry[] = [];
  for (const w of Array.isArray(query.windows) ? query.windows : []) {
    if (wantedExe !== null && (w.exe ?? "").toLowerCase().replace(/\.exe$/, "") !== wantedExe) continue;
    if (needle !== null && !w.title.toLowerCase().includes(needle)) continue;
    const gdi = resolves(query, w, false);
    const wgc = opts.wgcAvailable && w.hwnd !== undefined ? resolves(query, w, true) : { ok: false };
    if (filter.capturableOnly && !gdi.ok && !wgc.ok) continue;
    windows.push({
      target: windowTarget(w),
      title: w.title,
      exe: w.exe || null,
      pid: typeof w.pid === "number" ? w.pid : null,
      hwnd: w.hwnd ?? null,
      bounds: { x: w.left, y: w.top, width: w.right - w.left, height: w.bottom - w.top },
      minimized: Boolean(w.minimized),
      cloaked: Boolean(w.cloaked),
      capturable: gdi.ok,
      wgcCapturable: wgc.ok,
      ...(gdi.ok ? {} : { reason: gdi.reason }),
    });
  }

  return {
    full: { target: "full", bounds: { x: desktop.x, y: desktop.y, width: desktop.w, height: desktop.h } },
    monitors: monitors.map((m) => ({
      target: `monitor:${m.index}`,
      index: m.index,
      primary: m.primary,
      bounds: { x: m.x, y: m.y, width: m.width, height: m.height },
      dpi: m.dpi ?? null,
      scale: m.dpi ? Math.round((m.dpi / 96) * 100) / 100 : null,
    })),
    windows,
    wgcAvailable: opts.wgcAvailable,
  };
}
