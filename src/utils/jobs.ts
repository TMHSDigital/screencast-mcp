/**
 * Long-running edit jobs (#81).
 *
 * Edit tools used to run ffmpeg with a fixed 5-20 minute timeout, wrote
 * straight to the output path, and reported nothing until they finished. A
 * long recording could time out partway, leave a truncated file at `output`
 * (which then blocked a retry with "Output already exists"), and the agent had
 * no idea how far it got. runEditJob fixes all three:
 *
 * - the timeout scales with the media's duration (env override available);
 * - ffmpeg writes a `.partial` sibling that is renamed onto `output` only on
 *   success and deleted on any failure, timeout, or cancellation;
 * - `-progress pipe:1` is parsed and forwarded as MCP progress notifications
 *   when the request carried a progressToken.
 *
 * Running jobs are tracked so a server shutdown can cancel them and remove
 * their partials before exiting (#237).
 */
import { basename, dirname, extname, join } from "node:path";
import { renameSync, rmSync } from "node:fs";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { ScreencastError } from "./errors.js";
import { probeMedia, runFfmpeg } from "./ffmpeg.js";

/** The `extra` argument the SDK passes to every tool callback. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Env var that overrides every edit job's timeout, in milliseconds. */
export const JOB_TIMEOUT_ENV = "SCREENCAST_JOB_TIMEOUT_MS";
/** Floor for a duration-scaled timeout. */
export const BASE_TIMEOUT_MS = 10 * 60_000;
/** Timeout when the media's duration could not be probed. */
export const UNKNOWN_DURATION_TIMEOUT_MS = 30 * 60_000;
/** Allow this many seconds of wall-clock time per second of media. A slow
 * preset on a laptop runs around real time; 4x leaves ample headroom. */
export const SECONDS_PER_MEDIA_SECOND = 4;

/** Timeout for a job over `durationSec` of media: max(base, duration * 4x),
 * or the env override when it is a positive integer. */
export function jobTimeoutMs(
  durationSec: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env[JOB_TIMEOUT_ENV]);
  if (Number.isInteger(override) && override > 0) return override;
  if (durationSec == null || !(durationSec > 0)) return UNKNOWN_DURATION_TIMEOUT_MS;
  return Math.max(BASE_TIMEOUT_MS, Math.ceil(durationSec * SECONDS_PER_MEDIA_SECOND * 1000));
}

/** `dir/name.partial.ext`: keeps the extension so ffmpeg picks the same muxer. */
export function partialPath(output: string): string {
  const ext = extname(output);
  return join(dirname(output), `${basename(output, ext)}.partial${ext}`);
}

/** Point a builder's args at `partial` instead of `output`. Builders put the
 * output path last; replacing the last occurrence leaves an identical input
 * path (rare, but legal with overwrite) untouched. */
export function retargetOutput(args: string[], output: string, partial: string): string[] {
  const i = args.lastIndexOf(output);
  if (i === -1) {
    throw new ScreencastError(`Internal error: output path ${output} is not in the ffmpeg arguments.`);
  }
  const next = [...args];
  next[i] = partial;
  return next;
}

/** Feed `-progress pipe:1` output in chunks; returns the latest media time in
 * seconds seen so far. Lines can split across chunks, so it buffers. */
export function createProgressParser(): (chunk: string) => number | null {
  let buffer = "";
  let latest: number | null = null;
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      // out_time_us is microseconds; ffmpeg's out_time_ms is also microseconds
      // (a long-standing naming bug), so either works as a fallback.
      const m = line.match(/^out_time_(?:us|ms)=(\d+)$/);
      if (m) latest = Number(m[1]) / 1_000_000;
    }
    return latest;
  };
}

/** A progress callback that forwards to the client as MCP progress
 * notifications, or undefined when the request asked for none. Updates are
 * throttled to whole-percent steps. */
export function progressReporter(extra: ToolExtra | undefined): ((fraction: number) => void) | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return undefined;
  let lastPercent = -1;
  return (fraction) => {
    const percent = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
    if (percent <= lastPercent) return;
    lastPercent = percent;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: percent, total: 100 },
      })
      .catch(() => {
        /* a client that went away must not fail the job */
      });
  };
}

export interface EditJob {
  /** The final output path (already validated by resolveOutput). */
  output: string;
  /** Duration of the media the job writes, for timeout scaling and progress. */
  durationSec?: number | null;
  /** Duration of the media ffmpeg must decode, when it differs from the
   * output's (speed, cut_idle, pipeline): the timeout scales with the longer
   * of the two (#237). */
  inputDurationSec?: number | null;
  /** The tool callback's `extra`, for progress and cancellation. */
  extra?: ToolExtra;
}

interface ActiveJob {
  partial: string;
  controller: AbortController;
  done: Promise<void>;
}

/** Edit jobs in flight, so a shutdown can cancel them and remove their
 * partials before the process exits (#237). */
const activeJobs = new Set<ActiveJob>();
let jobsClosed = false;

/** Run an ffmpeg edit job atomically: write a .partial sibling, rename it onto
 * the output on success, and delete it on any failure. */
export async function runEditJob(args: string[], job: EditJob): Promise<void> {
  if (jobsClosed) throw new ScreencastError("The server is shutting down; the edit was not started.");
  const partial = partialPath(job.output);
  const report = progressReporter(job.extra);
  const parse = createProgressParser();
  const duration = job.durationSec != null && job.durationSec > 0 ? job.durationSec : null;
  // Size the timeout by whichever is longer: the input ffmpeg decodes or the
  // output it encodes (a slow-motion speed writes more than it reads).
  const input = job.inputDurationSec != null && job.inputDurationSec > 0 ? job.inputDurationSec : null;
  const decoded = input !== null && duration !== null ? Math.max(input, duration) : (input ?? duration);
  const ffArgs = ["-progress", "pipe:1", "-nostats", ...retargetOutput(args, job.output, partial)];
  const controller = new AbortController();
  const signal = job.extra?.signal ? AbortSignal.any([job.extra.signal, controller.signal]) : controller.signal;
  let finish!: () => void;
  const active: ActiveJob = { partial, controller, done: new Promise((r) => (finish = r)) };
  activeJobs.add(active);
  try {
    await runFfmpeg(ffArgs, jobTimeoutMs(decoded), {
      signal,
      onStdout: report && duration
        ? (chunk) => {
            const t = parse(chunk);
            if (t !== null) report(t / duration);
          }
        : undefined,
    });
    renameSync(partial, job.output);
    report?.(1);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    activeJobs.delete(active);
    finish();
  }
}

/** Number of edit jobs in flight. */
export function activeEditJobs(): number {
  return activeJobs.size;
}

/** Shutdown: refuse new edit jobs, cancel the running ones, wait up to
 * `graceMs` for their ffmpeg to exit, and delete any partial left behind.
 * Returns how many jobs were cancelled. Never throws. */
export async function abortEditJobs(graceMs = 3_000): Promise<number> {
  jobsClosed = true;
  const jobs = [...activeJobs];
  if (jobs.length === 0) return 0;
  for (const job of jobs) job.controller.abort();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(jobs.map((j) => j.done)),
    new Promise<void>((r) => (timer = setTimeout(r, graceMs))),
  ]);
  clearTimeout(timer);
  for (const job of jobs) {
    try {
      rmSync(job.partial, { force: true });
    } catch {
      /* still held by an ffmpeg that has not exited; nothing more to do */
    }
  }
  return jobs.length;
}

/** Probe a file's duration, or null when it cannot be read. Used to size
 * timeouts and progress; never fails the job on its own. */
export async function probeDuration(input: string): Promise<number | null> {
  try {
    return (await probeMedia(input)).durationSec;
  } catch {
    return null;
  }
}
