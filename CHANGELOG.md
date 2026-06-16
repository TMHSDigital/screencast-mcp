# Changelog

All notable changes to Screencast MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.0]

### Added

- **Phase 3 produce layer begins: transitions and assembly.**
  - `xfade_transition` crossfades two videos into one with an xfade transition
    (`fade`, `wipeleft`, `slideup`, ...), crossfading audio when both have a track.
  - `assemble_highlights` stitches N clips into one with hard cuts or an xfade
    transition between each.
- Both auto-normalize every input to a common resolution, fps, SAR, and audio
  rate before stitching, so heterogeneous clips compose cleanly. The xfade chain
  computes cumulative offsets from each clip's probed duration. New pure builders
  live in `src/utils/produce.js`, unit tested without ffmpeg.

## [0.5.0]

### Added

- **System audio capture.** `start_recording` accepts an `audio` option; set
  `audio.source` to `system` to capture loopback audio from a separate dshow
  input alongside the gdigrab video. The loopback device is auto-detected or
  named explicitly via `audio.device`.
- **`list_audio_devices`** enumerates the DirectShow audio devices ffmpeg can
  see and flags a likely loopback device.
- A missing loopback device fails before ffmpeg starts, with an install hint
  (Stereo Mix, `virtual-audio-capturer`, or VB-CABLE).

### Notes

- Windows has no native loopback, so system audio needs a virtual-audio device.
  Microphone capture is intentionally not supported. This implements the
  `buildAudioInputArgs()` seam that Phase 1 deliberately left unwired.

## [0.4.0]

### Added

- **`redact_region` safety redaction.** Cover declared rectangles in a video so
  on-screen secrets are hidden. The default `box` style draws a solid,
  irreversible fill; `blur` and `pixelate` are offered for non-secret content.
  Each region can be limited to a time window and expanded with `pad`.
- Regions are bounds-checked against the real frame (probed first), so an
  off-frame request is rejected rather than silently leaving the secret visible.

### Security

- Documented the redaction guarantee in `SECURITY.md` and the README threat
  model: redaction covers declared regions only and is not automatic secret
  detection; prefer the irreversible `box` style for real secrets.

## [0.3.0]

### Added

- **Phase 2 edit surface.** Seven re-encoding edit tools that reuse the
  `draft`/`standard`/`high` quality presets: `crop`, `scale`, `speed`, `overlay`,
  `compress`, `extract_audio`, and `clip`.
- `crop` rejects a rectangle that runs off the source frame rather than letting
  ffmpeg silently clamp it, so an out-of-bounds request fails loudly.
- `clip` extracts one or more frame-accurate sub-segments to separate files. It
  re-encodes (output `-ss` + `-t`) so cuts land exactly on the given times, which
  covers the roadmap's "re-encode trim option"; `trim` stays the fast
  stream-copy single cut.

### Changed

- Factored a shared `probeMedia()` helper into `src/utils/ffmpeg.js`; `crop`,
  `speed`, and `get_media_info` now reuse it instead of each running ffprobe.

## [0.2.2]

### Changed

- First release published to npm by CI with build provenance (`--provenance`).
  Earlier versions were published manually; the automated release pipeline
  (`release.yml` → `publish.yml`, gated on `NPM_TOKEN`) is now wired and verified.
- Refreshed the stale "tokenless" comment in `publish.yml` now that the
  `NPM_TOKEN` secret is provisioned.

## [0.2.1]

### Fixed

- **Window capture** now grabs the on-screen rectangle a window occupies instead
  of `gdigrab`'s `title=` surface, which returned blank frames for GPU- or
  DirectComposition-composited windows (Chrome, Electron, UWP). Resolved via a
  per-monitor-DPI-aware window-bounds shim routed through the region path; both
  `screenshot` and `start_recording` are fixed. Minimized windows are rejected
  with a clear error.

### Changed

- Published under the correct npm scope **`@tmhs/screencast-mcp`** (the prior
  `@tmhsdigital` name was the GitHub org, not the npm scope, and could not
  publish).
- Added `publishConfig.access: public` for correct scoped first publish.
- README restyled to the house standard and corrected to the working install.

## [0.2.0]

### Added

- Phase 1 tool surface: capture (`start_recording`, `stop_recording`,
  `list_sessions`, `get_session`, `screenshot`), watch (`sample_frames`,
  `get_media_info`), and minimal edits (`trim`, `concat`, `convert`).
- Crash-safe recording sessions with orphan reaping on startup.

## [0.1.0]

### Added

- Initial project scaffold
- CI/CD workflows (ci, release, publish, drift-check, pages, stale, label-sync)
- GitHub Pages documentation site
