---
name: bug-repro
description: Record a bug on the Windows screen and turn it into a paste-ready repro for a PR or issue - a redacted clip, a GIF under GitHub's size limit, a contact sheet, steps, and a report.md. Use when the user asks to record, capture, or show a bug, make a repro GIF or video, or file a bug report with a recording.
---

# Bug repro with screencast

Use the screencast MCP tools. Every capture is an explicit tool call; tell the user what you are about to record before you start.

## 1. Pick the target

- Call `list_targets` (filter with `exe` or `titleContains`) and pass the returned `target` string as-is, e.g. `window:hwnd=0x1A2B`. Don't guess a window title.
- Prefer one window over `full`: smaller files, and less on screen that could be secret.

## 2. Record the repro

- `start_recording { "target": "<target>", "fps": 15, "events": true }`. `events: true` logs clicks and shortcuts (never typed text), which `bug_report` turns into numbered steps.
- For a flaky bug, use `replayBufferSec: 60` instead and call `save_replay` right after it happens: only the last minute is kept.
- While it runs, `add_marker { "sessionId": "...", "label": "bug appears" }` at the moment it goes wrong.
- `stop_recording { "sessionId": "..." }`. Always stop it, even if something failed.

## 3. Package it

One call does the rest:

```
bug_report { "sessionId": "...", "title": "Save hangs", "actual": "Spinner never stops", "expected": "Saved banner within 1 s" }
```

It trims to the last 30 s (`start`/`end`/`clipSec` to change), runs a whole-clip OCR secret scan and boxes out API keys, tokens, and `password:` values in every output, exports a GIF under 10 MB (`maxBytes`), writes a contact sheet, steps from the event log, OCR'd error text, environment details, and `report.md`. Pass `regions` to box anything else sensitive.

## 4. Check before sharing

- Look at the contact sheet it returns. OCR is best-effort: `find_text { "input": "<clip>", "scanEverySec": 1, "query": "sk-|ghp_|api.?key", "regex": true }` re-checks the output, and `redact_region` covers what it missed.
- Then `gh issue create --title "..." --body-file <outputDir>/report.md`, or drop the GIF into the PR description.

## Doing it by hand

When the user wants control over each edit, one `pipeline` call replaces a chain of tools (one encode, no intermediate files):

```
pipeline { "input": "rec.mp4", "steps": [
  { "op": "redact", "regions": [ ...from find_text with redact: true... ] },
  { "op": "trim", "start": 0.5, "end": 5 },
  { "op": "callout", "items": [{ "type": "box", "x": 28, "y": 178, "width": 128, "height": 50, "from": 0.3, "to": 2.6 }] },
  { "op": "export_gif", "maxBytes": 2000000 } ] }
```

Redact first so it covers the whole clip. `dryRun: true` shows the plan.

If a tool reports a missing ffmpeg feature or OCR, run `doctor`.
