<div align="center">

# Screencast MCP

**An MCP server that lets an agent record the screen, _watch_ the footage, and make minimal ffmpeg edits — over stdio, on Windows.**

Capture the desktop, a monitor, a window, or a region; sample a recording into frames the agent can actually look at; trim, crop, scale, overlay, compress, redact, and convert. No cloud, no streaming — ffmpeg and ffprobe wrapped behind nineteen typed tools.

<br />

[![Documentation](https://img.shields.io/badge/Documentation-2D7FF9?style=for-the-badge&logo=readthedocs&logoColor=white)](https://tmhsdigital.github.io/screencast-mcp/)

<br />

[![CI](https://github.com/TMHSDigital/screencast-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TMHSDigital/screencast-mcp/actions/workflows/ci.yml)
[![License: CC BY-NC-ND 4.0](https://img.shields.io/badge/license-CC--BY--NC--ND--4.0-green)](LICENSE)
![Last commit](https://img.shields.io/github/last-commit/TMHSDigital/screencast-mcp)
![Repo size](https://img.shields.io/github/repo-size/TMHSDigital/screencast-mcp)
![Top language](https://img.shields.io/github/languages/top/TMHSDigital/screencast-mcp)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js_%E2%89%A520-339933?logo=node.js&logoColor=white)
![Model Context Protocol](https://img.shields.io/badge/MCP-stdio-6E56CF)
![ffmpeg](https://img.shields.io/badge/ffmpeg-required-007808?logo=ffmpeg&logoColor=white)
![Capture](https://img.shields.io/badge/capture-Windows_gdigrab-0078D6?logo=windows&logoColor=white)

</div>

> [!NOTE]
> Screen capture uses `gdigrab` and is Windows-only; the watch and edit tools work anywhere ffmpeg runs. **Phase 2** adds the full edit surface (crop, scale, speed, overlay, compress, extract_audio, clip), `redact_region` safety redaction, and system-audio capture. The higher-level production layer is a later phase — see [ROADMAP.md](ROADMAP.md).

## Overview

Screencast MCP gives an agent a screen recorder it can drive and reason about. It speaks [Model Context Protocol](https://modelcontextprotocol.io) over stdio and exposes ffmpeg as a small, typed tool surface rather than a flag soup. The defining capability is the **watch loop**: an agent records footage, samples it into PNG frames, and views those frames to confirm what actually happened on screen.

The design choices are deliberate rather than incidental:

- **Capture is always explicit.** A recording or screenshot happens only on a tool call — nothing auto-fires and there is no background or scheduled capture.
- **Footage is made viewable.** `sample_frames` turns a video into images an agent can open, so "watch what happened" is a first-class operation, not an afterthought.
- **Presets over raw flags.** Quality is `draft` / `standard` / `high`; the agent never reasons about codecs, CRF, or pixel formats.
- **Safe by default.** Output lands under `SCREENCAST_HOME`, never inside a project checkout, and the public repo's `.gitignore` blocks captured media from being committed.
- **Crash-safe sessions.** A recording interrupted by a crash is reconciled on the next start (orphan reaping), so no ffmpeg child silently outlives the server.

## Tools

Twenty-one tools across four concerns. The manifest in [`mcp-tools.json`](mcp-tools.json) is the canonical surface and is kept in sync with `src/tools/`.

### Capture

| Tool | Purpose |
| --- | --- |
| `start_recording` | Start a background recording. `target` = `full` \| `monitor:<index>` \| `window:<title>` \| `region:<x>,<y>,<w>,<h>`; optional `fps`, `quality`, and `audio` (set `audio.source` = `system` to also capture loopback audio). Returns a session id and output path. |
| `stop_recording` | Stop a session by id. Sends ffmpeg a graceful quit so the file is **finalized, not truncated**. Returns the final path and duration. |
| `list_sessions` | List active and finished sessions. |
| `get_session` | Inspect a single session by id. |
| `screenshot` | Capture a single PNG of a `target`. |
| `list_audio_devices` | List the DirectShow audio devices ffmpeg can see and flag a likely system-audio loopback device for `start_recording`. |

### Watch

| Tool | Purpose |
| --- | --- |
| `sample_frames` | Extract frames from a video — at a fixed `fps` or at explicit `timestamps` — so the agent can view what happened. Returns the frame paths. |
| `get_media_info` | ffprobe wrapper: duration, resolution, fps, codecs, container format, and size. |

### Minimal edit

| Tool | Purpose |
| --- | --- |
| `trim` | Cut a sub-clip by `start` + (`end` or `duration`). Stream-copy for speed. |
| `concat` | Join two or more videos into one. |
| `convert` | Convert between `mp4`, `gif`, and `webm`. |

### Edit surface

These tools re-encode (a filter rewrites pixels, so stream copy does not apply). They reuse the same `draft`/`standard`/`high` presets as capture.

| Tool | Purpose |
| --- | --- |
| `crop` | Crop to a pixel rectangle (`x`, `y`, `width`, `height`). A rectangle that runs off the frame is rejected, not silently clamped. |
| `scale` | Resize to a `width` and/or `height`. One side keeps the aspect ratio; both set an exact size. |
| `speed` | Change playback speed by a `factor` (>1 faster, <1 slower). Audio is retempo'd when present. |
| `overlay` | Composite a logo, watermark, or picture-in-picture onto a base video at a position, optionally scaled and time-limited. |
| `compress` | Re-encode smaller with a `light`/`medium`/`heavy` CRF ladder and an optional `maxWidth` that only downscales. |
| `extract_audio` | Write the audio track to its own file (`mp3`, `aac`, `wav`, or `copy`). |
| `clip` | Extract one or more frame-accurate sub-segments to separate files. Unlike `trim`, it re-encodes so cuts land exactly on the given times. |

### Redact

| Tool | Purpose |
| --- | --- |
| `redact_region` | Cover declared rectangles in a video. `style` is `box` (default, a solid irreversible fill), `blur`, or `pixelate`; each region may be limited to a `start`/`end` window and expanded with `pad`. |

> [!IMPORTANT]
> `redact_region` covers the regions **you** declare. It is not automatic secret detection, so it cannot find a secret you did not point it at. The default `box` style is a solid fill, which is irreversible; `blur` and `pixelate` are softer but can be partially recovered, so prefer `box` for real secrets. A region that falls outside the frame is rejected rather than silently doing nothing.

### Produce

The production layer turns raw clips into a finished piece. Tools that combine clips auto-normalize each input to a common resolution, fps, and audio rate first, so heterogeneous sources compose cleanly.

| Tool | Purpose |
| --- | --- |
| `xfade_transition` | Crossfade two videos into one with an `xfade` transition (`fade`, `wipeleft`, `slideup`, ...). Audio is crossfaded when both clips have a track. |
| `assemble_highlights` | Stitch two or more clips into one, with hard cuts (`transition: "cut"`) or an xfade transition between each. |

### Targets

Every capture tool takes a single `target` string, so an agent never has to juggle quoting:

| Target | Captures |
| --- | --- |
| `full` | The whole virtual desktop |
| `monitor:<index>` | One display; `0` is always primary |
| `window:<title>` | The on-screen rectangle a window occupies (case-insensitive exact title, else substring; topmost wins) |
| `region:<x>,<y>,<w>,<h>` | An absolute pixel rectangle |

Output is written under `SCREENCAST_HOME` (default `<homedir>/.screencast-mcp`) into `recordings/`, `frames/`, `screenshots/`, and `edits/`. Any tool also accepts an explicit output path.

## Prerequisites

`ffmpeg` and `ffprobe` are external dependencies and must be on `PATH` (or pointed at via the `FFMPEG_PATH` / `FFPROBE_PATH` environment variables). The server detects them per call and returns a clear error with an install hint if either is missing.

| Platform | Install |
| --- | --- |
| Windows | `winget install Gyan.FFmpeg` or `choco install ffmpeg` |
| macOS | `brew install ffmpeg` |
| Linux | `apt install ffmpeg` |

## Installation

```bash
npm install -g @tmhs/screencast-mcp
```

Or run it from a clone:

```bash
git clone https://github.com/TMHSDigital/screencast-mcp.git
cd screencast-mcp
npm install
npm run build      # produces dist/index.js, the server entry point
```

### MCP client configuration

```json
{
  "mcpServers": {
    "screencast": {
      "command": "npx",
      "args": ["-y", "@tmhs/screencast-mcp"]
    }
  }
}
```

> [!TIP]
> Running from a clone instead of the published package? Point the client straight at the build: `"command": "node"`, `"args": ["C:/path/to/screencast-mcp/dist/index.js"]`.

## Usage

A typical watch loop — record, sample, look:

```jsonc
// 1. record a region for a few seconds
start_recording { "target": "region:0,0,1280,720", "quality": "draft" }
//    -> { "sessionId": "rec-…", "outputPath": "…/recordings/rec-….mp4" }

// 2. finalize the file
stop_recording { "sessionId": "rec-…" }
//    -> { "durationSec": 4.2, "finalizedGracefully": true }

// 3. turn it into frames the agent can view
sample_frames { "input": "…/recordings/rec-….mp4", "timestamps": [0.5, 2, 3.5] }
//    -> { "frames": ["…/frames/…/frame_000_0.5s.png", …] }
```

`screenshot { "target": "window:My App" }` is the one-shot equivalent for a still.

## Windows notes

- **Multi-monitor offsets.** `gdigrab` has no "capture monitor N" selector, so a monitor target captures the whole virtual desktop and crops to that display's pixel bounds (from `System.Windows.Forms.Screen.AllScreens`). `monitor:1` grabs the second display at its real offset; `monitor:0` is always primary.
- **Window capture** resolves the window to the on-screen **rectangle** it occupies and captures that, rather than the window's own surface — `gdigrab`'s native `title=` grab returns a blank frame for GPU- or DirectComposition-composited windows (Chrome, Electron, UWP). The window must be **visible, on top, and not minimized** (a minimized window is rejected with a clear error), the capture includes anything drawn over that rectangle, and for `start_recording` the rectangle is fixed **once at start**. True per-window background capture (Windows Graphics Capture API) is a future phase.
- **Fullscreen-exclusive apps** often produce black frames under `gdigrab`; run the source in borderless-windowed mode for reliable capture.
- **System audio needs a loopback device.** `gdigrab` is video-only, so `start_recording` with `audio.source` = `system` captures from a separate dshow input. Windows has no native loopback, so this needs a virtual-audio device (enable Stereo Mix, or install a driver such as screen-capture-recorder's `virtual-audio-capturer` or VB-CABLE). Run `list_audio_devices` to find it. Microphone capture is intentionally not supported.

## Threat model

> [!WARNING]
> Screen capture can record **anything** on screen at the moment of capture — passwords, tokens, private messages, and other secrets. `window:` captures the screen rectangle a window occupies, so overlays, notifications, or another window drawn over it are captured too. Treat recordings, screenshots, and sampled frames as sensitive by default.

- **Capture is always explicit.** Nothing auto-fires; capture is gated behind an explicit tool call.
- **Output stays local.** Files are written to the local filesystem only — never uploaded, streamed, or transmitted anywhere.
- **Public repo, private captures.** The `.gitignore` blocks recordings, frames, screenshots, and common video/image output so test media cannot be committed by accident.
- **Review before sharing.** Sample frames or inspect a recording before handing a file to another tool or person, so you know what it contains.
- **Redaction is declared, not detected.** `redact_region` covers only the rectangles you specify, so it depends on you (or the agent) having found the secret first. Use the default `box` style for a solid irreversible fill, and still review the output before sharing.
- **System audio is sensitive too.** When `audio.source` = `system`, the recording captures everything playing on the machine (call audio, notifications, media). Treat audio-bearing recordings with the same care as the video.

## Project structure

```
.
├── src/
│   ├── index.ts          # MCP server entry (stdio); registers every tool, reaps orphans
│   ├── context.ts        # shared session-store singleton
│   ├── tools/            # one file per tool (capture, watch, edit)
│   ├── utils/            # ffmpeg, monitors, windows, sessions, paths, targets
│   └── __tests__/        # vitest unit tests + guarded local-capture harness
├── docs/                 # GitHub Pages documentation site
├── mcp-tools.json        # canonical tool manifest (kept in sync with src/tools)
├── .github/workflows/    # CI, release, npm publish, Pages, ecosystem drift check
├── ROADMAP.md · CONTRIBUTING.md · SECURITY.md · LICENSE
└── package.json
```

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (pure unit tests; no ffmpeg or display required)
npm run dev        # tsx watch
```

The capture path can't be exercised on CI's headless Linux runners, so an end-to-end harness lives behind a flag and is skipped by default:

```bash
RUN_LOCAL_CAPTURE_TESTS=1 npm test   # Windows + ffmpeg + a real display
```

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through [SECURITY.md](SECURITY.md).

## License

Released under the [CC-BY-NC-ND-4.0](LICENSE) license.

<div align="center">
<br />

[**Documentation**](https://tmhsdigital.github.io/screencast-mcp/) · [**Roadmap**](ROADMAP.md) · [**Report an issue**](https://github.com/TMHSDigital/screencast-mcp/issues) · [**License**](LICENSE)

<sub>Built by <a href="https://github.com/TMHSDigital">TMHSDigital</a> · <a href="#screencast-mcp">Back to top ↑</a></sub>

</div>
