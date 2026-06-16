/**
 * Output location and filename helpers.
 *
 * By default everything the server writes lands under SCREENCAST_HOME
 * (default: <homedir>/.screencast-mcp), NOT the current working directory, so
 * captures never accidentally land inside a checked-out repo. Callers may still
 * pass an absolute `output` path per call. The repo .gitignore is a second line
 * of defence for the case where output is pointed back into the project.
 */
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export function homeRoot(): string {
  const override = process.env.SCREENCAST_HOME;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".screencast-mcp");
}

export function subdir(name: "recordings" | "frames" | "screenshots" | "edits"): string {
  const dir = join(homeRoot(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The on-disk session registry path. */
export function registryPath(): string {
  const dir = homeRoot();
  mkdirSync(dir, { recursive: true });
  return join(dir, "sessions.json");
}

/** A compact UTC timestamp like 20260615-192430-880. */
export function stamp(date = new Date()): string {
  const iso = date.toISOString().replace(/[-:T]/g, "").replace(/\..+/, "");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${iso.slice(0, 8)}-${iso.slice(8, 14)}-${ms}`;
}

/** Short random suffix to make ids/filenames unique within the same ms. */
export function rand(n = 4): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

/** A unique scratch path in the OS temp dir for short-lived working files (a
 * concat list, a drawtext textfile). Kept out of SCREENCAST_HOME/edits so a hard
 * crash before cleanup leaves it where the OS reaps it, not next to outputs. */
export function tempPath(suffix = ""): string {
  return join(tmpdir(), `screencast-${stamp()}-${rand()}${suffix}`);
}

/** Resolve a caller-supplied output path, or build a default under a subdir. */
export function resolveOutput(
  provided: string | undefined,
  defaultDir: string,
  defaultName: string,
): string {
  if (provided && provided.trim().length > 0) {
    return isAbsolute(provided) ? provided : resolve(provided);
  }
  return join(defaultDir, defaultName);
}
