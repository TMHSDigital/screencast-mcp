/**
 * Shared tool annotations and output-schema helpers (#212).
 *
 * Annotations are hints a client uses to decide what needs a confirmation:
 * a read-only tool can be auto-approved, a destructive one gets a prompt. The
 * server makes no network requests, so nothing here is open-world.
 */
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads files, the screen, or the session registry; changes nothing the
 * caller owns. Scratch output (sampled frames, a kept OCR capture) goes to a
 * fresh path under SCREENCAST_HOME. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Writes a new file (a fresh path under SCREENCAST_HOME by default), and
 * `overwrite: true` lets it replace an existing one, so it is destructive.
 * Each call writes another file, so it is not idempotent. */
export const WRITES_FILE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Ends a running capture and finalizes its file; calling it again on a
 * stopped session just reports the final state. */
export const STOPS_SESSION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** An output schema that names the fields a tool always returns and allows
 * any others. Loose on purpose: a strict object would publish
 * `additionalProperties: false`, and clients reject any extra or optional
 * field the result carries. */
export function looseOutput<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape);
}

/** The common result of a tool that writes one file. */
export const OUTPUT_PATH = looseOutput({
  outputPath: z.string().describe("Path of the file written."),
});
