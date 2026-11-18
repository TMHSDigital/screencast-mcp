/**
 * The shared PowerShell runner (#360): runs a script without blocking the
 * event loop, with a timeout, cancellation, UTF-8 output, and a temp-file
 * payload for data too big for the command line. Used for monitors,
 * windows, OCR, speech, GPU and process queries.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreencastError } from "./errors.js";

/** Make PowerShell write UTF-8. By default it writes the console's OEM code
 * page (e.g. 437), which turns "é" into a replacement character and maps
 * symbols such as "•" and "→" to raw control bytes (0x07, 0x1A): window
 * titles stopped matching and OCR output stopped parsing as JSON. */
export const PS_UTF8_PREAMBLE = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n";

/** Default limit for one enumeration script (monitors, windows) (#183). */
export const PS_TIMEOUT_MS = 20_000;
/** Overrides every PowerShell helper's limit, in ms. */
export const PS_TIMEOUT_ENV = "SCREENCAST_PS_TIMEOUT_MS";

/** The env override when it is a positive integer, else `fallback`. */
export function psTimeoutMs(fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env[PS_TIMEOUT_ENV]);
  return Number.isInteger(override) && override > 0 ? override : fallback;
}

export interface RunPowerShellOptions {
  /** Kill the script after this long (default PS_TIMEOUT_MS, or the env override). */
  timeoutMs?: number;
  /** Tests: run this command and args instead of powershell. */
  command?: { file: string; args: string[] };
  /** Kill the script when this aborts (the tool call was cancelled). */
  signal?: AbortSignal;
  /** Variable-size data for the script (a JSON request, a path list). It is
   * written to a temp file the script reads as `$Payload` (a string), never
   * put on the command line, which Windows caps at 32,767 characters (#254). */
  payload?: string;
  /** Start of the failure message, e.g. "Could not synthesize speech"
   * (default "Could not enumerate <what>"). */
  failure?: string;
}

/** Windows' limit on a whole command line, in characters (CreateProcess). */
export const MAX_COMMAND_LINE_CHARS = 32_767;

/** The script line that loads a payload file into `$Payload`. The path is
 * base64 (UTF-8) so no quoting is involved; its length is fixed, whatever
 * the payload's size. */
export function payloadPreamble(path: string): string {
  const b64 = Buffer.from(path, "utf8").toString("base64");
  return `$Payload = [IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), [Text.Encoding]::UTF8)\n`;
}

/** powershell's arguments for a script (plus the payload preamble when the
 * script takes a payload). Pure. */
export function powerShellArgs(script: string, payloadPath?: string): string[] {
  const full = PS_UTF8_PREAMBLE + (payloadPath === undefined ? "" : payloadPreamble(payloadPath)) + script;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(full, "utf16le").toString("base64")];
}

/** The length of the command line Windows sees for these args (each quoted,
 * space-separated): an upper bound good enough to test against the limit. */
export function commandLineLength(file: string, args: readonly string[]): number {
  return [file, ...args].reduce((n, a) => n + a.length + 3, 0);
}

/** Write `payload` to a private temp file, run `fn` with its path, and delete
 * the file afterwards, whether `fn` succeeded or not. */
export async function withPayloadFile<T>(payload: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `screencast-ps-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(path, payload, { encoding: "utf8", mode: 0o600 });
  try {
    return await fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

/** Run a base64-encoded PowerShell script without blocking the event loop and
 * return its stdout (UTF-8). Shared by window enumeration, OCR, and speech. A
 * script that runs past the timeout is killed, so a stuck WinRT or user32
 * call fails the tool instead of hanging it (#183). Data of any size goes in
 * `opts.payload`, not into the script text (#254). */
export function runPowerShell(script: string, what: string, opts: RunPowerShellOptions = {}): Promise<string> {
  if (opts.payload === undefined) return execPowerShell(script, what, opts);
  return withPayloadFile(opts.payload, (path) => execPowerShell(script, what, opts, path));
}

function execPowerShell(script: string, what: string, opts: RunPowerShellOptions, payloadPath?: string): Promise<string> {
  const timeout = opts.timeoutMs ?? psTimeoutMs(PS_TIMEOUT_MS);
  const file = opts.command?.file ?? "powershell";
  const args = opts.command?.args ?? powerShellArgs(script, payloadPath);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout, killSignal: "SIGKILL", signal: opts.signal },
      (err, stdout, stderr) => {
        if (opts.signal?.aborted) {
          reject(new ScreencastError(`Cancelled while reading ${what}.`));
        } else if (err && (err as { killed?: boolean }).killed) {
          reject(
            new ScreencastError(
              `Timed out reading ${what} after ${timeout / 1000} s (PowerShell did not answer).`,
              `Retry; if it keeps happening, restart the app being captured or raise ${PS_TIMEOUT_ENV}.`,
            ),
          );
        } else if (err || !stdout) {
          const label = opts.failure ?? `Could not enumerate ${what}`;
          reject(new ScreencastError(`${label}: ${stderr?.trim() || err?.message || "powershell failed"}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
