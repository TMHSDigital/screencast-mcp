/** The performance track (#335): CPU math, the clock, the summary, and the
 * report lines. Pure. */
import { describe, it, expect } from "vitest";
import { convertPerfSamples, cpuBusyPct, parseProcLine, perfPath, procCpuPct, procLoopScript, summarizePerf, type PerfSample } from "../utils/perf.js";
import { perfLines } from "../utils/bugReport.js";

const cpu = (user: number, idle: number) => ({ model: "x", speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } });

describe("perf track (#335)", () => {
  it("computes machine and process CPU shares", () => {
    expect(cpuBusyPct([cpu(100, 100), cpu(100, 100)], [cpu(175, 125), cpu(125, 175)])).toBe(50);
    expect(parseProcLine("1000,250.5,104857600\r")).toEqual({ epochMs: 1000, cpuMs: 250.5, rss: 104857600 });
    expect(parseProcLine("garbage")).toBeNull();
    // 1 s of CPU in 1 s on a 4-core machine: a quarter of it.
    expect(procCpuPct({ epochMs: 0, cpuMs: 0 }, { epochMs: 1000, cpuMs: 1000 }, 4)).toBe(25);
    expect(procCpuPct({ epochMs: 0, cpuMs: 0 }, { epochMs: 0, cpuMs: 10 }, 4)).toBe(0);
    expect(procLoopScript(42, 7, 1000)).toContain("Get-Process -Id 42");
    expect(procLoopScript(42, 7, 1000)).toContain("Get-Process -Id 7");
    expect(perfPath("C:/r/rec.mp4")).toBe("C:/r/rec.perf.jsonl");
  });

  it("moves samples onto the video clock", () => {
    const s = convertPerfSamples(
      [{ epochMs: 500, sysCpu: 1, sysMem: 1 }, { epochMs: 1500, sysCpu: 2, sysMem: 2, cpu: 9, rssMB: 100 }, { epochMs: 99_000, sysCpu: 3, sysMem: 3 }],
      { startMs: 1000, endSec: 10 },
    );
    expect(s).toEqual([{ t: 0.5, sysCpu: 2, sysMem: 2, cpu: 9, rssMB: 100 }]);
  });

  it("summarizes peaks, memory growth and pinned stretches", () => {
    const samples: PerfSample[] = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ t, sysCpu: 40, sysMem: 50, cpu: t >= 2 && t <= 5 ? 97 : 10, rssMB: 100 + t * 10 }));
    expect(summarizePerf(samples, { pid: 1, exe: "app.exe" })).toEqual({
      samples: 7,
      peakSysCpu: 40,
      peakCpu: 97,
      peakRssMB: 160,
      rssGrowthMB: 60,
      busy: [{ start: 2, end: 5 }],
      process: { pid: 1, exe: "app.exe" },
    });
    // Without a process, the machine's CPU decides what is busy.
    expect(summarizePerf([0, 1, 2, 3].map((t) => ({ t, sysCpu: 95, sysMem: 1 }))).busy).toEqual([{ start: 0, end: 3 }]);
  });

  it("writes report lines for the clip only", () => {
    const samples: PerfSample[] = [10, 11, 12, 13, 14].map((t) => ({ t, sysCpu: 50, sysMem: 50, cpu: 98, rssMB: 200 + t }));
    const lines = perfLines(samples, { start: 10, end: 14 }, { exe: "app.exe" });
    expect(lines).toEqual([
      "app.exe CPU peaked at 98% of the machine",
      "app.exe memory peaked at 214 MB (+4 MB over the clip)",
      "Machine CPU peaked at 50%",
      "CPU pinned (>= 90%) from 0:00.0 to 0:04.0",
    ]);
    expect(perfLines(samples, { start: 20, end: 30 })).toEqual([]);
  });
});
