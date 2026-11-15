/**
 * The package's own files (assets, package.json, the WGC recorder script),
 * found from the installed package root rather than from relative paths. The
 * published package is bundled into dist/index.js (#265), so code no longer
 * sits at the depth its source file had: `../../assets` from src/utils is the
 * package root, but from dist/index.js it is the folder above the package.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScreencastError } from "./errors.js";

export const PACKAGE_NAME = "@tmhs/screencast-mcp";

let root: string | null = null;
let version: string | null = null;

/** Read a package.json, or null when it is missing or not JSON. */
function readPackageJson(path: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/** The first folder at or above `start` whose package.json names this
 * package, or null. Pure apart from the file reads. */
export function findPackageRoot(start: string): string | null {
  for (let dir = start; ; ) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && readPackageJson(pj)?.name === PACKAGE_NAME) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The package root: the folder holding this package's package.json. Works
 * from src/ (tests), dist/ (tsc output) and the bundled dist/index.js alike. */
export function packageRoot(): string {
  if (root) return root;
  const found = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (!found) throw new ScreencastError(`Cannot find the ${PACKAGE_NAME} package root (its package.json).`);
  return (root = found);
}

/** The installed package version. */
export function packageVersion(): string {
  return (version ??= readPackageJson(join(packageRoot(), "package.json"))?.version ?? "0.0.0");
}

/** A file under the package's assets/ folder. */
export function assetPath(...parts: string[]): string {
  return join(packageRoot(), "assets", ...parts);
}

/** The WGC recorder script, run as its own node process. */
export function wgcRecorderScript(): string {
  return join(packageRoot(), "dist", "wgcRecorder.js");
}
