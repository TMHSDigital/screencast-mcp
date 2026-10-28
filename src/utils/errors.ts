/**
 * Shared error type and MCP response helpers.
 *
 * Every tool returns a JSON text block first; tools that produce frames may
 * append image blocks after it (#79). Errors are surfaced as `isError: true` so
 * an agent sees an actionable message instead of a transport-level failure.
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

export interface TextContent {
  type: "text";
  text: string;
}

/** A base64-encoded image block, shown to the model by MCP clients. */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolResult {
  content: Array<TextContent | ImageContent>;
  isError?: true;
  // The MCP SDK's CallToolResult carries an index signature; mirror it so our
  // helpers are structurally assignable to a tool callback's return type.
  [key: string]: unknown;
}

/** Wrap a JSON-serializable value as a successful tool result, optionally
 * followed by image blocks. An object value is also returned as
 * `structuredContent` (what a tool's outputSchema describes); the JSON text
 * block stays for clients that read only `content` (#212). */
export function okResponse(value: unknown, images: ImageContent[] = []): ToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result: ToolResult = { content: [{ type: "text", text }, ...images] };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // Parsed back from the text so the two can never disagree (undefined
    // fields dropped, Dates as strings).
    result.structuredContent = JSON.parse(text) as Record<string, unknown>;
  }
  return result;
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
