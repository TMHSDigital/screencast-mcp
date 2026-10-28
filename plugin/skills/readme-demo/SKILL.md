---
name: readme-demo
description: Record a feature on the Windows screen and produce a polished demo for a README, release notes, or social post - an animated WebP or GIF under a size budget, with click zoom, keystroke badges, and a framed backdrop. Use when the user asks for a demo GIF, a README animation, a product clip, or a screen recording to show off a feature.
---

# README demo with screencast

Use the screencast MCP tools. Tell the user before you start recording.

## 1. Record

- `list_targets`, then `start_recording { "target": "<target from list_targets>", "fps": 30, "events": true, "keys": "shortcuts" }`. The event log drives click zoom and keystroke badges; typed text is never logged.
- Ask the user to perform the feature (or drive it yourself), then `stop_recording`.

## 2. Check the take

- `contact_sheet { "input": "<recording>", "mode": "scenes" }`: one image of every change. If the take is bad, record again now, before spending time on edits.

## 3. Polish in one call

The `pr_demo` recipe cuts dead air, zooms toward each logged click, and exports a GIF under 10 MB:

```
pipeline { "input": "<recording>", "recipe": "pr_demo", "dryRun": true }
```

Check the plan, then run it without `dryRun`. Override any step by passing your own of the same op, for example a smaller animated WebP framed on a backdrop:

```
pipeline { "input": "<recording>", "recipe": "pr_demo", "steps": [
  { "op": "keystroke_overlay" },
  { "op": "backdrop", "preset": "rec" },
  { "op": "export_gif", "format": "webp", "width": 720, "maxBytes": 3000000 } ] }
```

WebP is usually several times smaller than GIF and GitHub renders both. Other recipes: `tutorial` (adds audio cleanup and captions, 1080p mp4) and `social_reel` (9:16 with big captions).

## 4. Hand it over

- Reference it from the README: `![Saving settings](docs/demo.webp)`.
- Mention the size and settings `export_gif` reports. If the file is still large, lower `width` or `fps`, or trim first.

For a step-by-step written guide instead of an animation, use `step_guide { "input": "<recording>" }`: a numbered screenshot per click with OCR captions, as Markdown or one HTML page.
