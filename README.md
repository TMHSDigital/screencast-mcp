# Screencast MCP

**MCP server for Windows screen recording, frame sampling, and minimal ffmpeg edits**

![License: CC-BY-NC-ND-4.0](https://img.shields.io/badge/license-CC--BY--NC--ND--4.0-green)
![Version](https://img.shields.io/badge/version-0.2.0-blue)

---

Screencast MCP is a Windows-first [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an agent record the screen, take screenshots, "watch" footage by
sampling frames into images it can actually view, and perform a small set of
ffmpeg edits (trim, concat, convert). It speaks MCP over stdio and wraps ffmpeg
and ffprobe.

This is Phase 1. The full edit surface (crop, scale, speed, overlay, extract,
compress), audio capture, and a higher-level production layer are deliberately
later phases. See [ROADMAP.md](ROADMAP.md).

## Prerequisites

`ffmpeg` and `ffprobe` are external dependencies and must be installed and on
`PATH` (or pointed at with the `FFMPEG_PATH` / `FFPROBE_PATH` environment
variables). The server detects them per call and returns a clear error with an
install hint if either is missing.

| Platform | Install |
|----------|---------|
| Windows  | `winget install Gyan.FFmpeg` or `choco install ffmpeg` |
| macOS    | `brew install ffmpeg` |
| Linux    | `apt install ffmpeg` |

Screen capture itself uses `gdigrab`, which is Windows-only; the watch and edit
tools work anywhere ffmpeg runs.

## Installation

```bash
npm install -g @tmhsdigital/screencast-mcp
```

Or run it directly from a clone:

```bash
npm install
npm run build
node dist/index.js
```

### MCP client configuration

```json
{
  "mcpServers": {
    "screencast": {
      "command": "npx",
      "args": ["-y", "@tmhsdigital/screencast-mcp"]
    }
  }
}
```

## Tool reference

### Capture

| Tool | Purpose |
|------|---------|
| `start_recording` | Start a background recording. `target` = `full` \| `monitor:<index>` \| `window:<title>` \| `region:<x>,<y>,<w>,<h>`; optional `fps` and `quality` (`draft` \| `standard` \| `high`). Returns a session id and output path. |
| `stop_recording` | Stop a session by id. Sends ffmpeg a graceful quit so the file is finalized, not truncated. Returns final path and duration. |
| `list_sessions` | List active and finished sessions. |
| `get_session` | Inspect one session by id. |
| `screenshot` | Capture a single PNG of a `target`. |

### Watch

| Tool | Purpose |
|------|---------|
| `sample_frames` | Extract frames from a video, either at a fixed `fps` or at explicit `timestamps`, so the agent can view what happened. Returns the frame paths. |
| `get_media_info` | ffprobe wrapper: duration, resolution, fps, codecs, format, size. |

### Minimal edit

| Tool | Purpose |
|------|---------|
| `trim` | Cut a sub-clip by `start` + (`end` or `duration`). |
| `concat` | Join two or more videos into one. |
| `convert` | Convert between `mp4`, `gif`, and `webm`. |

Quality is exposed as presets (`draft` / `standard` / `high`), not raw ffmpeg
flags, so the agent never has to reason about codecs.

### Output locations

By default everything is written under `SCREENCAST_HOME`
(default `<homedir>/.screencast-mcp`) in `recordings/`, `frames/`,
`screenshots/`, and `edits/`, so captures never land inside a project checkout.
Any tool also accepts an explicit output path.

## Windows notes

- **Multi-monitor offsets.** `gdigrab` has no "capture monitor N" selector, so a
  monitor target captures the whole virtual desktop and crops to that display's
  pixel bounds. The bounds come from `System.Windows.Forms.Screen.AllScreens`, so
  `monitor:1` correctly grabs the second display at its real offset (for example
  `x=2560` on a 4480x1440 dual-monitor desktop). `monitor:0` is always primary.
- **Window capture** (`window:My App`) captures the on-screen **rectangle** the
  window currently occupies, not the window's own surface. `gdigrab`'s native
  `title=` grab returns a blank frame for GPU- or DirectComposition-composited
  windows (Chrome, Electron editors, UWP apps), so the window is instead resolved
  to its screen rectangle (per-monitor DPI aware) and captured through the same
  desktop path as `monitor`/`region`. Consequences: the window must be **visible,
  on top, and not minimized** (a minimized window is rejected with a clear error);
  the capture includes anything drawn over that rectangle; and for
  `start_recording` the rectangle is fixed **once at start**, so a window moved or
  resized mid-recording is not followed. Title matching is case-insensitive —
  exact match wins, otherwise a substring match, and the topmost window wins ties.
  True per-window background capture (Windows Graphics Capture API) is a
  deliberate future phase, not in this build.
- **Fullscreen-exclusive apps** often produce black frames under `gdigrab`. Run
  the source in borderless-windowed mode for reliable capture.
- **Audio is not captured in Phase 1.** `gdigrab` is video-only; audio
  (dshow / WASAPI loopback) is a Phase 2 seam and is intentionally not half-wired.
- A recording that is interrupted by a crash is reconciled on the next server
  start (orphan reaping), so no ffmpeg child silently outlives the server.

## Threat model

Screen capture can record **anything** that is on screen at the moment of
capture, including passwords, tokens, private messages, and other secrets. Treat
recordings, screenshots, and sampled frames as sensitive by default. Note that
`window:` captures the screen rectangle a window occupies, so anything drawn over
that rectangle (overlays, notifications, another window) is captured too.

- **Capture is always explicit.** A recording or screenshot only happens when a
  tool is called; nothing auto-fires, and there is no background or scheduled
  capture. This mirrors how privileged operations are gated behind an explicit
  action rather than implied.
- **Output stays local.** Files are written to the local filesystem only. This
  server never uploads, streams, or transmits captured media anywhere.
- **Public repo, private captures.** This repository is public. Its `.gitignore`
  ignores recordings, frames, screenshots, and common video/image output so test
  media cannot be committed by accident. Keep your real captures out of version
  control.
- **Review before sharing.** Sample frames or inspect a recording before passing
  a file to any other tool or person, so you know what it actually contains.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (pure unit tests, no ffmpeg required)
npm run dev        # tsx watch
```

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the phased plan.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

CC-BY-NC-ND-4.0 -- see [LICENSE](LICENSE) for details.

---

**Built by TMHSDigital**
