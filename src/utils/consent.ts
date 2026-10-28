/**
 * Opt-in capture consent (#222). With SCREENCAST_CONFIRM_CAPTURE set, every
 * live capture (start_recording, screenshot, find_text on a target,
 * wait_for_change) first asks the user through MCP elicitation, showing what
 * will be captured. The model cannot answer an elicitation, so a prompt
 * injection cannot approve its own capture. A client without elicitation
 * fails closed: nothing is captured.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScreencastError } from "./errors.js";

export const CONFIRM_CAPTURE_ENV = "SCREENCAST_CONFIRM_CAPTURE";

/** How long the user has to answer before the capture is refused. */
export const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/** True when SCREENCAST_CONFIRM_CAPTURE is 1/true/yes/on. */
export function confirmCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env[CONFIRM_CAPTURE_ENV] ?? "").trim().toLowerCase());
}

/** A capture target as the user should see it: the matched window's title
 * rather than the query that found it. */
export function describeTarget(target: string, window?: { matchedTitle: string }): string {
  if (window) return `window "${window.matchedTitle}"`;
  return target === "full" ? "the full screen (all monitors)" : target;
}

/**
 * Ask the user to approve a capture, when SCREENCAST_CONFIRM_CAPTURE is on.
 * Resolves on approval; throws a ScreencastError on decline, cancel, timeout,
 * or a client that cannot ask. A no-op when the setting is off.
 */
export async function confirmCapture(server: McpServer, request: string, signal?: AbortSignal): Promise<void> {
  if (!confirmCaptureEnabled()) return;
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    throw new ScreencastError(
      `Capture blocked: ${CONFIRM_CAPTURE_ENV} requires the user to confirm each capture, ` +
        "but this client does not support MCP elicitation. Nothing was captured.",
      `Use a client that supports elicitation, or unset ${CONFIRM_CAPTURE_ENV} to capture without confirmation.`,
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
      `Capture blocked: the confirmation request failed (${err instanceof Error ? err.message : String(err)}). Nothing was captured.`,
    );
  }
  if (action !== "accept") {
    throw new ScreencastError(`Capture ${action === "decline" ? "declined" : "cancelled"} by the user. Nothing was captured.`);
  }
}
