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
 * Keys are never logged as text, and typed keys are not logged one by one
 * (#210): typing becomes `typing` bursts (start and length on a 0.5 s grid),
 * because per-key timing alone leaks password lengths and can partly
 * reconstruct text. "shortcuts" also names chords made with Ctrl, Alt, or Win
 * (Ctrl+S, Alt+Tab) as timed `key` events, which is what a keystroke overlay
 * shows; plain typing, Shift+letter, and AltGr characters (including
 * Ctrl+Alt+key on AltGr layouts) stay bursts. There is no mode that records
 * typed text: that would be a system-wide keylogger.
 *
 * The helper also writes a heartbeat every second and notes when Windows saw
 * input its hooks did not. Those become `gap` events, so a log that stopped
 * early says so instead of looking complete.
 *
 * Everything but `startEventLogger` is pure so it is unit-tested anywhere.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { ScreencastError } from "./errors.js";

export type KeyMode = "masked" | "shortcuts";
export const DEFAULT_KEY_MODE: KeyMode = "masked";
export const EVENT_TYPES = ["down", "up", "move", "wheel", "key", "typing", "gap"] as const;
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
  /** key: the chord, in shortcuts mode (e.g. "Ctrl+S"). */
  keys?: string;
  /** typing: how long the burst lasted; gap: how long input may be missing. */
  durationSec?: number;
  /** gap: why events may be missing. */
  reason?: GapReason;
}

/** input_not_seen: Windows saw input the hooks did not (hook removed, or input
 * to an elevated window or the secure desktop). helper_stalled / helper_stopped:
 * the helper's heartbeat paused or ended before the recording did. */
export type GapReason = "input_not_seen" | "helper_stalled" | "helper_stopped";

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
  const beats: number[] = [];
  let missFrom: { t: number; x: number; y: number } | null = null;
  const gap = (t: number, x: number, y: number, untilSec: number, reason: GapReason) => {
    const from = Math.max(0, t);
    const until = opts.endSec !== undefined ? Math.min(untilSec, opts.endSec) : untilSec;
    if (until > from) out.push({ t: r3(from), type: "gap", x, y, inFrame: false, durationSec: r3(until - from), reason });
  };
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const [ms, type, xs, ys, data = ""] = parts;
    const epoch = Number(ms);
    const dx = Number(xs);
    const dy = Number(ys);
    if (!Number.isFinite(epoch) || !Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const t = Math.round(epoch - opts.startMs) / 1000;
    if (type === "hb") {
      beats.push(t);
      continue;
    }
    if (type === "miss") {
      missFrom ??= { t, x: dx - opts.frame.x, y: dy - opts.frame.y };
      continue;
    }
    if (type === "resume") {
      if (missFrom) gap(missFrom.t, missFrom.x, missFrom.y, t, "input_not_seen");
      missFrom = null;
      continue;
    }
    if (type === "gap" || !(EVENT_TYPES as readonly string[]).includes(type)) continue;
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
    if (type === "typing") ev.durationSec = r3((Number(data) || 0) / 1000);
    out.push(ev);
  }
  const lastSec = opts.endSec ?? Math.max(0, ...out.map((e) => e.t), ...beats);
  if (missFrom) gap(missFrom.t, missFrom.x, missFrom.y, lastSec, "input_not_seen");
  // Heartbeats only exist in logs from helpers that write them.
  if (beats.length > 0) {
    beats.sort((a, b) => a - b);
    for (let i = 1; i < beats.length; i++) {
      if (beats[i] - beats[i - 1] > HEARTBEAT_GAP_SEC) gap(beats[i - 1], 0, 0, beats[i], "helper_stalled");
    }
    const last = beats[beats.length - 1];
    if (opts.endSec !== undefined && opts.endSec - last > HEARTBEAT_GAP_SEC) gap(last, 0, 0, opts.endSec, "helper_stopped");
  }
  return out.sort((a, b) => a.t - b.t);
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The gaps in a log, for a summary: where events may be missing. */
export function eventGaps(events: InputEvent[]): Array<{ t: number; durationSec: number; reason: GapReason }> {
  return events
    .filter((e) => e.type === "gap")
    .map((e) => ({ t: e.t, durationSec: e.durationSec ?? 0, reason: e.reason ?? "input_not_seen" }));
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
    const key =
      e.type === "down" ? "clicks"
      : e.type === "move" ? "moves"
      : e.type === "key" ? "shortcuts"
      : e.type === "typing" ? "typingBursts"
      : e.type === "wheel" ? "scrolls"
      : e.type === "gap" ? "gaps"
      : null;
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Typing is logged as bursts on this grid (ms), never as single keys (#210). */
export const TYPING_GRAIN_MS = 500;
/** A pause this long (ms) ends a typing burst. */
export const TYPING_GAP_MS = 1000;
/** The helper reports missed input when Windows saw input this long (ms)
 * after the hooks last ran: the hook was removed, or the input went to an
 * elevated window or the secure desktop. */
export const MISSED_INPUT_MS = 2000;
/** Helper heartbeats arrive every second; a gap longer than this (s) means
 * the helper stalled or stopped. */
export const HEARTBEAT_GAP_SEC = 3;

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
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII i);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint t);
 [DllImport("user32.dll")] static extern int ToUnicodeEx(uint vk,uint scan,byte[] ks,[Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder b,int n,uint f,IntPtr hkl);
 struct LII{public uint cb;public uint t;}
 static Proc mp,kp;static StreamWriter w;static bool sc;static double lastMove;static int cx,cy;
 static HashSet<uint> held=new HashSet<uint>();
 static readonly object q=new object();static StringBuilder buf=new StringBuilder();
 static double typeStart=-1,typeLast;static int lastHook=Environment.TickCount;static bool missing;
 static readonly IFormatProvider Inv=System.Globalization.CultureInfo.InvariantCulture;
 static double Now(){long t;GetSystemTimePreciseAsFileTime(out t);return (t-116444736000000000L)/10000.0;}
 // The hooks only append to a buffer; the pump thread writes it. Slow file
 // I/O inside a hook makes Windows drop the hook without notice (#210).
 static void Line(double t,string type,int x,int y,string data){lock(q){buf.Append(t.ToString("F1",Inv)).Append(',').Append(type).Append(',').Append(x).Append(',').Append(y).Append(',').Append(data).Append('\\n');}}
 static void Put(string type,int x,int y,string data){Line(Now(),type,x,y,data);}
 static bool Down(int vk){return (GetAsyncKeyState(vk)&0x8000)!=0;}
 static void Seen(){lastHook=Environment.TickCount;if(missing){missing=false;Put("resume",cx,cy,"");}}
 // Typed keys become bursts on a ${TYPING_GRAIN_MS} ms grid, so the log holds no per-key timing.
 static void Typed(){double t=Now();lock(q){if(typeStart<0)typeStart=t;typeLast=t;}}
 static void EndTyping(bool force){double s,e;lock(q){if(typeStart<0||(!force&&Now()-typeLast<${TYPING_GAP_MS}))return;s=typeStart;e=typeLast;typeStart=-1;}
  double g=${TYPING_GRAIN_MS};double s2=Math.Floor(s/g)*g,e2=Math.Max(s2+g,Math.Ceiling(e/g)*g);Line(s2,"typing",cx,cy,(e2-s2).ToString("F0",Inv));}
 static void Drain(){lock(w){string s;lock(q){s=buf.ToString();buf.Clear();}if(s.Length>0){w.Write(s);w.Flush();}}}
 static void Quit(){EndTyping(true);Drain();w.Close();Process.GetCurrentProcess().Kill();}
 static void Pump(string stop){int tick=0;while(true){Thread.Sleep(250);tick++;
  EndTyping(false);
  lock(held){foreach(uint vk in new List<uint>(held)){if(!Down((int)vk))held.Remove(vk);}}
  LII li=new LII();li.cb=8;if(!missing&&GetLastInputInfo(ref li)&&unchecked((int)li.t-lastHook)>${MISSED_INPUT_MS}){missing=true;Put("miss",cx,cy,"");}
  if(tick%4==0)Put("hb",0,0,"");
  if(File.Exists(stop))Quit();
  Drain();}}
 static IntPtr Mouse(int n,IntPtr wp,IntPtr lp){
  if(n>=0){Seen();MS s=(MS)Marshal.PtrToStructure(lp,typeof(MS));int m=(int)wp;cx=s.x;cy=s.y;
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
 // Ctrl+Alt+key types a character on AltGr layouts (Polish, German...): that is text, not a chord.
 static bool Types(KB k,bool shift){var ks=new byte[256];ks[0x11]=ks[0xA2]=ks[0x12]=ks[0xA4]=0x80;if(shift)ks[0x10]=ks[0xA0]=0x80;
  var b=new StringBuilder(8);int r=ToUnicodeEx(k.vk,k.scan,ks,b,8,4,GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero)));
  return r<0||(r>0&&b.Length>0&&!char.IsControl(b[0]));}
 static IntPtr Key(int n,IntPtr wp,IntPtr lp){
  if(n>=0){Seen();KB k=(KB)Marshal.PtrToStructure(lp,typeof(KB));int m=(int)wp;bool fresh;
   if(m==0x101||m==0x105){lock(held){held.Remove(k.vk);}}
   else if(m==0x100||m==0x104){lock(held){fresh=!IsMod(k.vk)&&held.Add(k.vk);}
    if(fresh){string chord="";
     if(sc&&!Down(0xA5)){bool ctl=Down(0x11),alt=Down(0x12),win=Down(0x5B)||Down(0x5C),sh=Down(0x10);string nm=Name(k.vk);
      if((ctl||alt||win)&&nm!=null&&!(ctl&&alt&&!win&&Types(k,sh))){chord=(ctl?"Ctrl+":"")+(alt?"Alt+":"")+(sh?"Shift+":"")+(win?"Win+":"")+nm;}}
     if(chord.Length>0)Put("key",cx,cy,chord);else Typed();}}}
  return CallNextHookEx(IntPtr.Zero,n,wp,lp);}
 public static void Run(string path,bool shortcuts,int parent){
  try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{}
  sc=shortcuts;w=new StreamWriter(path,true,new UTF8Encoding(false));
  IntPtr mod=GetModuleHandle(null);mp=Mouse;kp=Key;
  if(SetWindowsHookEx(14,mp,mod,0)==IntPtr.Zero||SetWindowsHookEx(13,kp,mod,0)==IntPtr.Zero)throw new Exception("SetWindowsHookEx failed: "+Marshal.GetLastWin32Error());
  var watch=new Thread(()=>{while(true){Thread.Sleep(500);bool gone;try{gone=Process.GetProcessById(parent).HasExited;}catch{gone=true;}if(gone)Quit();}});
  watch.IsBackground=true;watch.Start();
  var pump=new Thread(()=>Pump(path+".stop"));pump.IsBackground=true;pump.Start();
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
  rmSync(`${rawPath}.stop`, { force: true }); // a stale one would stop the helper at once
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
  stopFiles.set(child, `${rawPath}.stop`);
  return child;
}

/** Stop file per helper: when it appears, the helper writes out its buffer
 * and any open typing burst, then exits. */
const stopFiles = new WeakMap<ChildProcess, string>();

/** How long a helper gets to flush and exit before it is killed. */
export const LOGGER_STOP_GRACE_MS = 2_000;

/** Stop the helper and wait for it to exit, so the raw file is complete. */
export function stopEventLogger(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  let stop = stopFiles.get(child);
  if (stop) {
    try {
      writeFileSync(stop, "");
    } catch {
      stop = undefined; // fall back to killing it
    }
  }
  return new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill(), stop ? LOGGER_STOP_GRACE_MS : 0);
    const done = setTimeout(resolve, LOGGER_STOP_GRACE_MS + 5_000);
    child.once("exit", () => {
      clearTimeout(kill);
      clearTimeout(done);
      resolve();
    });
  }).finally(() => {
    if (stop) rmSync(stop, { force: true });
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
