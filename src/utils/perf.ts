/**
 * A performance track beside the video (#335). While a recording runs, the
 * machine's CPU and memory are sampled every second in Node, and, for a
 * window target, the owning process's CPU time and working set by one
 * long-lived PowerShell loop (which exits on its own if the server dies).
 * When the recording ends the samples move onto the video clock (pauses cut
 * out) into `<recording>.perf.jsonl`, with a summary of the peaks that
 * bug_report quotes ("CPU pinned at 98% from 0:12 to 0:31").
 *
 * Everything but PerfSampler is pure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { videoTimeSec, type ClockSpan } from "./clock.js";

export const PERF_INTERVAL_MS = 1000;
/** A stretch at or above this CPU share counts as pinned. */
export const BUSY_CPU_PCT = 90;

export interface RawPerfSample {
  epochMs: number;
  /** Machine CPU busy, 0-100. */
  sysCpu: number;
  /** Machine memory in use, 0-100. */
  sysMem: number;
  /** The target process: CPU as a share of the whole machine (0-100), and its working set. */
  cpu?: number;
  rssMB?: number;
}

export interface PerfSample extends Omit<RawPerfSample, "epochMs"> {
  /** Seconds on the video's clock. */
  t: number;
}

export interface PerfSummary {
  samples: number;
  peakSysCpu: number;
  peakCpu?: number;
  peakRssMB?: number;
  /** Working set at the end minus at the start. */
  rssGrowthMB?: number;
  /** Stretches where the process (or, without one, the machine) was at or
   * above BUSY_CPU_PCT, at least 2 s long. */
  busy: Array<{ start: number; end: number }>;
  process?: { pid: number; exe?: string };
}

/** Machine CPU busy share between two os.cpus() readings. Pure. */
export function cpuBusyPct(a: ReturnType<typeof cpus>, b: ReturnType<typeof cpus>): number {
  let busy = 0;
  let total = 0;
  b.forEach((c, i) => {
    const p = a[i];
    if (!p) return;
    const d = (k: keyof typeof c.times) => c.times[k] - p.times[k];
    const all = d("user") + d("nice") + d("sys") + d("idle") + d("irq");
    busy += all - d("idle");
    total += all;
  });
  return total > 0 ? Math.round((busy / total) * 1000) / 10 : 0;
}

/** One process line from the PowerShell loop: `<epoch ms>,<cpu ms>,<working set bytes>`. Pure. */
export function parseProcLine(line: string): { epochMs: number; cpuMs: number; rss: number } | null {
  const [a, b, c] = line.trim().split(",").map(Number);
  return a !== undefined && b !== undefined && c !== undefined && [a, b, c].every(Number.isFinite) ? { epochMs: a, cpuMs: b, rss: c } : null;
}

/** Process CPU as a share of the whole machine between two readings. Pure. */
export function procCpuPct(prev: { epochMs: number; cpuMs: number }, cur: { epochMs: number; cpuMs: number }, cores: number): number {
  const wall = cur.epochMs - prev.epochMs;
  if (!(wall > 0) || !(cores > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round(((cur.cpuMs - prev.cpuMs) / wall / cores) * 1000) / 10));
}

/** Samples onto the video clock: outside it (before, paused, after) they are
 * dropped. Pure. */
export function convertPerfSamples(raw: readonly RawPerfSample[], clock: { startMs: number; endSec: number; spans?: ClockSpan[] }): PerfSample[] {
  const out: PerfSample[] = [];
  for (const { epochMs, ...rest } of raw) {
    const t = clock.spans?.length ? videoTimeSec(epochMs, clock.spans) : (epochMs - clock.startMs) / 1000;
    if (t === null || t < 0 || t > clock.endSec) continue;
    out.push({ t: Math.round(t * 1000) / 1000, ...rest });
  }
  return out;
}

/** Peaks and busy stretches. Pure. */
export function summarizePerf(samples: readonly PerfSample[], proc?: { pid: number; exe?: string }): PerfSummary {
  const procCpu = samples.filter((s) => s.cpu !== undefined);
  const rss = samples.filter((s) => s.rssMB !== undefined);
  const usage = (s: PerfSample) => (procCpu.length ? (s.cpu ?? 0) : s.sysCpu);
  const busy: PerfSummary["busy"] = [];
  let from: number | null = null;
  let last = 0;
  for (const s of samples) {
    if (usage(s) >= BUSY_CPU_PCT) {
      from ??= s.t;
      last = s.t;
    } else if (from !== null) {
      if (last - from >= 2) busy.push({ start: from, end: last });
      from = null;
    }
  }
  if (from !== null && last - from >= 2) busy.push({ start: from, end: last });
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    samples: samples.length,
    peakSysCpu: r1(Math.max(0, ...samples.map((s) => s.sysCpu))),
    ...(procCpu.length ? { peakCpu: r1(Math.max(...procCpu.map((s) => s.cpu!))) } : {}),
    ...(rss.length ? { peakRssMB: r1(Math.max(...rss.map((s) => s.rssMB!))), rssGrowthMB: r1(rss.at(-1)!.rssMB! - rss[0]!.rssMB!) } : {}),
    busy,
    ...(proc ? { process: proc } : {}),
  };
}

export function formatPerfJsonl(samples: readonly PerfSample[]): string {
  return samples.map((s) => JSON.stringify(s)).join("\n") + (samples.length ? "\n" : "");
}

export function parsePerfJsonl(text: string): PerfSample[] {
  const out: PerfSample[] = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    try {
      out.push(JSON.parse(row) as PerfSample);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

/** `<recording>.perf.jsonl`. */
export function perfPath(recording: string): string {
  return recording.replace(/\.[^./\\]+$/, "") + ".perf.jsonl";
}

/** The PowerShell loop that reads one process every interval; it ends when
 * the process or the server is gone. */
export function procLoopScript(pid: number, parentPid: number, intervalMs: number): string {
  return (
    "$ErrorActionPreference='SilentlyContinue';" +
    `while($true){$p=Get-Process -Id ${pid};if(-not $p -or -not (Get-Process -Id ${parentPid})){break};` +
    "$t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();" +
    "[Console]::Out.WriteLine(\"$t,$($p.TotalProcessorTime.TotalMilliseconds),$($p.WorkingSet64)\");[Console]::Out.Flush();" +
    `Start-Sleep -Milliseconds ${intervalMs}}`
  );
}

/** Samples the machine (and optionally one process) until stopped. */
export class PerfSampler {
  private samples: RawPerfSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null;
  private proc: { cpu?: number; rssMB?: number } = {};

  constructor(private readonly pid?: number, private readonly intervalMs = PERF_INTERVAL_MS) {}

  start(): void {
    let prev = cpus();
    const cores = prev.length || 1;
    if (this.pid !== undefined) {
      this.child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", procLoopScript(this.pid, process.pid, this.intervalMs)], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      this.child.on("error", () => {
        this.child = null;
      });
      let last: { epochMs: number; cpuMs: number } | null = null;
      let pending = "";
      this.child.stdout?.on("data", (d: Buffer) => {
        pending += d.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const r = parseProcLine(line);
          if (!r) continue;
          if (last) this.proc = { cpu: procCpuPct(last, r, cores), rssMB: Math.round(r.rss / 1048576) };
          last = r;
        }
      });
    }
    this.timer = setInterval(() => {
      const now = cpus();
      const total = totalmem();
      this.samples.push({
        epochMs: Date.now(),
        sysCpu: cpuBusyPct(prev, now),
        sysMem: total > 0 ? Math.round(((total - freemem()) / total) * 1000) / 10 : 0,
        ...this.proc,
      });
      prev = now;
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): RawPerfSample[] {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.child?.kill();
    this.child = null;
    return this.samples;
  }
}
