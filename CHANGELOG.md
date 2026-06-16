# Changelog

All notable changes to Screencast MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

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
