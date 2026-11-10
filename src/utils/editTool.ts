/**
 * The scaffold every file-writing tool shares (#308): check the input exists,
 * then pick the output path, refusing a container the edit cannot write.
 * Kept in one place so a cross-cutting fix (#187 containers, #221 output
 * confinement) lands in every tool at once.
 */
import { existsSync } from "node:fs";
import { ScreencastError } from "./errors.js";
import { assertEditContainer } from "./media.js";
import { resolveOutput, subdir, stamp, rand } from "./paths.js";

/** Throw "<label> not found: <path>" unless `path` exists. */
export function requireInput(path: string, label = "Input file"): void {
  if (!existsSync(path)) throw new ScreencastError(`${label} not found: ${path}`);
}

export interface EditOutputOptions {
  overwrite?: boolean;
  /** Folder under SCREENCAST_HOME for a default name (default "edits"). */
  dir?: "edits" | "recordings" | "screenshots";
  /** Skip the H.264/AAC container check, for tools that write something else
   * (audio, GIF, subtitles, stream copies, stills). */
  anyContainer?: boolean;
}

/** The output path for an edit: `output` when given (after the container
 * check), else `<dir>/<tag>-<stamp>-<rand><ext>`. */
export function editOutput(output: string | undefined, tag: string, ext: string, opts: EditOutputOptions = {}): string {
  if (!opts.anyContainer) assertEditContainer(output);
  return resolveOutput(output, subdir(opts.dir ?? "edits"), `${tag}-${stamp()}-${rand()}${ext}`, opts.overwrite);
}
