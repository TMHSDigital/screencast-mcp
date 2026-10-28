/**
 * MCP prompts (#126): ready-made workflows that clients surface as slash
 * commands, so a user can run a whole job without knowing the tools. Each
 * prompt returns one user message spelling out the tool sequence.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const message = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** The workflow texts, exported so tests can check they name real tools. */
export const PROMPT_TEXT = {
  bugReproClip: (target: string, notes: string) =>
    `Record a short bug-reproduction clip of ${target}.${notes ? ` The bug: ${notes}.` : ""}

1. start_recording { target: "${target}", quality: "standard" }, then tell me to reproduce the bug (or reproduce it yourself if you can drive the app), and stop_recording when done.
2. sample_frames { input: <recording>, mode: "scenes" } to see what happened, and describe the moment the bug appears.
3. find_text { input: <recording>, scanEverySec: 1, query: "sk-|ghp_|api.?key|token|password", regex: true, redact: true } to check the whole clip, not one frame. If anything sensitive shows up, redact_region its redactRegions (each has its own start/end) with style "box" before sharing. OCR can miss text, so also look at the frames yourself.
4. trim (or clip) to the few seconds around the bug, and callout to box or point at it.
5. export_gif { input: <clip>, maxBytes: 10000000 } so it can be pasted into an issue or PR.
Report the final file path, what the clip shows, and anything you redacted. (To file it as an issue, bug_report does steps 3-5 in one call and writes report.md.)`,

  fileBugReport: (target: string, notes: string, expected: string) =>
    `File a bug report for ${target}, with a redacted repro package.${notes ? ` The bug: ${notes}.` : ""}${expected ? ` Expected: ${expected}.` : ""}

1. start_recording { target: "${target}", events: true } so clicks and shortcuts are logged as repro steps, then reproduce the bug (or ask me to), and stop_recording right after it shows.
2. contact_sheet { input: <recording> } and find the moment it goes wrong; note its time.
3. bug_report { sessionId: <session id>, title: <one-line summary>, actual: <what happened>, expected: <what should happen>, clipSec: 30 } (or start/end around that moment). It scans the clip for secrets with OCR and boxes them out before writing the clip, GIF, contact sheet, steps, error text, and report.md.
4. Read report.md and look at the contact sheet it returns: check the steps make sense and that nothing sensitive is left (OCR can miss text; add regions and rerun with overwrite: true if so).
5. Only if I confirm, run gh issue create --title <title> --body-file <reportPath>, then attach the GIF to the issue.
Report the folder path, the steps, the error text found, and what was redacted.`,

  demoGif: (target: string, maxMB: string) =>
    `Make a demo GIF of ${target} for a README or PR, under ${maxMB} MB.

1. start_recording { target: "${target}" }, walk through the feature (or ask me to), then stop_recording.
2. contact_sheet { input: <recording>, mode: "scenes" } to see the whole run at a glance and pick the best stretch.
3. trim to that stretch (skip any audio steps: a GIF has no sound).
4. export_gif { input: <clip>, maxBytes: ${Math.round(Number(maxMB) * 1_000_000) || 10_000_000} }. If it does not fit, try format: "webp" or a shorter clip.
Report the file path, its size, and the settings export_gif chose.`,

  verifyUiChange: (target: string, expectation: string) =>
    `Verify a UI change in ${target}. Expected: ${expectation || "(describe what should change)"}.

1. screenshot { target: "${target}" } as the "before" image.
2. Make the change (run the action, reload, or ask me to).
3. wait_for_change { target: "${target}", mode: "settle" } so you check after the screen has finished updating, not mid-render.
4. screen_diff { a: <before>, b: <after> } and look at where it changed.
5. If the expectation mentions text, find_text { target: "${target}", query: <that text> } to confirm it is really on screen.
Say whether the change happened, whether anything changed that should not have, and show the evidence.`,

  reviewRecording: (path: string) =>
    `Review the recording at ${path} and tell me what happens in it.

1. get_media_info { input: "${path}" } for length and resolution.
2. contact_sheet { input: "${path}" } for an overview of the whole recording in one image.
3. sample_frames { input: "${path}", mode: "scenes" } to look closely at each change.
4. If there is on-screen text worth quoting, find_text on the relevant frame.
Give a timestamped summary of the main steps and anything that looks wrong.`,
};

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "bug-repro-clip",
    {
      title: "Record a bug reproduction",
      description: "Record a target, find the bug moment, redact secrets, trim, annotate, and export a GIF for an issue.",
      argsSchema: {
        target: z.string().optional().describe("What to record, e.g. window:My App (default: full)."),
        notes: z.string().optional().describe("What the bug is."),
      },
    },
    ({ target, notes }) => message(PROMPT_TEXT.bugReproClip(target || "full", notes ?? "")),
  );

  server.registerPrompt(
    "file-bug-report",
    {
      title: "File a bug report",
      description: "Record a repro with input events, then package it with bug_report: redacted clip, GIF, steps, error text, and report.md.",
      argsSchema: {
        target: z.string().optional().describe("What to record, e.g. window:My App (default: full)."),
        notes: z.string().optional().describe("What the bug is."),
        expected: z.string().optional().describe("What should happen instead."),
      },
    },
    ({ target, notes, expected }) => message(PROMPT_TEXT.fileBugReport(target || "full", notes ?? "", expected ?? "")),
  );

  server.registerPrompt(
    "demo-gif",
    {
      title: "Make a demo GIF",
      description: "Record a feature walkthrough and export a GIF small enough for a README or PR.",
      argsSchema: {
        target: z.string().optional().describe("What to record (default: full)."),
        maxMB: z.string().optional().describe("Size budget in MB (default 10)."),
      },
    },
    ({ target, maxMB }) => message(PROMPT_TEXT.demoGif(target || "full", maxMB || "10")),
  );

  server.registerPrompt(
    "verify-ui-change",
    {
      title: "Verify a UI change",
      description: "Screenshot before, make the change, wait for the screen to settle, diff, and check the text.",
      argsSchema: {
        target: z.string().optional().describe("What to watch (default: full)."),
        expectation: z.string().optional().describe("What should change."),
      },
    },
    ({ target, expectation }) => message(PROMPT_TEXT.verifyUiChange(target || "full", expectation ?? "")),
  );

  server.registerPrompt(
    "review-recording",
    {
      title: "Review a recording",
      description: "Summarize what happens in a recording, with timestamps, using a contact sheet and scene frames.",
      argsSchema: { path: z.string().describe("Path to the recording.") },
    },
    ({ path }) => message(PROMPT_TEXT.reviewRecording(path)),
  );
}
