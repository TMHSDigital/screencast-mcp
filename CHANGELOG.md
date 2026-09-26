# Changelog

All notable changes to Screencast MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.9.1]

### Fixed

- **`trim` with `end` now produces `end - start` seconds** (#75). The builder
  put `-ss` before the input and `-to <end>` after it. Input-side seeking resets
  output timestamps, so `-to` was read as a duration: `start: 10, end: 15` gave
  a 15 s clip. It now emits `-t <end - start>`.
- **`music_bed` no longer makes the original audio about 6 dB quieter** (#77).
  `amix` scales each input by 1/N by default; both mix paths now pass
  `normalize=0`, so the original stays at unity and `musicVolume` alone sets
  the music level.
- **`title_card` works when the temp or install path contains `'`, `,`, `;`,
  `[` or `]`** (#87). `escapeFilterPath` only escaped `\` and `:`, so a Windows
  username like `O'Brien` broke drawtext's font or text-file path.

### Added

- An ffmpeg-backed integration suite (`src/__tests__/integration`) that runs
  the real edit and produce builders against lavfi-generated fixtures and
  checks the probed output: durations, dimensions, streams, loudness, and
  redaction pixels (#78). CI installs ffmpeg on the Linux job and requires the
  suite there (`REQUIRE_FFMPEG=1`); elsewhere it skips when ffmpeg is missing.
- ESLint (flat config, typescript-eslint recommended) with a `lint` script, run
  in CI (#23). Tooling only; not part of the published package.

## [0.9.0]

### Changed

- **Tools no longer silently overwrite an existing file at a caller-supplied
  `output` path** (#37). Every tool with an `output` parameter now refuses an
  existing path with a clear error unless the new optional `overwrite: true`
  is passed. Auto-generated default paths (unique names under
  `SCREENCAST_HOME`) are unaffected.

### Fixed

- **`extract_audio` with `format: "copy"` picks a container that matches the
  source codec** (#36). The blanket `.m4a` broke for opus/vorbis/etc; the
  source is now probed and mapped (aac/alac → m4a, mp3 → mp3, opus/vorbis →
  ogg, flac → flac, pcm → wav, anything else → mka), and an input with no
  audio stream errors up front. The response includes `sourceAudioCodec`.
- **Odd output dimensions are rejected with a clear error in the re-encode
  tools** (#47). `scale`, `crop`, `xfade_transition`, `assemble_highlights`,
  and `title_card` now reject an explicit odd `width`/`height` (H.264 +
  yuv420p cannot encode them) instead of failing with a cryptic
  "not divisible by 2" encoder tail.

## [0.8.13]

### Fixed

- **A recording whose ffmpeg crashes mid-run is now recorded as `failed`** with
  the last lines of encoder stderr, instead of an indistinguishable clean
  `stopped`. A deliberate `stop_recording` still finishes as `stopped`.
- **`concat` works with relative input paths.** The concat demuxer resolves
  relative list entries against the list file's directory (the OS temp dir),
  not the server cwd; inputs are now made absolute before the list is written.
- **The server advertises its real version.** `src/index.ts` reads the version
  from `package.json` at runtime instead of a hardcoded string that had fallen
  behind (it said 0.8.0 while the package was at 0.8.12).
- **A corrupt `sessions.json` is backed up to `sessions.json.bak`** before the
  registry starts fresh, instead of being silently discarded along with any
  live-recording entries it held.
- **`stop_recording` no longer sleeps a blind 400 ms** before probing the
  finalized file; it polls for process exit (kill paths) or probes immediately
  (graceful path).

### Changed

- CLAUDE.md no longer references a `src/providers/` layer that does not exist
  in this codebase.

## [0.8.12]

### Fixed

- **Off-desktop region offsets are rejected with a clear error** (#41). A
  `region:` whose rectangle fell outside the virtual desktop (a negative offset
  before the leftmost monitor, or one running past the right/bottom edge) was
  accepted by `parseTarget` and then failed in gdigrab with a cryptic libav
  error. The region is now validated against the live virtual-desktop bounds (the
  bounding box of all monitors) before capture. Negative offsets remain valid
  when a monitor sits left of or above the primary, since the check uses the real
  desktop origin rather than a blanket `>= 0`.

## [0.8.11]

### Fixed

- **`sample_frames` (timestamps) no longer returns paths for frames past the end
  of the video** (#35). A timestamp beyond the video length makes ffmpeg exit 0
  without writing a file, but the tool still reported that (nonexistent) path.
  It now returns only frames that actually exist on disk and lists any
  out-of-range timestamps under `skippedTimestamps` with a note. Mirrors the
  fps-mode fix in #20.

## [0.8.10]

### Fixed

- **Audio device enumeration no longer hangs for 30s with a misleading timeout**
  (#40). The dshow `-list_devices` probe can block on some setups (a misbehaving
  audio driver), and `list_audio_devices` / system-audio recording surfaced the
  raw `ffmpeg timed out after 30s` text. Enumeration now uses a 12s cap, closes
  the child's stdin (a known hang cause), and returns a clear "could not
  enumerate audio devices" message with a fix hint. A successful result is cached
  for the process so an audio recording does not re-pay the probe; the
  `list_audio_devices` tool forces a fresh probe so a newly enabled device still
  shows up.

## [0.8.9]

### Fixed

- **Odd-sized region recordings no longer fail with a cryptic encoder error**
  (#34). libx264 with `yuv420p` requires even width and height, but a raw
  `region:<x>,<y>,<w>,<h>` could pass odd dimensions straight to the encoder
  (`start_recording { "target": "region:0,0,101,101" }` failed with a "width
  not divisible by 2" ffmpeg tail). The recording path now rounds capture
  width/height down to even, matching what `selectWindow` already does for
  window targets; a region too small to record after rounding returns a clear
  error. Screenshots (PNG) still capture the exact requested rectangle.

## [0.8.8]

### Fixed

- **`monitor:<index>` capture is correct on DPI-scaled displays** (#39). Monitor
  enumeration is now per-monitor-DPI-aware, so it reads physical pixel bounds
  instead of DPI-scaled logical ones. Previously, on a display scaled above 100%
  (e.g. 150%), `monitor:0` captured only a cropped top-left slice (1280x800 of a
  1920x1200 screen). Verified live: `monitor:0` now matches the full physical
  resolution. A gated regression test guards it.

## [0.8.7]

### Changed

- **String filter parameters are validated up front** (#22). A transition name
  (`xfade_transition`, `assemble_highlights`) must be a lowercase xfade name, and
  a color (`title_card` `bg`/`fontColor`, `redact_region` `color`) may not
  contain filtergraph metacharacters. An invalid value now returns a clear error
  instead of a cryptic ffmpeg filtergraph parse failure. This is a usability fix,
  not a security boundary (args are passed without a shell).

## [0.8.6]

### Changed

- **Short-lived working files no longer land in the edits dir** (#24). The
  `concat` list file and the `title_card` drawtext text file are now written to
  the OS temp dir via a new `tempPath()` helper, so a hard crash before cleanup
  leaves them where the OS reaps them instead of next to real outputs.

## [0.8.5]

### Fixed

- **`assemble_highlights` no longer drops audio when only some clips have a
  track** (#19). A clip lacking audio now gets a matching length of generated
  silence (`anullsrc`), so mixing an audio-bearing clip with a video-only one
  keeps the audio instead of silencing the whole result. If no clip has audio
  the output stays video-only, as before. A video-only clip with an unknown
  duration is rejected with a clear error (silence cannot be sized).

## [0.8.4]

### Changed

- **Session registry is now concurrency-aware and bounded** (#17). `persist()`
  reads the file and merges before writing, so a concurrent server instance's
  records are no longer clobbered (record ids are unique, so the merge is a
  union). The file is written atomically (temp + rename) so a kill mid-write
  cannot corrupt it. Finished records are pruned to the most recent
  `MAX_FINISHED_RECORDS` (100) on load and persist, keeping every active
  recording, so the registry stays bounded. This reduces but does not fully
  eliminate the read-modify-write race; cross-process file locking remains out
  of scope.

## [0.8.3]

### Fixed

- **`sample_frames` (fps mode) no longer returns stale frames from a reused
  `outputDir`** (#20). It snapshots the PNGs already present before sampling and
  returns only the frames written by this run, so a directory that already
  contained images does not contaminate the result.

## [0.8.2]

### Fixed

- **`assemble_highlights` now validates clip durations against the transition**
  (#18). With an xfade transition, a clip not longer than the transition (or one
  whose duration could not be probed) is rejected with a clear error naming the
  offending clip, instead of producing overlapping/garbled cuts or a cryptic
  ffmpeg failure.

## [0.8.1]

### Fixed

- **A second server instance no longer kills another instance's active
  recording** (#16). Records are now tagged with the owning server's process id
  (`serverPid`), and orphan reaping skips any `recording` record owned by a
  different, still-live server. A genuine orphan (owning server dead) is still
  reaped; older records without `serverPid` keep the previous behavior.

## [0.8.0]

### Added

- **Aspect variants and platform export complete Phase 3.**
  - `reframe` re-aspects a video to `16:9`, `9:16`, `1:1`, or `4:5` with `pad`
    (letterbox, no content lost) or `crop` (fill, trims the overflow).
  - `export_preset` encodes a platform-ready file for `youtube`,
    `instagram_reel`, `tiktok`, `x`, or `square`: reframes to the platform
    aspect, caps fps, and encodes H.264 at the platform bitrate with faststart.

## [0.7.0]

### Added

- **Title cards and music bed.**
  - `title_card` generates a standalone title clip: centered text on a solid
    background, plus a silent stereo track so it composes with audio-bearing
    clips. Text is written to a temp file and rendered via `drawtext=textfile`,
    so arbitrary content (quotes, colons, percent signs) needs no escaping.
  - `music_bed` lays a music track under a video: looped/trimmed to the video
    length, faded in/out, leveled, and mixed with any existing audio, optionally
    ducked under the original via a sidechain.
- **Bundled font.** The package now ships two Inter weights (SIL Open Font
  License) under `assets/fonts/`, so `title_card` works without a system font.
  `assets` is added to the published package `files`.

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
