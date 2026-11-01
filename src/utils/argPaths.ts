/**
 * One check on every tool call's file-path arguments, before the handler runs:
 * network (UNC/WebDAV) and device paths are refused everywhere, and input
 * paths must sit inside the allowed dirs once those are known. Doing it here,
 * not in each of 58 handlers, means a new tool cannot forget it.
 */
import { assertInputAllowed, assertLocalPath } from "./paths.js";

/** Argument names that hold a file to read, at any depth (pipeline steps
 * nest them). */
const INPUT_KEYS = new Set([
  "input", "inputs", "inputA", "inputB", "clips", "a", "b", "image", "overlay",
  "music", "video", "subtitles", "srt", "transcript", "events",
]);

/** Paths the server writes: only the network check here; the tools confine
 * them through resolveOutput/assertOutputAllowed. Tool assets (a whisper
 * model, a font) are read but carry no user content, so they are not
 * confined, only kept local. */
const LOCAL_ONLY_KEYS = new Set(["output", "outputDir", "model", "fontFile"]);

/** Values of path arguments that are keywords, not files. */
const KEYWORDS = new Set(["whisper"]);

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** Throws a ScreencastError for the first disallowed path argument. */
export function assertArgPaths(args: unknown): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (INPUT_KEYS.has(key)) {
        for (const s of strings(value)) {
          if (s.trim().length > 0 && !KEYWORDS.has(s)) assertInputAllowed(s, `Input "${key}"`);
        }
      } else if (LOCAL_ONLY_KEYS.has(key)) {
        for (const s of strings(value)) assertLocalPath(s, `"${key}"`);
      }
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(args);
}
