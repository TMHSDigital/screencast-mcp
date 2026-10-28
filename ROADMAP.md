<!-- standards-version: 1.10.0 -->

# Roadmap

**Current:** see `package.json` and the [CHANGELOG](CHANGELOG.md). The
[issue tracker](https://github.com/TMHSDigital/screencast-mcp/issues) is the
source of truth for open work; this page groups it.

Versions below are npm versions. Tags 0.11.0 to 0.27.3 (and 0.1.0, 0.2.0,
0.8.13) never reached npm (#190); everything they carried first shipped on npm
in 0.33.0.

## Shipped

**Capture, watch, minimal edit.** stdio server; ffmpeg/ffprobe detection with an
install hint; `start_recording`, `stop_recording`, `list_sessions`,
`get_session`, `screenshot`; a locked, cross-process session registry with orphan
reaping; multi-monitor, region, and window targets (by title, `exe=`, `hwnd=`),
DPI-aware; `sample_frames` returning image content; `get_media_info`; `trim`,
`concat`, `convert`; quality presets.

**Full edit surface and audio.** `crop`, `scale`, `speed`, `overlay`,
`compress`, `clip`, `extract_audio`, `redact_region` (solid box by default),
system-audio capture and `list_audio_devices`.

**Produce.** `assemble_highlights`, `xfade_transition`, `title_card`,
`music_bed`, `reframe`, `export_preset`, `export_gif`, `contact_sheet`, and
`pipeline` (several edits as one ffmpeg process).

**Captions, annotation, audio polish** (0.33.0). `transcribe` (FFmpeg 8
whisper) and `burn_subtitles` (#120); `zoom`, including zoom toward clicks and
click rings (#119); the input event log and `read_events` (#118); `callout`
(#121); `cut_idle` (#122); `normalize_audio` and `denoise` (#123).

**Agent loop.** `wait_for_change`, `screen_diff`, `find_text` (Windows OCR,
whole-clip scans), the review player MCP App with `review_recording` and
`player_frames` (#128), MCP prompts and resources (#126), and the Windows
Graphics Capture backend for covered windows (`backend: "wgc"`, #113).

**Distribution and hardening.** npm with provenance, the MCP Registry listing
(#90), a one-click Claude Desktop bundle (#127), the docs site with workflow
recipes (#129), ffmpeg-backed integration and tool-layer tests on Windows with
FFmpeg 8 (#78, #192), CodeQL, releases gated on green CI (#190), and several
correctness rounds (A/V sync, job timeouts and cancellation, privacy and
retention, see CHANGELOG).

## Now

- Typed tool metadata: `registerTool` with titles, annotations, and output schemas (#212)
- Setup friction: FFmpeg 8 up front, a `doctor` / capabilities tool, a slimmer tarball (#195), and `list_targets` (#213)
- Docs, positioning, and release process: #193, #194, #196, #216, #217, #219, #224
- Protect `main` with a ruleset that requires CI (#218)

## Next

Agent workflows

- `bug_report`: one call from recording to redacted repro package (#198)
- Instant replay: a rolling buffer and `save_replay` (#197)
- `index_recording` / `search_recording`: a searchable text timeline (#245)
- `step_guide`: a recording into a step-by-step how-to (#172)
- A smaller tool surface: server instructions, opt-in toolsets, merged tools (#214)

Editing and polish

- Pipeline ops for `cut_idle`, audio, subtitles, click zoom, plus named recipes (#244)
- `keystroke_overlay` (#169), a re-rendered cursor with spotlight (#170), `backdrop` (#171)
- Transcript-based editing (#173), markers and chapters (#174), `narrate` voiceover (#175)

Capture

- GPU capture: `ddagrab` and hardware encoders (#199)
- `pause_recording` / `resume_recording` and webcam picture-in-picture (#200)
- Windows on ARM64 (#246)

Safety and quality

- Confine output paths to MCP roots or `SCREENCAST_ALLOWED_DIRS` (#221)
- Opt-in capture consent through elicitation (#222)
- Typed tests and stricter TypeScript (#220); an agent eval harness (#223)

Reach

- Directory listings and install badges (#178), a Claude Code plugin (#177), a headless CLI and GitHub Action (#179), sharing via S3-compatible storage (#176)
- Generated tool reference pages and `llms.txt` (#202); a commercial-use path (#201)

## Not planned

- **Cross-platform capture** (x11grab / avfoundation, #15). Capture stays
  Windows-only. The watch, edit, and produce tools already run on any OS with
  ffmpeg.
- **Microphone capture.** System audio only.

## Path to 1.0

1.0 is a promise about the tool interface, not a feature milestone.

**What freezes at 1.0**

- Tool names, and the names, types, and meaning of existing parameters and
  result fields.
- Environment variable names and the default output layout under
  `SCREENCAST_HOME`.
- Prompt and resource names.

Adding a tool, an optional parameter, or a result field stays a minor release.

**Deprecation policy (from 1.0)**

- A tool or parameter to be removed is first marked deprecated in its
  description and in the CHANGELOG, and keeps working for at least one minor
  release.
- Removal or an incompatible change only happens in a major release.

**Criteria for 1.0**

- Tool metadata settled (#212) and the tool surface consolidated (#214), since
  both rename or merge tools.
- Tool-layer tests cover every tool through an MCP client (#192 started this).
- No open `bug` issues at high priority.
- Release hygiene: curated, dated release notes and no docs-only releases
  (#219).
