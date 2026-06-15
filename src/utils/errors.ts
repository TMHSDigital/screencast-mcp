/**
 * Shared error type and MCP response helpers.
 *
 * Every tool returns the same content shape: a single text block. Errors are
 * surfaced as `isError: true` so an agent sees an actionable message instead of
 * a transport-level failure.
 */

export class ScreencastError extends Error {
  /** Optional remediation hint shown to the caller (e.g. an install command). */
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ScreencastError";
    this.hint = hint;
  }
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  // The MCP SDK's CallToolResult carries an index signature; mirror it so our
  // helpers are structurally assignable to a tool callback's return type.
  [key: string]: unknown;
}

/** Wrap a JSON-serializable value as a successful tool result. */
export function okResponse(value: unknown): ToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Wrap any thrown value as an error tool result, appending a hint if present. */
export function errorResponse(error: unknown): ToolResult {
  let message: string;
  if (error instanceof ScreencastError) {
    message = error.hint ? `${error.message}\n\n${error.hint}` : error.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  return { content: [{ type: "text", text: message }], isError: true };
}
