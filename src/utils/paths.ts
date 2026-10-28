/**
 * Output location and filename helpers.
 *
 * By default everything the server writes lands under SCREENCAST_HOME
 * (default: <homedir>/.screencast-mcp), NOT the current working directory, so
 * captures never accidentally land inside a checked-out repo. Callers may still
 * pass an `output` path per call: a relative one resolves under the tool's
 * SCREENCAST_HOME subdir (never the server's unpredictable cwd), and once the
 * allowed set is known (client roots or SCREENCAST_ALLOWED_DIRS) a path outside
 * it is refused (#221). The repo .gitignore is a second line of defence for the
 * case where output is pointed back into the project.
 */
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, isAbsolute, relative, resolve, sep } from "node:path";
import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { ScreencastError } from "./errors.js";

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

/** An ffmpeg image-sequence pattern (`name` holds the `%0Nd`) inside `dir`. A
 * `%` in the directory itself is escaped as `%%` so ffmpeg reads it literally
 * (#238). */
export function sequencePattern(dir: string, name: string): string {
  return join(dir.replace(/%/g, "%%"), name);
}

const STILL_IMAGE = /\.(png|jpe?g|bmp|tiff?)$/i;

/** The output args for a single still image. ffmpeg's image2 muxer reads a `%`
 * in the file name as a sequence pattern (`b%dx.png` becomes `b1x.png`), so
 * `-update 1` keeps the name literal and the returned path real (#238). */
export function stillOutput(output: string): string[] {
  return STILL_IMAGE.test(output) ? ["-update", "1", output] : [output];
}

/** A unique scratch path in the OS temp dir for short-lived working files (a
 * concat list, a drawtext textfile). Kept out of SCREENCAST_HOME/edits so a hard
 * crash before cleanup leaves it where the OS reaps it, not next to outputs. */
export function tempPath(suffix = ""): string {
  return join(tmpdir(), `screencast-${stamp()}-${rand()}${suffix}`);
}

export const ALLOWED_DIRS_ENV = "SCREENCAST_ALLOWED_DIRS";

/** Directories from SCREENCAST_ALLOWED_DIRS (`;`-separated on Windows, the
 * platform path delimiter elsewhere). Blank entries are ignored. */
export function envAllowedDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ALLOWED_DIRS_ENV];
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .map((d) => resolve(d));
}

// Client roots (#221): null until the client reports them (or when it has no
// roots capability); "pending" between initialize and the first roots/list
// reply, so a call in that window is not let through unconfined.
let clientRoots: string[] | null | "pending" = null;

/** Record the client's roots as directories (null: the client sent none). */
export function setClientRoots(dirs: string[] | null | "pending"): void {
  clientRoots = dirs === null || dirs === "pending" ? dirs : dirs.map((d) => resolve(d));
}

/** The client's roots in effect, or null when it has not sent any. */
export function getClientRoots(): string[] | null {
  return Array.isArray(clientRoots) ? clientRoots : null;
}

/** Where outputs may go: null means unconfined (no client roots and no
 * SCREENCAST_ALLOWED_DIRS, the pre-#221 behavior). Otherwise SCREENCAST_HOME
 * is always included, so default outputs keep working. */
export function allowedOutputDirs(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const fromEnv = envAllowedDirs(env);
  if (clientRoots === null && fromEnv.length === 0) return null;
  const roots = Array.isArray(clientRoots) ? clientRoots : [];
  return [resolve(homeRoot()), ...fromEnv, ...roots];
}

/** The path with its deepest existing ancestor replaced by its real path, so a
 * junction or symlink inside an allowed dir cannot point a write outside it. */
function realish(path: string): string {
  const tail: string[] = [];
  let cur = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(path);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** True when `path` is `dir` or inside it (case-insensitive on Windows). */
export function isWithin(path: string, dir: string): boolean {
  const rel = relative(realish(dir), realish(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuse a write target outside the allowed dirs, when they are known. */
export function assertOutputAllowed(path: string): void {
  if (clientRoots === "pending" && envAllowedDirs().length === 0 && !isWithin(path, homeRoot())) {
    throw new ScreencastError(
      `Output ${path} is outside SCREENCAST_HOME and the client's workspace roots have not loaded yet. ` +
        "Retry the call in a moment, or omit the path to write under SCREENCAST_HOME.",
    );
  }
  const allowed = allowedOutputDirs();
  if (allowed === null || allowed.some((dir) => isWithin(path, dir))) return;
  throw new ScreencastError(
    `Output ${path} is outside the allowed directories: ${allowed.join(", ")}. ` +
      `Write under one of them (a relative path lands in SCREENCAST_HOME), or add the folder to ` +
      `${ALLOWED_DIRS_ENV} or the client's workspace roots.`,
  );
}

/** Resolve a caller-supplied output path, or build a default under a subdir.
 *
 * A relative path resolves under `defaultDir` (a SCREENCAST_HOME subdir), not
 * the server's cwd, and the result must sit inside the allowed dirs when they
 * are known (#221).
 *
 * A caller-supplied path that already exists is refused unless the caller
 * passed overwrite: true - every ffmpeg builder runs with -y, so this is the
 * one place that stands between a reused path and a silently clobbered file.
 * Auto-generated default names are unique and skip the check. */
export function resolveOutput(
  provided: string | undefined,
  defaultDir: string,
  defaultName: string,
  overwrite = false,
): string {
  if (provided && provided.trim().length > 0) {
    const path = resolve(defaultDir, provided);
    assertOutputAllowed(path);
    if (!overwrite && existsSync(path)) {
      throw new ScreencastError(
        `Output already exists: ${path}. Pass overwrite: true to replace it, ` +
          `or choose a different path.`,
      );
    }
    return path;
  }
  return join(defaultDir, defaultName);
}

/** Resolve a caller-supplied output directory (relative under `defaultParent`)
 * and check it against the allowed dirs; undefined when none was given. */
export function resolveOutputDir(provided: string | undefined, defaultParent: string): string | undefined {
  if (!provided || provided.trim().length === 0) return undefined;
  const dir = resolve(defaultParent, provided);
  assertOutputAllowed(dir);
  return dir;
}
