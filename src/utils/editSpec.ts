/**
 * Re-renderable edits (#340). Each pipeline run writes the spec that made its
 * output, `<output>.edit.json`: the source (with its size and mtime, to tell
 * if it changed), the expanded steps, and the options. pipeline { fromEdit }
 * renders it again from the source, with any steps given replacing the
 * same-op steps, so a tweak never re-encodes an already encoded result, and
 * anyone can see which trims and redactions a clip went through.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { ScreencastError } from "./errors.js";
import type { PipelineStepInput } from "./pipelineStep.js";

export const EDIT_SPEC_VERSION = 1;

export interface EditSpec {
  version: number;
  tool: "pipeline";
  /** The server version that wrote it. */
  serverVersion: string;
  createdAt: string;
  source: { path: string; size: number; mtimeMs: number };
  output: string;
  /** Steps after a recipe was expanded and overrides applied. */
  steps: PipelineStepInput[];
  recipe?: string;
  quality?: "draft" | "standard" | "high";
  chapters?: boolean;
}

/** Where an output's spec lives. Pure. */
export function editSpecPath(output: string): string {
  return `${output}.edit.json`;
}

/** Parse and check a spec file's text. Pure. */
export function parseEditSpec(text: string, path = "the edit spec"): EditSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ScreencastError(`${path} is not valid JSON.`);
  }
  const s = raw as Partial<EditSpec>;
  if (s?.tool !== "pipeline" || typeof s.version !== "number" || !Array.isArray(s.steps) || typeof s.source?.path !== "string") {
    throw new ScreencastError(`${path} is not a pipeline edit spec.`);
  }
  if (s.version > EDIT_SPEC_VERSION) {
    throw new ScreencastError(`${path} was written by a newer version (spec ${s.version}).`, "Update screencast-mcp to re-render it.");
  }
  return s as EditSpec;
}

export function readEditSpec(path: string): EditSpec {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ScreencastError(`Edit spec not found: ${path}`);
  }
  return parseEditSpec(text, path);
}

/** The source's identity now, for a spec. */
export function sourceStamp(path: string): EditSpec["source"] {
  const st = statSync(path);
  return { path, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

/** Why the spec's source cannot be used any more, or null. */
export function sourceChange(spec: EditSpec): string | null {
  let now: EditSpec["source"];
  try {
    now = sourceStamp(spec.source.path);
  } catch {
    return `its source ${spec.source.path} is gone`;
  }
  if (now.size !== spec.source.size || now.mtimeMs !== spec.source.mtimeMs) return `its source ${spec.source.path} changed since`;
  return null;
}

export function writeEditSpec(output: string, spec: Omit<EditSpec, "version" | "tool" | "createdAt" | "output">): string {
  const path = editSpecPath(output);
  const full: EditSpec = { version: EDIT_SPEC_VERSION, tool: "pipeline", createdAt: new Date().toISOString(), output, ...spec };
  writeFileSync(path, JSON.stringify(full, null, 2) + "\n");
  return path;
}
