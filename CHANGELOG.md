# Changelog

All notable changes to Screencast MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.23.0]

### Added

- **MCP prompts** (#126). Four ready-made workflows that clients show as slash
  commands: `bug-repro-clip`, `demo-gif`, `verify-ui-change`, and
  `review-recording`. Each spells out the tool sequence for the job (for
  example: wait for the screen to settle before diffing). A test checks that
  every tool a prompt names exists.
- **MCP resources** (#126). `screencast://sessions`,
  `screencast://sessions/{id}`, and `screencast://sessions/{id}/poster` (a
  JPEG frame from the middle of the recording), so clients can list, read,
  and attach recordings without a filesystem tool. The session store now
  notifies listeners after each write, and the server sends
  `resources/list_changed` when a recording starts or stops.

## [0.22.0]

### Added

- **`normalize_audio` tool** (#123). It brings a recording's loudness to a
  delivery target with two-pass EBU R128 `loudnorm` (measure, then a linear
  correction from the measurement): `youtube` (−14 LUFS, default), `podcast`
  (−16), `broadcast` (−23), or any LUFS value. Video is stream-copied, and
  the output codec follows the container (PCM for `.wav`, MP3 for `.mp3`,
  else AAC at 48 kHz). The result reports loudness before and after; in
  testing every target was hit within 0.05 LU. Silent or audio-less inputs
  get a clear error.
- **`denoise` tool** (#123). It reduces steady background noise (fan, hum,
  hiss) with `afftdn` at `light` / `medium` / `strong`. afftdn only removes
  noise it thinks is below its noise floor, so a fixed floor left real noise
  untouched (white noise at −25 dBFS: no change). The tool measures the
  file's floor first (10th-percentile RMS of 100 ms windows) and sets afftdn
  5 dB above it. Measured: steady noise cut 12–20 dB, a tone mixed with noise
  kept within 0.3 dB. Larger offsets removed a little more pink noise but
  started eating the wanted signal.

## [0.21.0]

### Added

- **`callout` tool** (#121). It draws timed annotations over a video: boxes
  (outlined or filled), text labels (bundled font, optional dark panel), and
  arrows at any angle, each shown between `from` and `to` seconds, with later
  items on top. ffmpeg cannot draw lines, so each arrow is rendered as a
  transparent shaft-plus-head image (`geq`), rotated to its angle, and
  overlaid centred on its midpoint.

### Fixed

- **`title_card` drew a blank card when the text contained `%`.**
  `drawtext` treats `%` as the start of an expansion sequence (`%{…}`); a
  stray one made it draw nothing at all, with only a warning. All user text
  (title cards, callout labels, contact-sheet timecodes) now renders with
  `expansion=none`. The #87 title-card test checked only the output's size
  even though its text contained `100%`; it now checks that text is actually
  drawn, and fails without this fix.

## [0.20.0]

### Added

- **`backend: "wgc"` for window stills** (#113). `screenshot` and
  `find_text` can capture a `window:` target's own surface through Windows
  Graphics Capture (FFmpeg 8+ `gfxcapture`), selected by window handle, so a
  window covered by another one still comes out as itself. (Tested: a
  window fully covered by another came out as its own colour with `wgc`, and
  as the cover with gdigrab.) The window enumeration now records each
  window's handle. Without `gfxcapture`, the call fails with a clear message.

### Notes

- Recordings and `wait_for_change` stay on gdigrab. `gfxcapture` only emits
  a frame when the window repaints. On a static window, a recording stalls:
  ffmpeg ignores the graceful-stop `q` and the file comes out empty. Stills
  are also slower (1-2 s against ~0.2 s), which is why `wgc` is opt-in.

## [0.19.0]

### Added

- **`find_text` tool** (#117). It reads text on screen (`target`) or in an
  image or video frame (`input`, `timestamp`) with the OCR engine built into
  Windows (`Windows.Media.Ocr`), with nothing to install. It returns every
  line with its bounding box, and with a `query` (plain or `regex`), each
  match boxed and the image inline with the matches outlined.
  `redact: true` adds padded rectangles to pass straight to `redact_region`.
  In testing, it found both secrets in a frame, `redact_region` covered them,
  and a re-check found nothing.
- Recognition runs two passes (2× and 4× upscales, capped at the engine's
  10,000 px limit) in one PowerShell process and merges them. Testing showed
  Windows OCR drops ALL_CAPS words joined by underscores (e.g.
  `OPENAI_API_KEY=sk-…`) at normal sizes and only reads them at 4×. Plain
  queries also tolerate the engine's usual misreads (`_` read as `-`, `I` as
  `l`, `O` as `0`), so `OPENAI_API_KEY` still matches `OPENAI-APl-KEY`.
- The threat model now points to `find_text` as an aid for finding secrets,
  and says plainly that OCR is best-effort.

## [0.18.0]

### Added

- **`wait_for_change` tool** (#116). Instead of guessing a sleep, an agent
  can wait until a target changes (`mode: "change"`: a dialog opened, a page
  responded) or stops changing (`mode: "settle"`: a build finished, a page
  finished loading). Each check is a ~0.2 s low-resolution grab, compared cell
  by cell. The result reports the outcome (`changed` / `settled` / `timeout` /
  `cancelled`), elapsed time, and the changed regions in screen coordinates,
  plus a screenshot of the final state inline. A timeout is a normal result,
  not an error, and cancelling the request stops the wait.
- **`screen_diff` tool** (#116). It compares two screenshots or frames and
  returns an SSIM score, the share of the image that changed, and bounding
  boxes of the changed areas in `b`'s pixel coordinates, plus `b` inline with
  those areas outlined in red. Useful for checking that a UI change happened,
  and only where expected.

## [0.17.0]

### Added

- **`export_gif` tool** (#124). It exports an animated GIF or WebP that fits
  a file-size budget (`maxBytes`, default 10,000,000 bytes, under GitHub's
  10 MB image limit), for PRs, issues, and READMEs. GIF uses a two-stage
  palette tuned for screen content (`stats_mode=diff`, sierra dithering,
  rectangle diff mode); WebP uses `libwebp_anim`. If an attempt is over
  budget, fps, width, and palette size / quality step down, skipping ahead
  in proportion to how far over it was (at most 5 encodes, never past the
  smallest step). The result reports the settings used and every attempt's
  size. If nothing fits, the smallest attempt is kept with a note.
  `start` / `duration` export just part of the video.

## [0.16.0]

### Added

- **`contact_sheet` tool** (#115). It tiles N timestamped frames of a video
  into one image, so an agent can see a whole recording in a single image read
  instead of N. Frames are spread evenly (`mode: "even"`, default 12) or taken
  at the scene changes (`mode: "scenes"`, reusing #114's scan). Each tile is an
  accurate seek, scaled to `tileWidth` (default 320) and labelled with its
  timecode in the bundled font. The sheet comes back inline. `poster: true`
  writes a single representative frame instead: ffmpeg's `thumbnail` filter
  picks it from 30 candidates spread across the video.

## [0.15.0]

### Added

- **Scene-change sampling** (#114). `sample_frames { mode: "scenes" }` returns
  only the frames where the screen changed, plus the opening frame, so an agent
  can review a mostly static recording without paging through identical frames.
  A fast pass on a 320 px copy scores every frame (`select='gt(scene,T)'`); the
  strongest changes, up to `maxFrames`, are then grabbed at full resolution and
  reported with their `frameTimes`. `sceneThreshold` (default 0.1, tuned for UI
  content) sets how big a change counts, and a `capNote` explains when changes
  were left out.
- **`dedupe` for fps sampling** (#114). `dedupe: true` runs `mpdecimate` so
  frames nearly identical to the previous one are dropped.
- `sample_frames` accepts an explicit `mode` (`fps` / `timestamps` /
  `scenes`). It defaults to whichever of `fps` or `timestamps` is given, so
  existing calls are unchanged.

## [0.14.3]

### Fixed

- **One server instance could undo another's session updates** (#55).
  `persist()` merged with the registry on disk, but every record in memory
  won, including other instances' records loaded at boot and never touched
  since. So if instance A had loaded B's live recording, and B then stopped
  it, A's next unrelated write flipped it back to "recording". Only records
  this instance created or changed now override the disk copy; everything
  else is taken from disk, and the in-memory view is refreshed after each
  write.
- **Registry writes are now locked across processes** (#55). Read-merge-write
  runs under an `O_EXCL` lockfile (`sessions.json.lock`, holding the owner's
  pid and a timestamp). A stale lock (dead owner, or older than 10 s) is taken
  over, and after 2 s of contention the write goes ahead with a warning rather
  than failing a recording. A test runs six processes writing 25 records each
  to one registry and checks none are lost.
- **Windows: registry writes could crash with `EPERM`.** Renaming the temp
  file over `sessions.json` failed while another process had it open. Reads
  now also take the lock, and the rename retries briefly on
  `EPERM`/`EBUSY`/`EACCES` (antivirus and indexers can hold the file
  momentarily). Re-creating a lock that is still "delete pending" (`EPERM`) is
  treated as busy rather than as a reason to write unlocked.

## [0.14.2]

### Fixed

- **`screenshot` is about 10x faster** (#88). A repeat screenshot went from
  about 2.6 s to about 0.25 s. Most of the time was not the PowerShell shim the
  issue suspected but gdigrab itself: stills were grabbed at `-framerate 1`,
  which makes ffmpeg wait about two frame intervals (~2 s) before writing the
  single frame. Stills now grab at 30 fps, which is pixel-identical and takes
  ~0.2 s.
- **Target resolution no longer blocks the server** (#88). The monitor and
  window queries ran PowerShell synchronously, so no other MCP message
  (including a cancellation or `list_sessions`) was handled meanwhile. They now
  run asynchronously; a `list_sessions` sent during a screenshot returns in
  ~1 ms instead of waiting. The monitor layout is also cached for 5 s
  (concurrent callers share one query; failures are not cached). Window
  positions are always queried fresh.

## [0.14.1]

### Added

- **MCP Registry listing** (#90). A `server.json` describes the server for the
  official MCP Registry, `package.json` gains the matching `mcpName`
  (`io.github.TMHSDigital/screencast-mcp`), and the publish workflow lists each
  new release in the registry right after the npm publish. It authenticates
  with GitHub OIDC (no secret) and uses a pinned, checksum-verified
  `mcp-publisher`. A test keeps `server.json` and `package.json` in sync.

## [0.14.0]

### Added

- **`exactTitle` for window targets** (#89). `screenshot` and
  `start_recording` accept `exactTitle: true`, which matches only a window
  whose title equals the given title (case-insensitive) and never falls back
  to a substring match. When nothing matches exactly, the error lists the
  windows that contain the title.

### Fixed

- **`start_recording` now reports which window it is recording** (#89). It
  used to drop the match, so an agent recording `window:Code` never learned it
  had matched, say, a chat window titled "Code review". Both capture tools now
  return `matchedWindow`, `matchCount`, `matchKind` (`exact` / `substring`),
  and the captured `region`, and add a `windowWarning` listing the candidate
  titles when the match was only a substring or several windows matched. The
  session record keeps `matchedWindow`, so `get_session` shows it too.

### Changed

- `screenshot`'s `region` for a window target is now just the rectangle
  (`x`, `y`, `width`, `height`); the match details moved to the top-level
  fields above.

## [0.13.0]

### Added

- **Progress notifications and cancellation for edit jobs** (#81). Every edit
  and produce tool now runs ffmpeg with `-progress pipe:1`. When the request
  carries a `progressToken`, progress is sent as MCP `notifications/progress`
  (0-100, whole-percent steps). Cancelling the request stops ffmpeg.

### Fixed

- **Long edits no longer hit a fixed timeout** (#81). Jobs used a hardcoded
  5-20 minute limit, so compressing or exporting a long recording could fail
  partway. The timeout now scales with the media's length (at least 10
  minutes, or 4x the duration; 30 minutes when the length is unknown), and
  `SCREENCAST_JOB_TIMEOUT_MS` overrides it.
- **A failed edit no longer leaves a truncated file behind** (#81). ffmpeg
  now writes `<name>.partial.<ext>`, which is renamed onto the output only on
  success and deleted on any failure, timeout, or cancellation. Before, the
  leftover file also made a retry to the same path fail with "Output already
  exists".
- **A killed ffmpeg is waited on before the call returns.** On a timeout or
  cancellation, `runCapture` rejected as soon as it sent the kill; on Windows
  the dying process still held its output open, so cleanup failed with
  `EPERM`. It now settles after the process exits (5 s grace).

## [0.12.0]

### Changed

- **Node.js 22 or newer is now required** (#86). Node 20 reached end of life
  on 2026-04-30. `engines.node` is now `>=22`, and CI tests Node 22 and 24
  (previously 20 and 22).
- **zod 4 and MCP SDK 1.32.2** (#86). zod 3 had a high-severity advisory
  (GHSA-mrhx-c7xc-m3w5, memory exhaustion validating oversized constrained
  collections) that is fixed only in zod 4.6.6+, and zod validates every
  tool's input here. Each tool's published `inputSchema` was diffed before and
  after the upgrade. Two things changed, and neither changes which arguments
  are accepted: integer fields now list `maximum: 9007199254740991`, and
  objects no longer state `additionalProperties: false` (unknown keys were and
  still are stripped, not rejected). `npm audit` is now clean; the remaining
  transitive advisories (`body-parser`, `fast-uri`, `ip-address`) were in the
  SDK's HTTP transports, which this stdio server does not use.

### Added

- A non-blocking `npm audit --omit=dev --audit-level=high` step in CI.

## [0.11.1]

### Fixed

- **`sample_frames` can no longer write an unbounded number of frames** (#80).
  `fps: 30` on a 1-hour recording used to write about 108,000 full-resolution
  PNGs and list every path in one response. A new `maxFrames` limit (default
  100, max 1000) now applies. In `fps` mode the video is probed first; when the
  rate would exceed the cap, it is lowered so the frames still span the whole
  video, and the result reports `requestedFps` and a `capNote`. ffmpeg also
  gets `-frames:v <maxFrames>` as a backstop for videos whose length cannot be
  probed. In `timestamps` mode, more timestamps than `maxFrames` is rejected
  with a clear error.

## [0.11.0]

### Added

- **Frames come back inline as images** (#79). `screenshot` and
  `sample_frames` now append MCP `image` blocks after the JSON result, so a
  client shows the frames to the model directly and no filesystem or
  image-reading tool is needed. Inline images are downscaled JPEGs
  (`maxImageWidth`, default 1280). `sample_frames` embeds at most
  `maxInlineImages` frames (default 8, max 20) and says how many it left out;
  every frame is still written to disk at full resolution and listed by path.
  Pass `returnImage: false` / `returnImages: false` to get paths only. The JSON
  result reports the embedded count as `inlineImages`.

## [0.10.0]

### Fixed

- **A recording no longer keeps capturing after the MCP client disconnects**
  (#76). The server had no shutdown path. The ffmpeg child's pipes kept the
  event loop alive, so on a client disconnect both the server and ffmpeg kept
  running and the screen kept being recorded. The next server start also
  skipped reaping it, because the old server still looked alive. The server now
  finalizes every active recording (a graceful `q`, falling back to a kill)
  and exits when stdin ends, the transport closes, or it receives SIGINT,
  SIGTERM, or SIGHUP. The whole pass is capped at 10 s.

### Added

- **`start_recording` `maxDurationSec`** (#82). This is an auto-stop cap
  passed to ffmpeg as `-t`, so the file finalizes cleanly. The default is 3600 s
  (override with `SCREENCAST_MAX_RECORDING_SEC`); `0` disables it.
- Session records carry `endReason` (`stopped` | `max_duration` | `crashed`
  | `shutdown`), shown by `get_session`, `list_sessions`, and
  `stop_recording`.

### Changed

- Recordings are now capped at one hour by default. Pass `maxDurationSec: 0`
  (or set `SCREENCAST_MAX_RECORDING_SEC=0`) to restore unlimited capture.
- The graceful-stop sequence moved from `stop_recording` into
  `src/utils/lifecycle.ts` (`stopSession` / `stopAll`) and is shared with
  server shutdown.

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
