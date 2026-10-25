/**
 * Input event log for recordings (#118): mouse clicks, scroll, and sampled
 * cursor positions, plus key presses, on the video's clock and in video pixels.
 *
 * A small helper (C# low-level mouse/keyboard hooks, compiled by PowerShell)
 * runs for the life of one recording and appends raw lines to
 * `<recording>.events.raw`:
 *
 *   <epoch ms>,<type>,<x>,<y>,<data>
 *
 * When ffmpeg exits the raw file is converted to `<recording>.events.jsonl`:
 * times become seconds from the first video frame (gdigrab reports that frame's
 * wall-clock time as `start:`), and coordinates are shifted by the capture
 * origin so they are video pixels.
 *
 * Keys are never logged as text. "masked" (default) records that a key went
 * down and nothing about which. "shortcuts" also names chords made with Ctrl,
 * Alt, or Win (Ctrl+S, Alt+Tab), which is what a keystroke overlay shows;
 * plain typing, Shift+letter, and AltGr characters stay masked. There is no
 * mode that records typed text: that would be a system-wide keylogger.
 *
 * Everything but `startEventLogger` is pure so it is unit-tested anywhere.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { ScreencastError } from "./errors.js";

export type KeyMode = "masked" | "shortcuts";
export const DEFAULT_KEY_MODE: KeyMode = "masked";
export const EVENT_TYPES = ["down", "up", "move", "wheel", "key"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Cursor positions are sampled at most this often while the mouse moves. */
export const MOVE_SAMPLE_MS = 33;

export interface InputEvent {
  /** Seconds from the first video frame. */
  t: number;
  type: EventType;
  /** Cursor position in video pixels (may fall outside the frame). */
  x: number;
  y: number;
  /** False when the cursor was outside the recorded area. */
  inFrame: boolean;
  /** down / up: left | right | middle | x1 | x2. */
  button?: string;
  /** wheel: notches, positive = away from the user / right. */
  delta?: number;
  /** wheel: vertical or horizontal. */
  axis?: "vertical" | "horizontal";
  /** key: the chord in shortcuts mode (e.g. "Ctrl+S"); absent when masked. */
  keys?: string;
}

export interface CaptureFrame {
  /** Desktop position of the video's top-left pixel. */
  x: number;
  y: number;
  /** Video size in pixels. */
  w: number;
  h: number;
}

/** The first input's start time in epoch ms from ffmpeg's stderr banner, or
 * null if it has not been printed. gdigrab stamps frames with wall-clock time,
 * so `start: 1792936190.232363` is when the first frame was grabbed. */
export function parseCaptureStart(stderr: string): number | null {
  const input = stderr.indexOf("Input #0");
  if (input < 0) return null;
  const m = /start: (\d{9,}\.\d+)/.exec(stderr.slice(input));
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/**
 * Convert raw helper lines to events. Lines that do not parse are skipped (the
 * last one can be cut short when the helper is killed). Events before the first
 * frame or after `endSec` are dropped.
 */
export function convertEvents(
  raw: string,
  opts: { startMs: number; frame: CaptureFrame; endSec?: number },
): InputEvent[] {
  const out: InputEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const [ms, type, xs, ys, data = ""] = parts;
    const epoch = Number(ms);
    const dx = Number(xs);
    const dy = Number(ys);
    if (!Number.isFinite(epoch) || !Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    if (!(EVENT_TYPES as readonly string[]).includes(type)) continue;
    const t = Math.round(epoch - opts.startMs) / 1000;
    if (t < 0 || (opts.endSec !== undefined && t > opts.endSec)) continue;
    const x = dx - opts.frame.x;
    const y = dy - opts.frame.y;
    const ev: InputEvent = {
      t,
      type: type as EventType,
      x,
      y,
      inFrame: x >= 0 && y >= 0 && x < opts.frame.w && y < opts.frame.h,
    };
    if (type === "down" || type === "up") ev.button = data || "left";
    if (type === "wheel") {
      const [axis, notches] = data.split(":");
      ev.axis = axis === "h" ? "horizontal" : "vertical";
      ev.delta = Number(notches) || 0;
    }
    if (type === "key" && data) ev.keys = data;
    out.push(ev);
  }
  return out.sort((a, b) => a.t - b.t);
}

export function formatEventsJsonl(events: InputEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

export function parseEventsJsonl(text: string): InputEvent[] {
  const out: InputEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as InputEvent);
    } catch {
      // A torn line: skip it rather than fail the whole read.
    }
  }
  return out;
}

export interface EventQuery {
  from?: number;
  to?: number;
  types?: EventType[];
  /** Only events whose cursor was inside the recorded area. */
  inFrameOnly?: boolean;
}

export function selectEvents(events: InputEvent[], q: EventQuery): InputEvent[] {
  return events.filter(
    (e) =>
      (q.from === undefined || e.t >= q.from) &&
      (q.to === undefined || e.t <= q.to) &&
      (!q.types || q.types.includes(e.type)) &&
      (!q.inFrameOnly || e.inFrame),
  );
}

/** Counts per type, for a one-line summary. */
export function summarizeEvents(events: InputEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    const key = e.type === "down" ? "clicks" : e.type === "move" ? "moves" : e.type === "key" ? "keys" : e.type === "wheel" ? "scrolls" : null;
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// The hook helper. __PATH__ is the raw output file (base64 UTF-8), __MODE__ is
// 1 for shortcuts, __PARENT__ the server pid: the helper exits on its own if
// the server dies, so a crash cannot leave a hook running.
const PS_HOOK = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type @"
#pragma warning disable 649
using System;using System.IO;using System.Text;using System.Threading;using System.Diagnostics;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class ScEvents{
 delegate IntPtr Proc(int n,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id,Proc p,IntPtr mod,uint tid);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h,int n,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern int GetMessage(out MSG m,IntPtr h,uint a,uint b);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
 [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
 [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long t);
 struct MSG{public IntPtr h;public uint m;public IntPtr w;public IntPtr l;public uint t;public int x;public int y;}
 struct MS{public int x;public int y;public uint data;public uint flags;public uint time;public IntPtr extra;}
 struct KB{public uint vk;public uint scan;public uint flags;public uint time;public IntPtr extra;}
 static Proc mp,kp;static StreamWriter w;static bool sc;static double lastMove;static int cx,cy;
 static HashSet<uint> held=new HashSet<uint>();
 static double Now(){long t;GetSystemTimePreciseAsFileTime(out t);return (t-116444736000000000L)/10000.0;}
 static void Put(string type,int x,int y,string data){lock(w){w.WriteLine(Now().ToString("F1",System.Globalization.CultureInfo.InvariantCulture)+","+type+","+x+","+y+","+data);}}
 static bool Down(int vk){return (GetAsyncKeyState(vk)&0x8000)!=0;}
 static IntPtr Mouse(int n,IntPtr wp,IntPtr lp){
  if(n>=0){MS s=(MS)Marshal.PtrToStructure(lp,typeof(MS));int m=(int)wp;cx=s.x;cy=s.y;
   if(m==0x200){double t=Now();if(t-lastMove>=${MOVE_SAMPLE_MS}){lastMove=t;Put("move",s.x,s.y,"");}}
   else if(m==0x201)Put("down",s.x,s.y,"left");else if(m==0x202)Put("up",s.x,s.y,"left");
   else if(m==0x204)Put("down",s.x,s.y,"right");else if(m==0x205)Put("up",s.x,s.y,"right");
   else if(m==0x207)Put("down",s.x,s.y,"middle");else if(m==0x208)Put("up",s.x,s.y,"middle");
   else if(m==0x20B||m==0x20C){string b=((s.data>>16)==1)?"x1":"x2";Put(m==0x20B?"down":"up",s.x,s.y,b);}
   else if(m==0x20A||m==0x20E){short d=(short)(s.data>>16);Put("wheel",s.x,s.y,(m==0x20E?"h:":"v:")+(d/120.0).ToString(System.Globalization.CultureInfo.InvariantCulture));}}
  return CallNextHookEx(IntPtr.Zero,n,wp,lp);}
 static string Name(uint vk){
  if(vk>=0x41&&vk<=0x5A)return ((char)vk).ToString();if(vk>=0x30&&vk<=0x39)return ((char)vk).ToString();
  if(vk>=0x70&&vk<=0x87)return "F"+(vk-0x6F);
  switch(vk){case 0x0D:return "Enter";case 0x09:return "Tab";case 0x1B:return "Esc";case 0x20:return "Space";case 0x08:return "Backspace";case 0x2E:return "Delete";case 0x2D:return "Insert";
   case 0x25:return "Left";case 0x26:return "Up";case 0x27:return "Right";case 0x28:return "Down";case 0x24:return "Home";case 0x23:return "End";case 0x21:return "PageUp";case 0x22:return "PageDown";
   case 0xBB:return "=";case 0xBD:return "-";case 0xBC:return ",";case 0xBE:return ".";case 0xBF:return "/";case 0xC0:return "\`";case 0xDB:return "[";case 0xDD:return "]";case 0xBA:return ";";case 0xDE:return "'";case 0xDC:return "\\\\";}
  return null;}
 static bool IsMod(uint vk){return vk==0x10||vk==0x11||vk==0x12||(vk>=0xA0&&vk<=0xA5)||vk==0x5B||vk==0x5C;}
 static IntPtr Key(int n,IntPtr wp,IntPtr lp){
  if(n>=0){KB k=(KB)Marshal.PtrToStructure(lp,typeof(KB));int m=(int)wp;
   if(m==0x101||m==0x105){held.Remove(k.vk);}
   else if((m==0x100||m==0x104)&&!IsMod(k.vk)&&held.Add(k.vk)){
    string chord="";
    if(sc&&!Down(0xA5)){bool ctl=Down(0x11),alt=Down(0x12),win=Down(0x5B)||Down(0x5C);string nm=Name(k.vk);
     if((ctl||alt||win)&&nm!=null){chord=(ctl?"Ctrl+":"")+(alt?"Alt+":"")+(Down(0x10)?"Shift+":"")+(win?"Win+":"")+nm;}}
    Put("key",cx,cy,chord);}}
  return CallNextHookEx(IntPtr.Zero,n,wp,lp);}
 public static void Run(string path,bool shortcuts,int parent){
  try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{}
  sc=shortcuts;w=new StreamWriter(path,true,new UTF8Encoding(false));w.AutoFlush=true;
  IntPtr mod=GetModuleHandle(null);mp=Mouse;kp=Key;
  if(SetWindowsHookEx(14,mp,mod,0)==IntPtr.Zero||SetWindowsHookEx(13,kp,mod,0)==IntPtr.Zero)throw new Exception("SetWindowsHookEx failed: "+Marshal.GetLastWin32Error());
  var watch=new Thread(()=>{while(true){Thread.Sleep(500);try{if(Process.GetProcessById(parent).HasExited)Environment.Exit(0);}catch{Environment.Exit(0);}}});
  watch.IsBackground=true;watch.Start();
  Console.Out.WriteLine("ready");Console.Out.Flush();
  MSG msg;while(GetMessage(out msg,IntPtr.Zero,0,0)>0){}
 }
}
"@
[ScEvents]::Run([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATH__')), [bool]__MODE__, __PARENT__)
`;

export function buildHookScript(rawPath: string, mode: KeyMode, parentPid: number): string {
  return PS_HOOK.replace("__PATH__", Buffer.from(rawPath, "utf8").toString("base64"))
    .replace("__MODE__", mode === "shortcuts" ? "1" : "0")
    .replace("__PARENT__", String(parentPid));
}

/** PowerShell reports errors on a redirected stderr as CLIXML; keep the text. */
export function cleanPsError(stderr: string): string {
  if (!stderr.startsWith("#< CLIXML")) return stderr.trim();
  const parts = [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((m) => m[1]);
  return parts
    .join("")
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .trim();
}

/** How long the helper gets to compile its hooks and report ready. */
export const LOGGER_READY_TIMEOUT_MS = 20_000;

/** Start the hook helper and resolve once its hooks are installed. */
export async function startEventLogger(rawPath: string, mode: KeyMode): Promise<ChildProcess> {
  if (process.platform !== "win32") {
    throw new ScreencastError("The input event log is implemented for Windows only.");
  }
  const encoded = Buffer.from(buildHookScript(rawPath, mode, process.pid), "utf16le").toString("base64");
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new ScreencastError(`Could not start the input event log: ${why}`));
    };
    const timer = setTimeout(() => fail(`no response in ${LOGGER_READY_TIMEOUT_MS / 1000}s`), LOGGER_READY_TIMEOUT_MS);
    child.stdout?.on("data", (d) => {
      if (!settled && d.toString().includes("ready")) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (err) => fail(err.message));
    child.on("exit", (code) => fail(cleanPsError(stderr) || `helper exited with code ${code}`));
  });
  return child;
}

/** Stop the helper and wait for it to exit, so the raw file is complete. */
export function stopEventLogger(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(done);
      resolve();
    });
    child.kill();
  });
}

/** Sibling paths for a recording's raw and converted event logs. */
export function eventPaths(recording: string): { raw: string; jsonl: string } {
  const base = recording.replace(/\.[^./\\]+$/, "");
  return { raw: `${base}.events.raw`, jsonl: `${base}.events.jsonl` };
}

/** Convert the raw helper output to the recording's events.jsonl and remove
 * the raw file. Returns how many events were kept. */
export function writeEventsFile(
  paths: { raw: string; jsonl: string },
  opts: { startMs: number; frame: CaptureFrame; endSec?: number },
): InputEvent[] {
  const raw = existsSync(paths.raw) ? readFileSync(paths.raw, "utf8") : "";
  const events = convertEvents(raw, opts);
  writeFileSync(paths.jsonl, formatEventsJsonl(events));
  try {
    unlinkSync(paths.raw);
  } catch {
    // Left behind if locked; harmless and gitignored.
  }
  return events;
}

// Event logs finish converting after ffmpeg exits. stopSession waits on this
// so stop_recording reports the finished log instead of racing it.
const finalizers = new Map<string, Promise<void>>();

export function trackFinalizer(sessionId: string, done: Promise<void>): void {
  finalizers.set(sessionId, done);
  void done.finally(() => {
    if (finalizers.get(sessionId) === done) finalizers.delete(sessionId);
  });
}

export async function whenFinalized(sessionId: string, timeoutMs = 10_000): Promise<void> {
  const done = finalizers.get(sessionId);
  if (!done) return;
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
}
