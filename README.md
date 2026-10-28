<div align="center">

# Screencast MCP

**An MCP server that lets an agent record the screen, _watch_ the footage, and make minimal ffmpeg edits — over stdio, on Windows.**

Capture the desktop, a monitor, a window, or a region; sample a recording into frames the agent can actually look at; trim, crop, redact, annotate, zoom toward clicks, and export for GitHub or social. No cloud service, no telemetry: ffmpeg and ffprobe behind 53 typed tools.

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
| Claude Code | `claude mcp add screencast -- cmd /c npx -y @tmhs/screencast-mcp` |
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

53 tools in six groups. The manifest in [`mcp-tools.json`](mcp-tools.json) is the canonical surface; tests keep it, this README, and the docs site in sync with `src/tools/`.

### Capture

| Tool | Purpose |
| --- | --- |
| `start_recording` | Start a background recording. `target` = `full` \| `monitor:<index>` \| `window:<title>` \| `region:<x>,<y>,<w>,<h>`; optional `fps`, `quality`, `audio` (set `audio.source` = `system` to also capture loopback audio), `maxDurationSec` (auto-stop cap, default 3600; `0` = none), and `events` (log clicks, scroll, cursor, and key presses to `<recording>.events.jsonl`; `keys` = `masked` by default or `shortcuts`), and `replayBufferSec` (instant replay: keep only the last N seconds, see `save_replay`). Returns a session id and output path. |
| `stop_recording` | Stop a session by id. Sends ffmpeg a graceful quit so the file is **finalized, not truncated**. Returns the final path and duration. On a replay buffer, `save: true` writes the whole buffer to the output path; otherwise the buffer is discarded. |
| `save_replay` | Instant replay: write the last `lastSec` seconds of a buffer started with `start_recording { "replayBufferSec": 60 }` to an mp4, without stopping it. A stream copy, so it returns in about a second; `reencode: true` for a frame-exact file. With `events: true` the event log is sliced to match. |
| `list_sessions` | List active and finished sessions. |
| `get_session` | Inspect a single session by id. |
| `review_recording` | **Review player** in clients that support MCP Apps: an inline player where a person scrubs the recording, drags trim handles, and draws redaction boxes, then exports a trimmed, redacted copy (one `pipeline` call). Pass it a stopped recording's `sessionId`. Elsewhere it returns the video's details. |
| `player_frames` | Preview JPEG frames for the review player (an even grid plus scene changes, labelled with their real times); called by the player (app-only), not by agents. |
| `read_events` | Read a recording's input event log (clicks, scroll, cursor, shortcuts, typing bursts) on the video's clock. Opt in with `start_recording` `events: true`. |
| `add_marker` | Stamp a labelled moment ("bug appears", "step 3") on a running recording's video clock, or at a given second of a stopped one or any file. Markers are kept in the session (survive `stop_recording`, shown by `get_session`) and in a `<video>.markers.json` sidecar; the review player shows them as ticks, and `chapters` / `pipeline` turn them into chapters. |
| `screenshot` | Capture a single PNG of a `target`, and return it inline as an image the model can view. |
| `list_audio_devices` | List the DirectShow audio devices ffmpeg can see and flag a likely system-audio loopback device for `start_recording`. |
| `list_targets` | List what can be captured: the desktop, each monitor (bounds, DPI scale), and each window (title, exe, pid, hwnd, bounds, minimized, cloaked, and whether gdigrab and `wgc` can capture it). Every entry carries a `target` string (`window:hwnd=<handle>` for windows) to pass as-is to `screenshot` or `start_recording`; filter with `exe` / `titleContains`. |
| `doctor` | Check the setup: ffmpeg/ffprobe path and version (FFmpeg 8+?), key filters (`whisper`, `gfxcapture`, `subtitles`, `drawtext`, ...), `gdigrab`/`dshow` devices, Windows OCR, `SCREENCAST_HOME`, and the env settings in effect, with a `problems` list naming each fix. |

### Watch

| Tool | Purpose |
| --- | --- |
| `sample_frames` | Extract frames from a video — at a fixed `fps`, at explicit `timestamps`, or only where the screen changed (`mode: "scenes"`) — so the agent can view what happened. Returns the frame paths, with the first few frames inline as images. |
| `contact_sheet` | Tile timestamped frames into **one** image (evenly spaced, or at the scene changes) so the agent sees a whole recording in a single look; returned inline. `poster: true` writes one representative frame instead. |
| `screen_diff` | Compare two screenshots/frames: SSIM score, share changed, and **bounding boxes of what changed**, with the changes outlined in an inline image. Verify a UI change happened, and only where expected. |
| `wait_for_change` | Watch a target and return when it **changes** (a dialog opened) or **settles** (a build or page finished), instead of guessing a sleep. Reports elapsed time, changed regions, and the final state inline. |
| `find_text` | **Read text** on screen or in a frame with the OCR engine built into Windows (no install): every line and match with its bounding box. Locate a button by its label, check what the screen says, or find secrets (`regex: "sk-|ghp_"`) and get `redact_region` rectangles with `redact: true`; `scanEverySec` checks a whole video, with a time window per match. Best-effort; review before relying on it. |
| `index_recording` | **Text timeline** of a recording (path or `sessionId`): cuts it at scene changes (with fill keyframes so no stretch over 10 s goes unread), OCRs one keyframe per segment, and attaches input events, markers, and transcript cues (an `.srt`, the `<video>.srt` sidecar, or `transcript: "whisper"`). Writes `<video>.index.json` next to the video (or under `SCREENCAST_HOME/edits/indexes` when that folder is outside the allowed output dirs); a re-run on an unchanged file reuses the OCR. The index holds the raw screen text, so treat it like the video. |
| `search_recording` | **Find a moment as text** in an indexed recording: "when did Save failed appear?" returns timecoded hits (segment `start`/`end` plus the exact time of a matching cue, marker, or event), best first, with secrets masked in the snippets. Plain queries tolerate OCR misreads; `regex: true` for patterns. No images unless `images: N` asks for small thumbnails of the top hits. |
| `get_media_info` | ffprobe wrapper: duration, resolution, fps, codecs, container format, and size. |

### Minimal edit

| Tool | Purpose |
| --- | --- |
| `trim` | Cut a sub-clip by `start` + (`end` or `duration`). Re-encodes by default so nothing before `start` stays in the file; `exact: false` stream-copies for speed. |
| `concat` | Join two or more videos into one. |
| `convert` | Convert between `mp4`, `gif`, and `webm`. |
| `export_gif` | Animated **GIF or WebP that fits a size budget** (default: GitHub's 10 MB image limit) for PRs, issues, and READMEs. Two-stage palette for GIF; steps fps, width, and palette/quality down until it fits, and reports the settings used. |

### Edit surface

These tools re-encode (a filter rewrites pixels, so stream copy does not apply). They reuse the same `draft`/`standard`/`high` presets as capture.

| Tool | Purpose |
| --- | --- |
| `crop` | Crop to a pixel rectangle (`x`, `y`, `width`, `height`). A rectangle that runs off the frame is rejected, not silently clamped. |
| `scale` | Resize to a `width` and/or `height`. One side keeps the aspect ratio; both set an exact size. |
| `speed` | Change playback speed by a `factor` (>1 faster, <1 slower). Audio is retempo'd when present. |
| `overlay` | Composite a logo, watermark, or picture-in-picture onto a base video at a position, optionally scaled and time-limited. |
| `callout` | **Timed annotations**: boxes, text labels, and arrows at any angle, each shown between two timestamps. Mark the bug, point at the button, caption a step. Text Inter can't draw (CJK, emoji, Arabic, Indic, ...) falls back to a Windows system font that covers it; `fontFile` picks one explicitly, and anything no font covers comes back in `warnings` instead of as silent boxes. |
| `compress` | Re-encode smaller with a `light`/`medium`/`heavy` CRF ladder and an optional `maxWidth` that only downscales. |
| `extract_audio` | Write the audio track to its own file (`mp3`, `aac`, `wav`, or `copy`). |
| `normalize_audio` | **Loudness to a delivery target** (two-pass EBU R128 `loudnorm`): `youtube` −14 LUFS, `podcast` −16, `broadcast` −23, or any LUFS value. Video is copied; reports loudness before and after. |
| `denoise` | Reduce **steady** background noise (fan, hum, hiss) with `afftdn`, tuned to the file's measured noise floor. Video is copied. |
| `transcribe` | **Speech to an SRT file, locally**, with FFmpeg 8's `whisper` filter (needs a whisper.cpp model: pass `model` or set `SCREENCAST_WHISPER_MODEL`). Cues are renumbered and de-overlapped; `words: true` gives one word per cue (whisper `max_len=1`) for `cut_by_transcript`. |
| `burn_subtitles` | Burn an SRT/ASS into the video in the bundled font: `clean` (outlined line) or `social` (big bold text on a dark box, for muted autoplay). |
| `chapters` | **Chapters without a re-encode**: from markers (the default), the strongest scene changes, transcript sections (an SRT split at pauses), or an explicit list, written into an mp4/mkv/mov copy as real chapters (FFMETADATA, stream copy; they show in VLC and MPC) and returned as YouTube chapter text, with any YouTube rule it breaks (first at 0:00, three or more, 10 s each). `subtitles` muxes an SRT as a soft, toggleable track (`mov_text` in mp4) instead of burning it in; `textOnly` writes nothing. |
| `clip` | Extract one or more frame-accurate sub-segments, each to its own file. For a single segment, `trim` (default `exact: true`) does the same. |
| `cut_idle` | **Remove dead air**: cut stretches where the screen is frozen and (when there is audio) silent, keeping a short pad at each edge. `dryRun` reports first; speech over a still screen is kept unless `useAudio: false`. |
| `cut_by_transcript` | **Edit by the transcript**: cut the lines you quote (`remove: ["exact words"]`, or cue numbers) and, with `fillers: true`, um/uh/erm, in one select/aselect pass that keeps audio and video in sync. Writes a re-timed `.srt` next to the video so `burn_subtitles` still lines up. Timing is as fine as the SRT: `transcribe { words: true }` gives one word per cue; with sentence cues a partial quote is placed by estimate (`exact: false`) and fillers inside a sentence are left in. `dryRun` returns the edited text first. |

### Redact

| Tool | Purpose |
| --- | --- |
| `redact_region` | Cover declared rectangles in a video. `style` is `box` (default, a solid irreversible fill), `blur`, or `pixelate`; each region may be limited to a `start`/`end` window and expanded with `pad`. |

> [!IMPORTANT]
> `redact_region` covers the regions **you** declare. It is not automatic secret detection, so it cannot find a secret you did not point it at. The default `box` style is a solid fill, which is irreversible; `blur` and `pixelate` are softer but can be partially recovered, so prefer `box` for real secrets. They have minimum strengths: blur uses a radius of at least 8 px (or half the region's smaller side) applied three times, and pixelate uses blocks of at least 16 px. Coordinates are in the displayed frame, after any rotation the file carries, and `pipeline` refuses a `redact` placed after `zoom`. A region that falls outside the frame is rejected rather than silently doing nothing.

### Produce

The production layer turns raw clips into a finished piece. Tools that combine clips auto-normalize each input to a common resolution, fps, and audio rate first, so heterogeneous sources compose cleanly.

| Tool | Purpose |
| --- | --- |
| `xfade_transition` | Crossfade two videos into one with an `xfade` transition (`fade`, `wipeleft`, `slideup`, ...). Audio is crossfaded when both clips have a track. |
| `assemble_highlights` | Stitch two or more clips into one, with hard cuts (`transition: "cut"`) or an xfade transition between each. |
| `title_card` | Generate a standalone title card (centered text on a solid background, with a silent track so it composes). Text uses the bundled Inter, so Latin, Greek and Cyrillic need no system font; other scripts and emoji fall back to a Windows system font (or pass `fontFile`), with `warnings` for anything no font covers. |
| `music_bed` | Lay a music track under a video: looped/trimmed to length, faded in and out, leveled, and mixed with any existing audio (optionally ducked). |
| `reframe` | Re-aspect to `16:9`, `9:16`, `1:1`, or `4:5` with `pad` (letterbox, no content lost) or `crop` (fill, trims overflow). |
| `zoom` | **Smooth zoom-and-pan** (Screen Studio style) into where the action is and back out. Give keyframes (rectangles by time), or let it plan them from the clicks in the input event log (`start_recording` `events: true`; `highlightClicks` rings each click) or from where the screen changes; `dryRun` returns the plan to adjust. |
| `keystroke_overlay` | **Keycast-style badges** ("Ctrl + Shift + P", "Double click", "Typing…") burned in from the input event log, one at a time, each lingering `lingerSec` (default 1.2). Repeats merge (`Ctrl + Z ×3`); `position`, `size`, `clicks`, `typing`. It can only show what the log holds: never typed text, and shortcuts only from `keys: "shortcuts"` recordings; `keys: "masked"` here shows a chord's modifiers only. |
| `backdrop` | **Frame a clip or screenshot** (Screen Studio / CleanShot style): padding, a gradient, solid, or wallpaper `image` background, rounded corners, and a soft drop shadow, optionally on a `16:9`/`9:16`/`1:1`/`4:5` canvas. Presets in the project palette: `desktop` (default, dark slate), `rec` (record red), `amber` (amber to red), `light`. A PNG/JPG input writes a framed still. |
| `export_preset` | Encode a platform-ready file (`youtube`, `instagram_reel`, `tiktok`, `x`, `square`, `steam_trailer`, `vertical_reel`): reframes, caps fps, and encodes H.264 at the platform bitrate with faststart. `steam_trailer` is 1080p H.264 High at a padded 5.5 Mbps CBR (above Steam's 5 Mbps floor) with 48 kHz audio at -14 LUFS; `vertical_reel` centres the footage over a blurred copy of itself with audio at -14 LUFS. |
| `pipeline` | **Several edits in one ffmpeg process**: `steps` of `trim`, `crop`, `scale`, `speed`, `cut_idle`, `redact`, `callout`, `keystroke_overlay`, `reframe`, `zoom` (keyframes, or `follow: "clicks"` from the event log), `backdrop`, `audio` (`normalize`, `denoise`), `burn_subtitles` (a file, or `transcribe: true`), ending optionally in `export_preset` or `export_gif`, each with its tool's options. Or name a `recipe`: `pr_demo` (cut idle, click zoom, GIF under 10 MB), `tutorial` (plus denoise/normalize and captions, 1080p mp4) or `social_reel` (9:16, big captions); it expands to steps that `dryRun` shows and your own `steps` override. One re-encode, no intermediate files, and a recipe you can save and re-run on the next recording; `dryRun` returns the planned command; `chapters: true` keeps the input's markers as chapters, re-timed through trims and speed changes. |
| `bug_report` | **A paste-ready repro package in one call**: from a recording path or `sessionId`, writes a folder with a trimmed clip (the last 30 s by default) and a GIF under 10 MB, a timecoded contact sheet, numbered steps rebuilt from the input event log, OCR'd error and dialog text, environment details (OS, displays and DPI, window, ffmpeg), and a `report.md` for `gh issue create --body-file` (plus `report.json`). Before anything is encoded, a whole-clip OCR secret scan boxes out API keys, tokens, and `password:` values in every output and masks them in the quoted text; it needs Windows OCR (`redact: false` skips it). |
| `step_guide` | **A step-by-step how-to from a recording** (Steps Recorder for the agent era): from a path or `sessionId` with an input event log, writes `guide.md` with an `images/` folder and/or one self-contained `guide.html`. Each click, shortcut, typing burst, and scroll becomes a numbered step with the frame just before it, the click ringed, and a caption ("Click **Save**") from OCR of the text under the click; markers become section headings. OCR also boxes secrets out of the screenshots and masks them in captions (`ocr: false` skips both; it needs Windows OCR). Typed text is never logged, so it never appears. Returns the steps so the agent can rewrite captions. |

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

| Toolset | Tools |
| --- | --- |
| `capture` | `start_recording`, `stop_recording`, `save_replay`, `list_sessions`, `get_session`, `read_events`, `add_marker`, `screenshot`, `list_targets`, `list_audio_devices` |
| `watch` | `sample_frames`, `contact_sheet`, `screen_diff`, `wait_for_change`, `find_text`, `index_recording`, `search_recording`, `review_recording`, `player_frames` |
| `edit` | `pipeline`, `trim`, `clip`, `concat`, `convert`, `export_gif`, `crop`, `scale`, `speed`, `compress`, `redact_region`, `cut_idle`, `cut_by_transcript` |
| `produce` | `callout`, `keystroke_overlay`, `backdrop`, `overlay`, `zoom`, `reframe`, `title_card`, `xfade_transition`, `assemble_highlights`, `export_preset`, `burn_subtitles`, `chapters`, `bug_report`, `step_guide` |
| `audio` | `extract_audio`, `normalize_audio`, `denoise`, `transcribe`, `music_bed` |
| `core` (always) | `doctor`, `get_media_info` |

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

- **The server makes no network requests and has no telemetry.** It runs ffmpeg, ffprobe, and PowerShell on your machine and talks to your MCP client over stdio.
- **What a tool returns goes to your model provider.** Inline screenshots and frames, OCR text, event summaries, and every other tool result reach your agent, and your client sends them to the model like any other tool result. Files on disk stay on disk unless a tool returns them or you share them.
- **What is stored, and where.** Everything goes under `SCREENCAST_HOME` (default `<homedir>/.screencast-mcp`) unless a call names another path:
  - `recordings/`: recordings, plus each one's `.events.jsonl` when the event log is on
  - `screenshots/`: `screenshot` output, and `find_text` / `wait_for_change` captures only with `keep: true`
  - `frames/`: `sample_frames` and `contact_sheet` output
  - `edits/`: edit and produce output
  - `sessions.json`: the session registry (ids, targets, paths, times)

  `find_text`, `wait_for_change`, and `screen_diff` delete their captures after the call by default, since a secret scan's screenshot shows the secret.
- **What the event log records.** Only with `start_recording` `events: true`, and only while that recording runs. Mouse input is recorded system-wide, not only over the recorded window: clicks, scrolls, and the cursor position (sampled about 30 times a second), each with its time. Typing is recorded only as bursts, a start time and a length on a 0.5 s grid, with no key names and no per-key times: `masked` (default) records nothing more. `shortcuts` also records chords made with Ctrl, Alt, or Win by name (`Ctrl+S`), with their times; Ctrl+Alt+key that types a character on AltGr layouts stays typing. No mode records typed text. If the log has gaps (Windows removed the hook, input went to an elevated window or the lock screen, or the helper stopped), `read_events` reports `truncated: true` and lists them.
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
│   ├── prompts.ts        # MCP prompts (workflows as slash commands)
│   ├── resources.ts      # MCP resources (sessions, posters)
│   ├── wgcRecorder.ts    # recorder process for backend: "wgc"
│   ├── tools/            # one file per tool
│   ├── utils/            # pure builders and helpers (ffmpeg args, targets, sessions, ...)
│   └── __tests__/        # vitest: unit, ffmpeg integration, guarded local-capture harness
├── assets/               # bundled fonts and the review player (assets/ui)
├── docs/                 # GitHub Pages site (scripts/build-docs-pages.mjs writes the recipe pages)
├── scripts/              # Claude Desktop bundle (.mcpb) and docs page builders
├── mcp-tools.json        # canonical tool manifest (kept in sync with src/tools)
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
```

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
