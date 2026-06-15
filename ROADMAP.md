<!-- standards-version: 1.10.0 -->

# Roadmap

**Current:** v0.2.0 (Phase 1)

Screencast MCP ships in phases. Phase 1 is the capture / watch / minimal-edit
core. Later phases add the full edit surface and a production layer.

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

- [ ] Audio capture (dshow / WASAPI loopback) - the clean seam is already in place
- [ ] `crop`, `scale`, `speed`, `overlay`, `extract`, `compress`
- [ ] Re-encode trim option for frame-accurate cuts

## Phase 3 -- Produce / trailer layer

- [ ] `assemble_highlights`, `title_card`, `music_bed`
- [ ] `xfade` transitions, aspect variants, platform presets

## Cross-platform

- [ ] Capture backends beyond gdigrab (avfoundation on macOS, x11grab on Linux)
