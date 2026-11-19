/**
 * Process metadata for recorder and server pids (Windows): whether a pid is
 * alive, its image and start time, and a tree kill for orphan reaping. Split
 * out of sessions.ts (#360).
 */
import { spawnSync } from "node:child_process";
import { powerShellArgs, runPowerShell } from "./powershell.js";

/** Parse `<image>|<start ms>` from processInfo's PowerShell. Pure. */
export function parseProcessInfo(stdout: string): { image: string; startMs: number } | null {
  const m = /^(.+)\|(\d+)\s*$/m.exec(stdout.trim());
  return m?.[1] && m[2] ? { image: m[1].trim(), startMs: Number(m[2]) } : null;
}

/** The PowerShell that prints `<image>|<start ms>` for a pid. */
function processInfoScript(pid: number): string {
  return (
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
    `if ($p) { "{0}|{1}" -f $p.Name, ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`
  );
}

const PROCESS_INFO_TIMEOUT_MS = 10_000;

/** Image name and start time of a running pid (Windows), or null when it is
 * gone or cannot be read. */
export function processInfo(
  pid: number,
  timeoutMs: number = PROCESS_INFO_TIMEOUT_MS,
): { image: string; startMs: number } | null {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  const res = spawnSync("powershell", powerShellArgs(processInfoScript(pid)), {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return res.status === 0 && res.stdout ? parseProcessInfo(res.stdout) : null;
}

/** processInfo without blocking the event loop (#358), for boot reaping,
 * through the shared PowerShell runner (#360). `timeoutMs` lets a caller that
 * can afford to wait (a test on a slow runner, #372) outlast a cold PowerShell
 * start; production keeps the 10 s default. */
export function processInfoAsync(
  pid: number,
  timeoutMs: number = PROCESS_INFO_TIMEOUT_MS,
): Promise<{ image: string; startMs: number } | null> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return runPowerShell(processInfoScript(pid), `process ${pid}`, { timeoutMs }).then(
    (stdout) => parseProcessInfo(stdout),
    () => null,
  );
}

/** True if a pid exists. `process.kill(pid, 0)` throws ESRCH when it does not. */
export function isAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when a `tasklist /FO CSV` line names the given image. Pure. */
export function tasklistHasImage(stdout: string, image: string): boolean {
  const first = stdout.split(/\r?\n/)[0] ?? "";
  return first.toLowerCase().startsWith(`"${image.toLowerCase()}"`);
}

/** On Windows, confirm a pid is still the expected recorder image before
 * killing it, so a recycled pid belonging to an unrelated process is never
 * terminated. */
export function isRecorderProcess(pid: number | null, image: string): boolean {
  if (pid === null || process.platform !== "win32") return false;
  const res = spawnSync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) return false;
  return tasklistHasImage(res.stdout, image);
}

/** Forcefully terminate a pid tree (used only for orphan reaping). */
export function killPid(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
