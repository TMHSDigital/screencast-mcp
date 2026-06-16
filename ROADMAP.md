<!-- standards-version: 1.10.0 -->

# Roadmap

**Current:** v0.8.8 shipped (Phase 3 complete; hardening rounds underway, see
CHANGELOG). Cross-platform capture is the next feature phase.

Screencast MCP ships in phases. Phase 1 is the capture / watch / minimal-edit
core. Phase 2 adds the full edit surface, safety redaction, and system audio.
Phase 3 adds the produce / trailer layer. Phases 1 to 3 are shipped; the work
since has been correctness hardening. Phase 4 onward is proposed below.

## Phase 1 -- Capture, watch, minimal edit (shipped)

- [x] stdio MCP server (`@modelcontextprotocol/sdk`), npm-publishable
- [x] ffmpeg / ffprobe detection with a clear install hint when missing
- [x] Capture: `start_recording`, `stop_recording`, `list_sessions`,
      `get_session`, `screenshot`
- [x] Session registry (in memory + on disk) with graceful stop and orphan reaping
- [x] Multi-monitor offsets and window-by-title via gdigrab
- [x] Watch: `sample_frames`, `get_media_info`
- [x] Minimal edit: `trim`, `concat`, `convert` (mp4 / gif / webm)
- [x] Quality presets (draft / standard / high) instead of raw ffmpeg flags
- [x] Threat-model documentation

## Phase 2 -- Full edit surface and audio (shipped)

- [x] `crop`, `scale`, `speed`, `overlay`, `compress`
- [x] `extract_audio` (extract the audio track) and `clip` (frame-accurate
      segment extraction; `extract` split into these two non-overlapping tools)
- [x] Re-encode trim option for frame-accurate cuts (delivered as `clip`; `trim`
      stays the fast stream-copy single cut)
- [x] `redact_region` safety redaction (declared regions, irreversible solid box)
- [x] System audio capture (dshow loopback) via the `start_recording` audio
      option and `list_audio_devices`. Microphone capture is deferred indefinitely.

## Phase 3 -- Produce / trailer layer (shipped)

- [x] `assemble_highlights` (stitch clips with cuts or transitions) and
      `xfade_transition` (crossfade two clips), with auto-normalized inputs
- [x] `title_card` (bundled font) and `music_bed` (loop, fade, mix, duck)
- [x] Aspect variants (`reframe`) and platform export presets (`export_preset`)

## Hardening -- correctness rounds (ongoing, v0.8.1+)

Bug-fix and robustness work on top of Phase 3, one focused PR per issue. Details
in CHANGELOG; representative items:

- [x] Recording lifecycle: a second server instance no longer kills another's
      live recording (#16); concurrency-aware, bounded session registry (#17)
- [x] Produce edge cases: `assemble_highlights` clip-duration vs transition
      validation (#18) and audio preservation on mixed inputs (#19)
- [x] `sample_frames` returns only frames this run actually wrote, in both fps
      (#20) and timestamps (#35) mode
- [x] Capture geometry: DPI-aware monitor enumeration (#39), odd region
      dimensions rounded to even for recording (#34), off-desktop region offsets
      rejected with a clear error (#41)
- [x] Audio device enumeration is capped and gives an actionable error instead
      of a 30s hang (#40)
- [x] Filter-string validation up front (#22); temp working files written to the
      OS temp dir (#24); ESLint + Windows CI + typecheck in CI (#21, #23)
- [ ] Open: odd output dimensions in edit/produce tools (#47), `concat` relative
      input paths (#48), `extract_audio` `copy` container mismatch (#36),
      overwrite protection for explicit output paths (#37)

## Phase 4 -- Cross-platform capture (next)

Capture today is Windows-only (gdigrab). Generalize the capture backend behind
the existing `Provider` interface so the same tools work on macOS and Linux.

- [ ] macOS capture via avfoundation (screen + window + region)
- [ ] Linux capture via x11grab, plus a PipeWire/Wayland path where X11 is absent
- [ ] Per-platform monitor/window enumeration behind one resolver (today's
      PowerShell shims are the Windows implementation of that seam)
- [ ] Capability reporting so a tool returns a clear "not supported on this
      platform" instead of a cryptic backend failure
- [ ] CI capture smoke tests on the macOS and Linux runners

## Phase 5 -- Captions and annotation (proposed)

Screencast-native polish that turns a raw capture into something watchable.

- [ ] `burn_subtitles` -- burn an SRT/ASS track into the video (styleable)
- [ ] `transcribe` -- optional speech-to-text to an SRT sidecar (pluggable
      engine; opt-in, no bundled model), feeding `burn_subtitles`
- [ ] `zoom_to` / cursor emphasis -- animated zoom-and-pan to a region, and a
      cursor highlight/spotlight, the highest-value screencast affordance
- [ ] `callout` -- timed text/arrow/box annotations over the video
- [ ] `keystroke_overlay` -- render captured keystrokes/clicks as on-screen badges
      (requires a capture-time input hook; scope TBD)

## Phase 6 -- Audio polish and delivery (proposed)

- [ ] `normalize_audio` -- EBU R128 loudness normalization (`loudnorm`)
- [ ] `denoise` -- background-noise reduction for narration
- [ ] `thumbnail` / `contact_sheet` -- single poster frame or a grid of frames
- [ ] Optimized GIF/WebP export (palette tuning, size budget) beyond `convert`
- [ ] Chapter markers / cue points written into the container
- [ ] `pipeline` -- chain several edits in one call to avoid intermediate files

## Cross-cutting backlog

Not tied to a single phase; pull in opportunistically.

- [ ] Overwrite protection: refuse to clobber an existing explicit `output`
      unless `overwrite: true` (#37)
- [ ] Node `engines` already declared; document the supported range in
      CONTRIBUTING
- [ ] Consistent input-path resolution (absolute) across all tools (see #48)
