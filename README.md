<div align="center">

# Screencast MCP

**An MCP server that lets an agent record the screen, _watch_ the footage, and make minimal ffmpeg edits — over stdio, on Windows.**

Capture the desktop, a monitor, a window, or a region; sample a recording into frames the agent can actually look at; trim, crop, redact, annotate, zoom toward clicks, and export for GitHub or social. No cloud service, no telemetry: ffmpeg and ffprobe behind <!--tool-count-->58<!--/tool-count--> typed tools.

**For developers who want their coding agent to see and prove UI changes on Windows**: bug repros, UI verification, and demo clips the agent records, checks, and edits itself. Capture is Windows-only; the watch and edit tools work on any OS with ffmpeg. Free for non-commercial use ([CC BY-NC-ND 4.0](#license)); [why not OBS, Playwright, or a screenshot MCP?](#why-not-just)

<br />

[![Documentation](https://img.shields.io/badge/Documentation-2D7FF9?style=for-the-badge&logo=readthedocs&logoColor=white)](https://tmhsdigital.github.io/screencast-mcp/)

<br />

[![npm](https://img.shields.io/npm/v/@tmhs/screencast-mcp?color=CB3837&logo=npm)](https://www.npmjs.com/package/@tmhs/screencast-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-6E56CF)](https://registry.modelcontextprotocol.io/v0/servers?search=screencast-mcp)
[![CI](https://github.com/TMHSDigital/screencast-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TMHSDigital/screencast-mcp/actions/workflows/ci.yml)
[![License: CC BY-NC-ND 4.0](https://img.shields.io/badge/license-CC--BY--NC--ND--4.0-green)](LICENSE)
![Last commit](https://img.shields.io/github/last-commit/TMHSDigital/screencast-mcp)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js_%E2%89%A522-339933?logo=node.js&logoColor=white)
![Model Context Protocol](https://img.shields.io/badge/MCP-stdio-6E56CF)
![ffmpeg](https://img.shields.io/badge/ffmpeg-required-007808?logo=ffmpeg&logoColor=white)
![Capture](https://img.shields.io/badge/capture-Windows_10%2F11-0078D6?logo=windows&logoColor=white)

<br />

<img src="https://raw.githubusercontent.com/TMHSDigital/screencast-mcp/main/docs/media/zoom-after.gif" width="480" alt="A settings window recorded by screencast-mcp: the camera glides in on the Save button as the cursor clicks it, a red ring marks the click, then the view eases back out as a green Saved banner appears." />

<sub>Made with the tool: <code>start_recording</code> with <code>events: true</code>, one click, then <code>zoom { highlightClicks: true }</code> and <code>export_gif</code>. <a href="https://tmhsdigital.github.io/screencast-mcp/workflows/zoom-clicks.html">How it was made</a> · <a href="https://tmhsdigital.github.io/screencast-mcp/workflows/">more workflows</a></sub>

[Quick start](#quick-start) · [Tools](#tools) · [Configuration](#configuration) · [Usage](#usage) · [Privacy](#privacy) · [Threat model](#threat-model)

</div>

## Quick start

**You need** Windows 10 or 11, [Node.js](https://nodejs.org) 22+, and **FFmpeg 8 or newer** on `PATH` (`winget install Gyan.FFmpeg`, the full build). Older builds run most tools, but `transcribe` (the `whisper` filter) and `backend: "wgc"` (`gfxcapture`) need FFmpeg 8, and essentials or distro builds can lack them (Ubuntu LTS `apt install ffmpeg` gives 6.x). Capture is Windows-only; the watch, edit, and produce tools work anywhere ffmpeg runs. After connecting, ask the agent to run `doctor`: it reports the ffmpeg version, the filters and devices it has, OCR, and anything missing.

**Add it to your client:**

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add screencast -- cmd /c npx -y @tmhs/screencast-mcp`, or the plugin (the server plus bug-repro, README-demo, and UI-verify skills): `/plugin install screencast --marketplace TMHSDigital/screencast-mcp` (older Claude Code: `/plugin marketplace add TMHSDigital/screencast-mcp`, then `/plugin install screencast@screencast-mcp`) |
| Claude Desktop | Download [`screencast-mcp.mcpb`](https://github.com/TMHSDigital/screencast-mcp/releases/latest/download/screencast-mcp.mcpb) from the latest release and open it (one click) |
| Cursor, VS Code, others | The JSON config below, or step-by-step on [Connect your client](https://tmhsdigital.github.io/screencast-mcp/connect.html) |

```json
{
  "mcpServers": {
    "screencast": { "command": "npx", "args": ["-y", "@tmhs/screencast-mcp"] }
  }
}
```

**Then ask your agent:**

> Record my VS Code window for five seconds while I reproduce the bug, then show me the frames where something changed.

More in the [workflows](https://tmhsdigital.github.io/screencast-mcp/workflows/): a bug-repro GIF for a PR, a README demo, a UI verification loop, a social clip, a cheap review of a long recording, zoom toward clicks, and the whole edit in one call.

## Overview

Screencast MCP gives an agent a screen recorder it can drive and reason about. It speaks [Model Context Protocol](https://modelcontextprotocol.io) over stdio and exposes ffmpeg as a small, typed tool surface rather than a flag soup. The defining capability is the **watch loop**: an agent records footage, samples it into PNG frames, and views those frames to confirm what actually happened on screen.

The design choices are deliberate rather than incidental:

- **Capture is always explicit.** A recording or screenshot happens only on a tool call — nothing auto-fires and there is no background or scheduled capture.
- **Footage is made viewable.** `sample_frames` turns a video into images returned straight to the model, so "watch what happened" is a first-class operation, not an afterthought.
- **Presets over raw flags.** Quality is `draft` / `standard` / `high`; the agent never reasons about codecs, CRF, or pixel formats.
- **Safe by default.** Output lands under `SCREENCAST_HOME`, never inside a project checkout, and the public repo's `.gitignore` blocks captured media from being committed.
- **Recordings end.** When the client disconnects (or the server gets SIGINT/SIGTERM), every active recording is finalized and the server exits. Every recording also has a `maxDurationSec` cap (default one hour). A recording interrupted by a hard crash is reconciled on the next start (orphan reaping).

What it can do beyond record-and-look:

- **Zoom toward clicks.** Record with `events: true` and `zoom` glides in on each click and rings it, Screen Studio style.
- **Review before sharing.** In clients with MCP Apps, `review_recording` opens an inline player where a person trims and draws redaction boxes.
- **Find and cover secrets.** `find_text` reads the screen with Windows OCR and returns rectangles for `redact_region`.
- **One call, one encode.** `pipeline` runs trim, crop, redact, callouts, and an export as a single ffmpeg pass; `recipe: "tutorial"` turns a raw recording into a cut, zoomed, normalized, captioned mp4.
- **Record a covered window.** `backend: "wgc"` records a window's own surface through Windows Graphics Capture.

### Why not just...

| Instead of | The difference |
| --- | --- |
| OBS, ShareX, Game Bar | Built for a person at the controls. Here the agent starts and stops the recording, looks at the frames, and makes the edits through typed tools, with no GUI step. |
| Playwright or Puppeteer video | Browser pages only, and the video is a file the model never sees. Here: any window or monitor, frames returned to the model, plus `wait_for_change`, `find_text`, and `screen_diff` for checking what happened. |
| A screenshot-only MCP server | Single stills. Here: video over time, an input event log, scene-change sampling, redaction, and export, so the agent can show a sequence, not one moment. |

## Tools

<!-- tools:start -->
58 tools in 6 toolsets, generated from the server's own schemas by `npm run docs` (do not edit between the markers). Each name links to its reference page with every parameter, an example call, and what it returns; [`mcp-tools.json`](mcp-tools.json) is the same list as JSON, and [`llms-full.txt`](https://tmhsdigital.github.io/screencast-mcp/llms-full.txt) all of it in one file.

### Core

Always loaded, whatever `SCREENCAST_TOOLSETS` selects.

| Tool | What it does |
| --- | --- |
| [`get_media_info`](https://tmhsdigital.github.io/screencast-mcp/tools/get_media_info.html) | Probe a media file with ffprobe and return duration, resolution, frame rate, codecs, container format, and size. |
| [`doctor`](https://tmhsdigital.github.io/screencast-mcp/tools/doctor.html) | Check the setup: ffmpeg/ffprobe (FFmpeg 8+?), optional filters, capture devices, Windows OCR, settings, and enabled toolsets; `problems` says what is missing and how to fix it. Call on first use or when a tool reports a missing feature. |

### Capture

Record or screenshot the desktop, a monitor, a window, or a region. Every capture is an explicit tool call: nothing records on its own.

| Tool | What it does |
| --- | --- |
| [`start_recording`](https://tmhsdigital.github.io/screencast-mcp/tools/start_recording.html) | Start a background screen recording. Returns a session id; finalize it with stop_recording. Never auto-starts. |
| [`stop_recording`](https://tmhsdigital.github.io/screencast-mcp/tools/stop_recording.html) | Stop a recording gracefully so the file is finalized; returns the path and duration. |
| [`pause_recording`](https://tmhsdigital.github.io/screencast-mcp/tools/pause_recording.html) | Pause a recording; until resume_recording nothing is captured, and the gap is left out of the file, events, and markers. |
| [`resume_recording`](https://tmhsdigital.github.io/screencast-mcp/tools/resume_recording.html) | Resume a paused recording (same target and settings). |
| [`save_replay`](https://tmhsdigital.github.io/screencast-mcp/tools/save_replay.html) | Save the last N seconds of a replay buffer (start_recording replayBufferSec) to an mp4; the buffer keeps running. |
| [`list_sessions`](https://tmhsdigital.github.io/screencast-mcp/tools/list_sessions.html) | List all recording sessions (active and finished) with their status, target, output path, and whether the process is still alive. |
| [`get_session`](https://tmhsdigital.github.io/screencast-mcp/tools/get_session.html) | Inspect a single recording session by id, including live status and whether its output file exists on disk. |
| [`read_events`](https://tmhsdigital.github.io/screencast-mcp/tools/read_events.html) | Read the input events (clicks, scroll, cursor, shortcuts, typing bursts) of a recording made with events: true, in video seconds and pixels; e.g. types: ['down'], then sample_frames there. |
| [`add_marker`](https://tmhsdigital.github.io/screencast-mcp/tools/add_marker.html) | Mark a labelled moment on a recording, live or at a second. Kept in the session and a sidecar; chapters and pipeline turn markers into chapters. |
| [`screenshot`](https://tmhsdigital.github.io/screencast-mcp/tools/screenshot.html) | Capture one PNG of the screen, a monitor, a window, or a region, returned inline and by path. |
| [`list_audio_devices`](https://tmhsdigital.github.io/screencast-mcp/tools/list_audio_devices.html) | List DirectShow audio devices and flag a likely loopback (Stereo Mix or a virtual-audio driver), for start_recording's audio.device. |
| [`list_video_devices`](https://tmhsdigital.github.io/screencast-mcp/tools/list_video_devices.html) | List DirectShow cameras for start_recording's webcam.device. |
| [`list_targets`](https://tmhsdigital.github.io/screencast-mcp/tools/list_targets.html) | List the desktop, monitors, and visible windows (topmost first, with capturability per backend). Each entry has a `target` string to pass as-is to capture tools; use it instead of guessing a title. |

### Watch

Turn footage into something a model can read: frames, contact sheets, diffs, OCR, and a searchable text timeline.

| Tool | What it does |
| --- | --- |
| [`review_recording`](https://tmhsdigital.github.io/screencast-mcp/tools/review_recording.html) | Open a recording for a person to review: in MCP Apps clients an inline player to scrub, trim, and redact, then export; elsewhere just the video's details. |
| [`player_frames`](https://tmhsdigital.github.io/screencast-mcp/tools/player_frames.html) | Preview frames for the review player: JPEGs on an even grid over the video plus frames at scene changes, with their real times. Used by the inline player; agents should use sample_frames or contact_sheet instead. *(app-only: called by the review player, not the agent)* |
| [`sample_frames`](https://tmhsdigital.github.io/screencast-mcp/tools/sample_frames.html) | Sample PNG frames from a video (by fps, timestamps, or scene changes) and return the first few inline so the model can see what happened. |
| [`contact_sheet`](https://tmhsdigital.github.io/screencast-mcp/tools/contact_sheet.html) | Tile timestamped frames of a video into one image to see a whole recording at a glance (the cheapest first look). |
| [`screen_diff`](https://tmhsdigital.github.io/screencast-mcp/tools/screen_diff.html) | Compare two screenshots or frames: SSIM score, changed share, and changed boxes in b's pixels, to check a UI change happened only where expected. |
| [`wait_for_change`](https://tmhsdigital.github.io/screencast-mcp/tools/wait_for_change.html) | Wait until part of the screen changes or settles, instead of guessing a sleep. Returns the elapsed time, changed regions (screenshot pixels; add `origin` for desktop), and the final state. |
| [`find_text`](https://tmhsdigital.github.io/screencast-mcp/tools/find_text.html) | OCR (built into Windows) on the screen, an image, or video frames, with line and match boxes in image pixels (add `origin` for desktop coordinates). Locate UI text or secrets (e.g. regex 'sk-\|ghp_\|api.?key') to redact. Best-effort: review results. |
| [`index_recording`](https://tmhsdigital.github.io/screencast-mcp/tools/index_recording.html) | Build a recording's text timeline (<video>.index.json: OCR per scene, events, markers, transcript) for search_recording. |
| [`search_recording`](https://tmhsdigital.github.io/screencast-mcp/tools/search_recording.html) | Search an index_recording timeline (screen text, events, markers, transcript): timecoded hits, best first, secrets masked. No frames unless asked. |

### Edit

Cut, convert, compress, and redact. A tool that writes a file refuses to replace an existing `output` unless `overwrite: true`; default output paths are always unique.

| Tool | What it does |
| --- | --- |
| [`trim`](https://tmhsdigital.github.io/screencast-mcp/tools/trim.html) | Cut a video down to one sub-clip by start + (end or duration). For several segments use clip; to combine with other edits use pipeline. |
| [`concat`](https://tmhsdigital.github.io/screencast-mcp/tools/concat.html) | Join videos end to end with hard cuts: stream copy when they match, else a re-encode (`mode` says which). For transitions use xfade_transition or assemble_highlights. |
| [`convert`](https://tmhsdigital.github.io/screencast-mcp/tools/convert.html) | Convert media to mp4, webm, or gif. For a size-bounded GIF/WebP prefer export_gif; for a smaller mp4, compress or export_preset. |
| [`export_gif`](https://tmhsdigital.github.io/screencast-mcp/tools/export_gif.html) | Export an animated GIF or WebP that fits a size budget (for PRs, issues, READMEs), stepping fps, width, and quality down until it fits. |
| [`crop`](https://tmhsdigital.github.io/screencast-mcp/tools/crop.html) | Crop a video to a pixel rectangle; one running off the frame is rejected. |
| [`scale`](https://tmhsdigital.github.io/screencast-mcp/tools/scale.html) | Resize a video to a target width and/or height and re-encode. Provide one side to keep the aspect ratio, or both to set an exact size. |
| [`speed`](https://tmhsdigital.github.io/screencast-mcp/tools/speed.html) | Change playback speed by a factor (>1 faster, <1 slower) and re-encode. Audio is retempo'd to match when the source has an audio track. |
| [`compress`](https://tmhsdigital.github.io/screencast-mcp/tools/compress.html) | Re-encode a video smaller (H.264 CRF ladder, optional width cap). For a platform target use export_preset. |
| [`clip`](https://tmhsdigital.github.io/screencast-mcp/tools/clip.html) | Extract several frame-exact segments, each to its own file. For one segment, trim does the same. |
| [`cut_idle`](https://tmhsdigital.github.io/screencast-mcp/tools/cut_idle.html) | Remove dead air: cut stretches where the screen is frozen (and silent), keeping a short pad. Returns the time saved. |
| [`cut_by_transcript`](https://tmhsdigital.github.io/screencast-mcp/tools/cut_by_transcript.html) | Edit a video by its transcript: cut quoted text, cue numbers, or fillers. Also writes the re-timed .srt. |
| [`redact_region`](https://tmhsdigital.github.io/screencast-mcp/tools/redact_region.html) | Cover given rectangles in a video (e.g. secrets on screen). Not automatic detection: find them with find_text redact: true. Off-frame regions are rejected. |
| [`pipeline`](https://tmhsdigital.github.io/screencast-mcp/tools/pipeline.html) | Run several edits (trim, crop, scale, speed, cut_idle, redact, callout, keystroke_overlay, cursor, reframe, zoom, backdrop, audio, burn_subtitles, then optionally export_preset or export_gif) in one ffmpeg pass: one re-encode, no intermediate files. Prefer it over chaining edit tools; a recipe does the usual polish in one call. |

### Produce

Annotate, frame, and assemble a finished piece. Tools that combine clips normalize each input to a common resolution, fps, and audio rate first.

| Tool | What it does |
| --- | --- |
| [`overlay`](https://tmhsdigital.github.io/screencast-mcp/tools/overlay.html) | Composite an image or video (logo, watermark, picture-in-picture) onto a video at a pixel position, optionally scaled and time-limited; keeps the base's audio and length. |
| [`callout`](https://tmhsdigital.github.io/screencast-mcp/tools/callout.html) | Annotate a video with timed boxes, text labels, and arrows. Fallback fonts used are listed in fallbackFonts; characters no font covers are reported in warnings. |
| [`keystroke_overlay`](https://tmhsdigital.github.io/screencast-mcp/tools/keystroke_overlay.html) | Burn keycast-style badges for shortcuts, clicks, and typing from the recording's input event log (start_recording events: true). Never shows typed text: the log has none. |
| [`cursor`](https://tmhsdigital.github.io/screencast-mcp/tools/cursor.html) | Draw a smoothed, scaled cursor that hides when idle from the event log of a start_recording cursor: "events" recording (no OS cursor in the video), with click ripples and an optional spotlight. |
| [`backdrop`](https://tmhsdigital.github.io/screencast-mcp/tools/backdrop.html) | Frame a video or screenshot on a gradient, color, or wallpaper with padding, rounded corners, and a drop shadow, optionally on a 16:9/1:1/9:16/4:5 canvas. |
| [`burn_subtitles`](https://tmhsdigital.github.io/screencast-mcp/tools/burn_subtitles.html) | Burn SRT/ASS subtitles (e.g. from transcribe) into a video in the bundled font. |
| [`chapters`](https://tmhsdigital.github.io/screencast-mcp/tools/chapters.html) | Write chapters (markers, scene changes, transcript, or a list) into an mp4/mkv/mov copy without re-encoding; returns YouTube chapter text. Can mux an SRT as soft subtitles. |
| [`xfade_transition`](https://tmhsdigital.github.io/screencast-mcp/tools/xfade_transition.html) | Join two videos with an xfade transition (audio crossfaded); they need not match in size, fps, or audio. For more clips use assemble_highlights. |
| [`assemble_highlights`](https://tmhsdigital.github.io/screencast-mcp/tools/assemble_highlights.html) | Stitch clips (including title cards) into one video with cuts or xfade transitions; they need not match in size, fps, or audio. |
| [`title_card`](https://tmhsdigital.github.io/screencast-mcp/tools/title_card.html) | Generate a title card clip (centered text on a solid background, silent audio track) to stitch in with assemble_highlights. Uncoverable characters are reported in warnings. |
| [`reframe`](https://tmhsdigital.github.io/screencast-mcp/tools/reframe.html) | Re-aspect a video to 16:9, 9:16, 1:1, or 4:5 by padding or cropping. |
| [`zoom`](https://tmhsdigital.github.io/screencast-mcp/tools/zoom.html) | Smooth animated zoom-and-pan into the action and back out, from keyframes or planned from logged clicks or screen changes. |
| [`export_preset`](https://tmhsdigital.github.io/screencast-mcp/tools/export_preset.html) | Encode a platform-ready H.264 file (aspect, fps, bitrate, faststart) for a named platform. |
| [`bug_report`](https://tmhsdigital.github.io/screencast-mcp/tools/bug_report.html) | Package a recording as a paste-ready repro folder: secret-scanned, redacted clip and GIF, contact sheet, steps from the event log, OCR'd errors, environment, report.md for gh issue create --body-file. |
| [`step_guide`](https://tmhsdigital.github.io/screencast-mcp/tools/step_guide.html) | Turn a recording's event log into a numbered how-to: a ringed screenshot and caption per step, marker headings; Markdown and/or one HTML file. Never includes typed text. |

### Audio

Extract, clean up, level, transcribe, and score the soundtrack.

| Tool | What it does |
| --- | --- |
| [`extract_audio`](https://tmhsdigital.github.io/screencast-mcp/tools/extract_audio.html) | Extract the audio track of a media file to its own file (mp3, aac, wav, or copy). Returns the output path. |
| [`normalize_audio`](https://tmhsdigital.github.io/screencast-mcp/tools/normalize_audio.html) | Normalize loudness to a delivery target (two-pass EBU R128 loudnorm); video is copied. Reports loudness before and after. |
| [`denoise`](https://tmhsdigital.github.io/screencast-mcp/tools/denoise.html) | Reduce steady background noise (fan, hum, hiss) in a recording's audio with an adaptive FFT denoiser. Video is copied untouched. Returns the output path. |
| [`transcribe`](https://tmhsdigital.github.io/screencast-mcp/tools/transcribe.html) | Transcribe a recording's speech to an SRT subtitle file, locally, with FFmpeg 8's whisper filter (needs a whisper.cpp model file). Returns the SRT path and the text. Pair with burn_subtitles to caption the video. |
| [`music_bed`](https://tmhsdigital.github.io/screencast-mcp/tools/music_bed.html) | Lay music under a video: looped or trimmed to length, faded, leveled, and mixed with any existing audio. Video is stream-copied. |
| [`narrate`](https://tmhsdigital.github.io/screencast-mcp/tools/narrate.html) | Offline voiceover with the built-in Windows voices: speaks each line at its time or marker over the audio, plus an SRT. |
<!-- tools:end -->

> [!IMPORTANT]
> `redact_region` covers the regions **you** declare. It is not automatic secret detection, so it cannot find a secret you did not point it at. The default `box` style is a solid fill, which is irreversible; `blur` and `pixelate` are softer but can be partially recovered, so prefer `box` for real secrets. They have minimum strengths: blur uses a radius of at least 8 px (or half the region's smaller side) applied three times, and pixelate uses blocks of at least 16 px. Coordinates are in the displayed frame, after any rotation the file carries, and `pipeline` refuses a `redact` placed after `zoom`. A region that falls outside the frame is rejected rather than silently doing nothing.

### Targets

Every capture tool takes a single `target` string, so an agent never has to juggle quoting:

| Target | Captures |
| --- | --- |
| `full` | The whole virtual desktop |
| `monitor:<index>` | One display; `0` is always primary |
| `window:<title>` | The on-screen rectangle a window occupies (case-insensitive exact title, else substring; topmost wins) |
| `window:exe=<app.exe>` | That app's topmost window, without relying on its title |
| `window:hwnd=<handle>` | One exact window by handle (hex `0x1A2B` or decimal) |
| `region:<x>,<y>,<w>,<h>` | An absolute pixel rectangle |

For `window:` targets, `screenshot` and `start_recording` both report `matchedWindow`, `matchCount`, `matchKind` (`exact`, `substring`, `exe`, or `hwnd`), and the captured `region`. When the title matched only as a substring, or several windows matched, the result carries a `windowWarning` listing the candidate titles, so a generic title like `window:Code` cannot quietly record a different window. Pass `exactTitle: true` to refuse the substring fallback entirely.

Output is written under `SCREENCAST_HOME` (default `<homedir>/.screencast-mcp`) into `recordings/`, `frames/`, `screenshots/`, and `edits/`. Any tool also accepts an explicit output path; a relative one resolves under that tool's `SCREENCAST_HOME` subfolder, never the server's working directory.

**Output confinement.** When the client sends workspace roots (the MCP `roots` capability), or `SCREENCAST_ALLOWED_DIRS` is set, an explicit output path (or `sample_frames` `outputDir`) must sit inside `SCREENCAST_HOME`, one of those roots, or one of those folders; anything else is refused with an error naming the allowed folders. The roots are re-read when the client reports they changed. With neither, any path you can write to is accepted, as before. `doctor` reports the folders in effect as `storage.allowedOutputDirs`.

Edit and produce tools write to a `<name>.partial.<ext>` file next to the output and rename it into place only when ffmpeg succeeds, so a failed, timed-out, or cancelled job never leaves a truncated file at `output`. The job timeout scales with the media's length (at least 10 minutes, or 4x the duration); set `SCREENCAST_JOB_TIMEOUT_MS` to override it. Clients that send a progress token get `notifications/progress` updates while a job runs, and cancelling the request stops ffmpeg.

## Configuration

`ffmpeg` and `ffprobe` must be on `PATH`, or pointed at with `FFMPEG_PATH` / `FFPROBE_PATH`; the server checks per call and returns an install hint if either is missing (macOS: `brew install ffmpeg`; Linux: `apt install ffmpeg`, for the non-capture tools; distro packages may predate FFmpeg 8, so `transcribe` needs a newer static build). `doctor` shows what the ffmpeg in use supports.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCREENCAST_HOME` | `<homedir>/.screencast-mcp` | Where recordings, frames, screenshots, and edits are written |
| `SCREENCAST_ALLOWED_DIRS` | none | `;`-separated folders explicit outputs may also go to; when set, or when the client sends roots, outputs outside `SCREENCAST_HOME`, the roots, and these folders are refused |
| `SCREENCAST_MAX_RECORDING_SEC` | `3600` | Default recording cap (`0` disables it) |
| `SCREENCAST_JOB_TIMEOUT_MS` | scales with length | Override the edit job timeout |
| `SCREENCAST_WHISPER_MODEL` | none | whisper.cpp model for `transcribe` |
| `SCREENCAST_RETENTION_DAYS` | off | Delete screenshots, frames, and leftover raw event logs older than this many days at startup (never recordings or edits) |
| `SCREENCAST_PS_TIMEOUT_MS` | 20000 (OCR 60000) | Limit for the PowerShell helpers that list monitors and windows and run OCR |
| `SCREENCAST_CONFIRM_CAPTURE` | off | Set to `1` to ask the user to confirm every live capture (`start_recording`, `screenshot`, `find_text` on a target, `wait_for_change`) through MCP elicitation; clients without elicitation are refused |
| `SCREENCAST_TOOLSETS` | `all` | Comma-separated toolsets to expose (`capture`, `watch`, `edit`, `produce`, `audio`); the rest are not loaded, which shrinks the tool list the agent pays for on every turn |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `PATH` lookup | Explicit ffmpeg / ffprobe binaries |

**Toolsets.** The full tool list (`tools/list`) is about 70 KB, roughly 17k tokens of context; `capture` alone is about 16 KB. Set `SCREENCAST_TOOLSETS` to load only the groups an agent needs, for example `capture,watch` for a QA agent that records and looks but never edits. `core` (`doctor`, `get_media_info`) is always on; unset, empty, `all`, or a value naming no known toolset loads everything, and unknown names are ignored with a warning (and listed by `doctor`).

<!-- toolsets:start -->
| Toolset | Tools |
| --- | --- |
| `capture` | `start_recording`, `stop_recording`, `pause_recording`, `resume_recording`, `save_replay`, `list_sessions`, `get_session`, `read_events`, `add_marker`, `screenshot`, `list_audio_devices`, `list_video_devices`, `list_targets` |
| `watch` | `review_recording`, `player_frames`, `sample_frames`, `contact_sheet`, `screen_diff`, `wait_for_change`, `find_text`, `index_recording`, `search_recording` |
| `edit` | `trim`, `concat`, `convert`, `export_gif`, `crop`, `scale`, `speed`, `compress`, `clip`, `cut_idle`, `cut_by_transcript`, `redact_region`, `pipeline` |
| `produce` | `overlay`, `callout`, `keystroke_overlay`, `cursor`, `backdrop`, `burn_subtitles`, `chapters`, `xfade_transition`, `assemble_highlights`, `title_card`, `reframe`, `zoom`, `export_preset`, `bug_report`, `step_guide` |
| `audio` | `extract_audio`, `normalize_audio`, `denoise`, `transcribe`, `music_bed`, `narrate` |
| `core` (always) | `get_media_info`, `doctor` |
<!-- toolsets:end -->

The server also sends MCP `instructions` at initialize: the record, look, edit workflow, which tool to reach for when, and the toolsets in effect, so each tool's own description stays short.

**Capture consent.** With `SCREENCAST_CONFIRM_CAPTURE=1`, each live capture first asks the user through the client (MCP elicitation), showing what will be captured: the matched window, the duration, the audio source, and the output path. Only the user can answer, not the model, so a prompt injection cannot approve its own capture. Declining, cancelling, or not answering within 5 minutes captures nothing. A client that does not support elicitation fails closed: the tool returns an error and nothing is captured.

**Log messages.** The server declares the MCP `logging` capability: ffmpeg warnings (dropped frames, a full audio buffer, a warning from an edit job that still succeeded) and a recording that ends on its own (cap reached, window closed, recorder crash) are sent as `notifications/message`, filtered by the level the client sets with `logging/setLevel`.

## Usage

**Workflows:** copy-paste recipes with the tool calls and real outputs are on the docs site: [bug-repro clip for a PR](https://tmhsdigital.github.io/screencast-mcp/workflows/bug-repro.html), [README demo GIF](https://tmhsdigital.github.io/screencast-mcp/workflows/demo-gif.html), [agent UI verification loop](https://tmhsdigital.github.io/screencast-mcp/workflows/verify-ui.html), [social clip](https://tmhsdigital.github.io/screencast-mcp/workflows/social-clip.html), [reviewing a long recording](https://tmhsdigital.github.io/screencast-mcp/workflows/review-recording.html), [zoom toward every click](https://tmhsdigital.github.io/screencast-mcp/workflows/zoom-clicks.html), and [the whole edit in one call](https://tmhsdigital.github.io/screencast-mcp/workflows/pipeline.html).

A typical watch loop — record, sample, look:

```jsonc
// 1. record a region for a few seconds
start_recording { "target": "region:0,0,1280,720", "quality": "draft" }
//    -> { "sessionId": "rec-…", "outputPath": "…/recordings/rec-….mp4" }

// 2. finalize the file
stop_recording { "sessionId": "rec-…" }
//    -> { "durationSec": 4.2, "finalizedGracefully": true }

// 3. look at it: the frames come back inline, so the model sees them directly
sample_frames { "input": "…/recordings/rec-….mp4", "timestamps": [0.5, 2, 3.5] }
//    -> { "frames": ["…/frames/…/frame_000_0.5s.png", …], "inlineImages": 3 }
//       + 3 image blocks the client shows to the model
```

Don't know where to look? `sample_frames { "input": "…", "mode": "scenes" }` returns only the frames where the screen actually changed (plus the opening frame), with their `frameTimes`. Screen recordings are mostly static, so this is usually far cheaper than a fixed rate. `sceneThreshold` (default 0.1) sets how big a change counts, and in `fps` mode `dedupe: true` drops near-identical frames.

`screenshot { "target": "window:My App" }` is the one-shot equivalent for a still, and also returns the image inline.

Catching a flaky failure: the useful footage is the half minute before the test failed, and by then it is too late to start recording. Run an instant-replay buffer instead and save it when something goes wrong:

```jsonc
// 1. keep a rolling 60 s buffer for the whole test loop (maxDurationSec 0 = no cap)
start_recording { "target": "window:My App", "replayBufferSec": 60, "maxDurationSec": 0, "events": true }
//    -> { "sessionId": "rec-…", "replay": { "bufferSec": 60, "segmentSec": 2 } }

// 2. a run fails: keep the last 30 s; the buffer keeps running for the next failure
save_replay { "sessionId": "rec-…", "lastSec": 30 }
//    -> { "outputPath": "…/recordings/replay-….mp4", "durationSec": 30, "eventsPath": "…/replay-….events.jsonl" }

// 3. done: stop and discard the buffer (save: true would write the whole buffer)
stop_recording { "sessionId": "rec-…" }
```

The buffer is a ring of 2 s MPEG-TS segments under `SCREENCAST_HOME/replay`, so disk use stays at about the buffer length plus 6 s however long it runs (the same bitrate as an ordinary recording of that target). Encoding costs the same CPU as an ordinary recording. A save snapshots the segments it needs, joins them and cuts with a stream copy, so it returns in about a second; the clip can hold up to 2 s of earlier frames behind an edit list (pass `reencode: true` for a frame-exact file). Buffers no live recording owns are deleted when the server starts.

Filing the bug an agent just reproduced (record with `events: true` so the clicks become steps):

```jsonc
bug_report { "sessionId": "rec-…", "title": "Save fails on a read-only folder", "expected": "The file saves or a clear error" }
//    -> { "outputDir": "…/edits/bug-report-…", "reportPath": "…/report.md", "steps": 6,
//         "errors": ["Error: Access to the path is denied."], "redaction": { "found": 1, … } }
// review report.md and the returned contact sheet, then:
gh issue create --title "Save fails on a read-only folder" --body-file …/report.md
```

Documenting a task as a how-to (record with `events: true`; `add_marker` between phases gives section headings):

```jsonc
step_guide { "sessionId": "rec-…", "title": "Export a report as PDF" }
//    -> { "outputDir": "…/edits/step-guide-…", "markdownPath": "…/guide.md", "htmlPath": "…/guide.html",
//         "steps": [{ "n": 1, "caption": "Click File", "section": "Open the report", "image": "step-01.png" }, …] }
```

Inline images are downscaled JPEGs (`maxImageWidth`, default 1280) and capped per call (`maxInlineImages`, default 8, max 20); the full-resolution PNGs stay on disk. Pass `returnImage: false` / `returnImages: false` to get paths only.

`sample_frames` writes at most `maxFrames` frames per call (default 100, max 1000). In `fps` mode it probes the video first; if the rate would exceed the cap, it samples at a lower rate so the frames still span the whole video, and the result's `capNote` says what it did.

### Command line and CI

The same binary is a headless CLI when the first argument is a subcommand (no arguments still starts the MCP server). `record` records the screen while a command runs, exits with that command's code, and on failure writes a GIF of the last 30 s and a contact sheet:

```bash
npx -y @tmhs/screencast-mcp record --target full -- npm run test:e2e
npx -y @tmhs/screencast-mcp call doctor                # any tool, JSON args inline or @file.json
```

`record` options: `--target`, `--fps`, `--out` (default `screencast-evidence`), `--artifacts failure|always|never`, `--last <sec>`, `--no-gif`, `--no-contact-sheet`, `--discard-on-success`, `--max-duration`; it writes `evidence.json` alongside. For GitHub Actions on `windows-latest`, the composite action in [`action.yml`](action.yml) wraps it and uploads the evidence as an artifact:

```yaml
- uses: TMHSDigital/screencast-mcp@main # pin a release tag or SHA
  with:
    command: npm run test:e2e
    target: window:exe=MyApp.exe
```

More on the [CI page](https://tmhsdigital.github.io/screencast-mcp/ci.html).

## Prompts and resources

Beyond tools, the server offers **prompts**: ready-made workflows that clients such as Claude Code and VS Code show as slash commands.

| Prompt | What it does |
| --- | --- |
| `bug-repro-clip` | Record, find the bug moment, check for secrets, trim, annotate, and export a GIF for an issue. |
| `file-bug-report` | Record a repro with input events, package it with `bug_report` (redacted clip, GIF, steps, error text, `report.md`), review it, and file it with `gh issue create` once you confirm. |
| `document-steps` | Record a task with input events and markers, turn it into a step-by-step guide with `step_guide`, and tidy the captions. |
| `demo-gif` | Record a feature walkthrough and export a GIF small enough for a README or PR. |
| `verify-ui-change` | Screenshot before, make the change, wait for the screen to settle, diff, and confirm the text. |
| `review-recording` | Summarize what happens in a recording, with timestamps. |

It also offers **resources**, so a client can list and attach recordings without a filesystem tool: `screencast://sessions` (every session), `screencast://sessions/{id}` (one session), and `screencast://sessions/{id}/poster` (a JPEG preview frame). Clients are notified when a recording starts or stops.

## Windows notes

- **Multi-monitor offsets.** `gdigrab` has no "capture monitor N" selector, so a monitor target captures the whole virtual desktop and crops to that display's pixel bounds (from `System.Windows.Forms.Screen.AllScreens`). `monitor:1` grabs the second display at its real offset; `monitor:0` is always primary.
- **Window capture** resolves the window to the on-screen **rectangle** it occupies and captures that, rather than the window's own surface — `gdigrab`'s native `title=` grab returns a blank frame for GPU- or DirectComposition-composited windows (Chrome, Electron, UWP). Target it by title, or without relying on the title by `window:exe=Code.exe` (that app's topmost window) or `window:hwnd=0x1A2B` (one exact window); results report the matched title. The window must be **visible, on top, and not minimized** (a minimized window is rejected with a clear error), the capture includes anything drawn over that rectangle, and for `start_recording` the rectangle is fixed **once at start**. Use `backend: "wgc"` (below) to capture the window itself instead.
- **Windows Graphics Capture (`backend: "wgc"`, FFmpeg 8+).** Captures a window's **own surface** by handle, even when other windows cover it. On `screenshot` and `find_text` it takes 1-2 s instead of ~0.2 s, so it is opt-in. On `start_recording` it records the window's client area while it is covered, moved, or in the background. `gfxcapture` only emits a frame when the window presents, so a small recorder process repaints one pixel of the window every 200 ms and repeats the latest frame at the requested fps; it stops on `q` like ffmpeg, so `stop_recording` and `maxDurationSec` work the same. The first frame takes a second or two, and `start_recording` returns once it is captured. No audio with `wgc` yet.
- **Fullscreen-exclusive apps** often produce black frames under `gdigrab`; run the source in borderless-windowed mode for reliable capture.
- **System audio needs a loopback device.** `gdigrab` is video-only, so `start_recording` with `audio.source` = `system` captures from a separate dshow input. Windows has no native loopback, so this needs a virtual-audio device (enable Stereo Mix, or install a driver such as screen-capture-recorder's `virtual-audio-capturer` or VB-CABLE). Run `list_audio_devices` to find it. Microphone capture is intentionally not supported.
- **Windows on ARM64.** CI runs the unit, ffmpeg-integration and gdigrab capture-smoke suites on a native `windows-11-arm` runner with arm64 Node. gyan.dev has no arm64 build; CI uses [BtbN's](https://github.com/BtbN/FFmpeg-Builds/releases) FFmpeg 8.1 `winarm64-gpl-shared` build (from a month-end `autobuild-*` release, which are kept), which has `gdigrab`, `gfxcapture` (WGC) and `drawtext` but is built without whisper and libvpx: `transcribe` and `.webm` output need another build. Run `node scripts/platform-probe.mjs` after `npm run build` to see what your machine supports (`doctor` now reports `arch`).

## Privacy

- **The server makes no network requests and has no telemetry.** It runs ffmpeg, ffprobe, and PowerShell on your machine and talks to your MCP client over stdio. OCR (`find_text`) and speech (`narrate`) use the engines built into Windows, so screen text and narration scripts are processed locally and never sent anywhere.
- **What a tool returns goes to your model provider.** Inline screenshots and frames, OCR text, event summaries, and every other tool result reach your agent, and your client sends them to the model like any other tool result. Files on disk stay on disk unless a tool returns them or you share them.
- **What is stored, and where.** Everything goes under `SCREENCAST_HOME` (default `<homedir>/.screencast-mcp`) unless a call names another path:
  - `recordings/`: recordings, plus each one's `.events.jsonl` when the event log is on
  - `screenshots/`: `screenshot` output, and `find_text` / `wait_for_change` captures only with `keep: true`
  - `frames/`: `sample_frames` and `contact_sheet` output
  - `edits/`: edit and produce output
  - `sessions.json`: the session registry (ids, targets, paths, times)

  `find_text`, `wait_for_change`, and `screen_diff` delete their captures after the call by default, since a secret scan's screenshot shows the secret.
- **What the event log records.** Only with `start_recording` `events: true` (or `cursor: "events"`, which also leaves the OS cursor out of the video for the `cursor` tool to redraw), and only while that recording runs. Mouse input is recorded system-wide, not only over the recorded window: clicks, scrolls, and the cursor position (sampled about 30 times a second), each with its time. Typing is recorded only as bursts, a start time and a length on a 0.5 s grid, with no key names and no per-key times: `masked` (default) records nothing more. `shortcuts` also records chords made with Ctrl, Alt, or Win by name (`Ctrl+S`), with their times; Ctrl+Alt+key that types a character on AltGr layouts stays typing. No mode records typed text. If the log has gaps (Windows removed the hook, input went to an elevated window or the lock screen, or the helper stopped), `read_events` reports `truncated: true` and lists them.
- **Microphone capture is not supported.** System audio is recorded only with `audio.source` = `system`.
- **Deleting stored data.** Delete files under `SCREENCAST_HOME`, or the whole folder while nothing is recording. Set `SCREENCAST_RETENTION_DAYS` to delete screenshots, frames, and leftover raw event logs older than that each time the server starts. Recordings and edits are never deleted automatically.

## Threat model

> [!WARNING]
> Screen capture can record **anything** on screen at the moment of capture — passwords, tokens, private messages, and other secrets. `window:` captures the screen rectangle a window occupies, so overlays, notifications, or another window drawn over it are captured too. Treat recordings, screenshots, and sampled frames as sensitive by default.

- **Capture is always explicit.** Nothing auto-fires; capture is gated behind an explicit tool call. Set `SCREENCAST_CONFIRM_CAPTURE=1` to also require the user's confirmation, through the client, before each live capture (see [Configuration](#configuration)).
- **The server makes no network requests.** Files are written to the local filesystem only. What a tool returns to your agent (frames, OCR text, event summaries) is sent to your model provider like any other tool result; see [Privacy](#privacy).
- **Public repo, private captures.** The `.gitignore` blocks recordings, frames, screenshots, and common video/image output so test media cannot be committed by accident.
- **Review before sharing.** Sample frames or inspect a recording before handing a file to another tool or person, so you know what it contains. In clients that support MCP Apps, `review_recording` opens an inline player where a person can scrub the whole recording and draw redaction boxes before anything leaves the machine. The player gets frames through the MCP connection; no local web server is started.
- **Redaction covers what you declare.** `redact_region` covers only the rectangles you specify. `find_text` can help find them: OCR with a query such as `regex: "sk-|ghp_|api.?key"` and `redact: true` returns ready-made rectangles, and `scanEverySec` checks a whole video rather than one frame. But OCR is best-effort; it can miss small or stylised text, so treat it as an aid, not a guarantee. Use the default `box` style for a solid irreversible fill, and still review the output before sharing.
- **The input event log never records what you type.** `start_recording` `events: true` hooks mouse and keyboard input system-wide for that recording only, in a helper that exits with it (or with the server). Typing is logged only as bursts on a 0.5 s grid, never key by key, so the log does not reveal which keys were pressed, how many, or their timing. `keys: "shortcuts"` also names chords held with Ctrl, Alt, or Win (`Ctrl+S`). Cursor positions and clicks still reveal what you pointed at, so treat `.events.jsonl` like the recording beside it. See [Privacy](#privacy) for exactly what each mode records.
- **System audio is sensitive too.** When `audio.source` = `system`, the recording captures everything playing on the machine (call audio, notifications, media). Treat audio-bearing recordings with the same care as the video.

## Project structure

```
.
├── src/
│   ├── index.ts          # MCP server entry (stdio); registers every tool, reaps orphans
│   ├── cli.ts            # headless CLI: record -- <command>, call <tool>
│   ├── prompts.ts        # MCP prompts (workflows as slash commands)
│   ├── resources.ts      # MCP resources (sessions, posters)
│   ├── wgcRecorder.ts    # recorder process for backend: "wgc"
│   ├── tools/            # one file per tool
│   ├── utils/            # pure builders and helpers (ffmpeg args, targets, sessions, ...)
│   └── __tests__/        # vitest: unit, ffmpeg integration, guarded local-capture harness
├── assets/               # bundled fonts and the review player (assets/ui)
├── docs/                 # GitHub Pages site; tools/, llms.txt, and the recipe pages are generated
├── scripts/              # Claude Desktop bundle (.mcpb) and the docs generators (npm run docs)
├── plugin/               # Claude Code plugin: the server plus workflow skills
├── action.yml            # GitHub Action: record a test run on windows-latest
├── mcp-tools.json        # tool manifest, generated from the registry by npm run docs
├── server.json           # MCP Registry listing (name matches package.json mcpName)
├── .github/workflows/    # CI, release, npm publish, Pages, ecosystem drift check
├── ROADMAP.md · CONTRIBUTING.md · SECURITY.md · LICENSE
└── package.json
```

## Development

```bash
git clone https://github.com/TMHSDigital/screencast-mcp.git
cd screencast-mcp
npm install
npm run build      # tsc -> dist/
npm test           # vitest: unit tests, plus the ffmpeg integration suite when ffmpeg is on PATH
npm run dev        # tsx watch
npm run docs       # regenerate mcp-tools.json, the tool tables, docs/tools/, llms.txt
```

The tool tables in this README and on the site, `mcp-tools.json`, and the per-tool pages are generated from the registered tools' schemas; after adding or changing a tool, run `npm run docs` (the docs test fails on a stale copy; `npm run docs:check` checks without writing).

To run your build from a client, point it at `dist/index.js`: `"command": "node"`, `"args": ["C:/path/to/screencast-mcp/dist/index.js"]`.

The integration suite (`src/__tests__/integration`) runs the real edit and produce builders through ffmpeg against lavfi-generated fixtures and checks the probed result (durations, dimensions, streams, loudness). It skips when ffmpeg is missing; set `REQUIRE_FFMPEG=1` to make a missing ffmpeg fail instead, as CI's Linux job does.

The capture path can't be exercised on CI's headless Linux runners, so an end-to-end harness lives behind a flag and is skipped by default:

```bash
RUN_LOCAL_CAPTURE_TESTS=1 npm test   # Windows + ffmpeg + a real display
```

Agent evals (`evals/`) score tool selection, argument validity and outcomes on scripted tasks against lavfi-generated fixtures, through the built server over MCP. The default oracle mode replays known-good calls and needs no model or network; `--agent anthropic` runs a real model (install the SDK ad hoc with `npm install --no-save @anthropic-ai/sdk`; `EVAL_MODEL` defaults to `claude-sonnet-5-5`). Live-capture tools are always blocked.

```bash
npm run build && npm run eval                  # oracle mode
npm run eval -- --agent anthropic --json evals/results/baseline.json
```

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through [SECURITY.md](SECURITY.md).

## License

Released under the [CC-BY-NC-ND-4.0](LICENSE) license: free to use and share for non-commercial purposes, with attribution and without modification. For other uses, [open an issue](https://github.com/TMHSDigital/screencast-mcp/issues).

**Can I use it at work?** Only for non-commercial purposes under this license. If your use is commercial (inside a paid product or service, or work done mainly for commercial advantage), or you are not sure, [open an issue](https://github.com/TMHSDigital/screencast-mcp/issues) to ask about a commercial license. The licensing model is described in the [TMHSDigital licensing standard](https://github.com/TMHSDigital/Developer-Tools-Directory/blob/main/standards/licensing.md).

<div align="center">
<br />

[**Documentation**](https://tmhsdigital.github.io/screencast-mcp/) · [**Roadmap**](ROADMAP.md) · [**Report an issue**](https://github.com/TMHSDigital/screencast-mcp/issues) · [**License**](LICENSE)

<sub>Built by <a href="https://github.com/TMHSDigital">TMHSDigital</a> · <a href="#screencast-mcp">Back to top ↑</a></sub>

</div>
