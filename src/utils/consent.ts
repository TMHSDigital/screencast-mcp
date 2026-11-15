/**
 * Capture consent (#222, #266). Every live capture (start_recording,
 * screenshot, find_text on a target, wait_for_change) first asks the user
 * through MCP elicitation, showing what will be captured. The model cannot
 * answer an elicitation, so a prompt injection cannot approve its own capture.
 *
 * SCREENCAST_CONFIRM_CAPTURE picks the mode:
 * - unset or `auto` (default): ask whenever the client supports elicitation;
 *   a client that cannot ask captures without a prompt.
 * - `1`/`true`/`yes`/`on`/`always`: ask every time, and fail closed (capture
 *   nothing) in a client that cannot ask.
 * - `0`/`false`/`no`/`off`/`never`: never ask.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage, ScreencastError } from "./errors.js";

export const CONFIRM_CAPTURE_ENV = "SCREENCAST_CONFIRM_CAPTURE";

/** How long the user has to answer before the capture is refused. */
export const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

export type ConfirmMode = "auto" | "always" | "off";

/** The consent mode from SCREENCAST_CONFIRM_CAPTURE (see the module comment).
 * Unrecognised values read as `auto`. */
export function confirmCaptureMode(env: NodeJS.ProcessEnv = process.env): ConfirmMode {
  const v = (env[CONFIRM_CAPTURE_ENV] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "always"].includes(v)) return "always";
  if (["0", "false", "no", "off", "never"].includes(v)) return "off";
  return "auto";
}

/** True when every confirmation is required, so a client that cannot ask is
 * refused rather than let through. */
export function confirmCaptureRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return confirmCaptureMode(env) === "always";
}

/** A capture target as the user should see it: the matched window's title
 * rather than the query that found it. */
export function describeTarget(target: string, window?: { matchedTitle: string }): string {
  if (window) return `window "${window.matchedTitle}"`;
  return target === "full" ? "the full screen (all monitors)" : target;
}

/**
 * Ask the user to approve a capture. Resolves on approval, and without asking
 * when the mode is `off` or (in `auto`) the client cannot ask. Throws a
 * ScreencastError on decline, cancel, timeout, or (in `always`) a client that
 * cannot ask.
 */
export async function confirmCapture(server: McpServer, request: string, signal?: AbortSignal): Promise<void> {
  const mode = confirmCaptureMode();
  if (mode === "off") return;
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    if (mode === "auto") return;
    throw new ScreencastError(
      `Capture blocked: ${CONFIRM_CAPTURE_ENV} requires the user to confirm each capture, ` +
        "but this client does not support MCP elicitation. Nothing was captured.",
      `Use a client that supports elicitation, or set ${CONFIRM_CAPTURE_ENV}=auto to capture without confirmation in clients that cannot ask.`,
    );
  }
  let action: string;
  try {
    ({ action } = await server.server.elicitInput(
      { message: request, requestedSchema: { type: "object", properties: {} } },
      { signal, timeout: CONFIRM_TIMEOUT_MS },
    ));
  } catch (err) {
    throw new ScreencastError(
      `Capture blocked: the confirmation request failed (${errorMessage(err)}). Nothing was captured.`,
    );
  }
  if (action !== "accept") {
    throw new ScreencastError(`Capture ${action === "decline" ? "declined" : "cancelled"} by the user. Nothing was captured.`);
  }
}
