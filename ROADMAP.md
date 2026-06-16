<!-- standards-version: 1.10.0 -->

# Roadmap

**Current:** v0.5.0 (Phase 2 complete)

Screencast MCP ships in phases. Phase 1 is the capture / watch / minimal-edit
core. Phase 2 adds the full edit surface, safety redaction, and system audio.
A later phase adds a production layer.

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

## Phase 2 -- Full edit surface and audio

- [x] `crop`, `scale`, `speed`, `overlay`, `compress`
- [x] `extract_audio` (extract the audio track) and `clip` (frame-accurate
      segment extraction; `extract` split into these two non-overlapping tools)
- [x] Re-encode trim option for frame-accurate cuts (delivered as `clip`; `trim`
      stays the fast stream-copy single cut)
- [x] `redact_region` safety redaction (declared regions, irreversible solid box)
- [x] System audio capture (dshow loopback) via the `start_recording` audio
      option and `list_audio_devices`. Microphone capture is deferred indefinitely.

## Phase 3 -- Produce / trailer layer

- [x] `assemble_highlights` (stitch clips with cuts or transitions) and
      `xfade_transition` (crossfade two clips), with auto-normalized inputs
- [ ] `title_card`, `music_bed`
- [ ] Aspect variants (`reframe`) and platform export presets

## Cross-platform

- [ ] Capture backends beyond gdigrab (avfoundation on macOS, x11grab on Linux)
