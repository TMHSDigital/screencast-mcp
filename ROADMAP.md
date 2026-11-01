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

**Typed metadata, setup, and docs** (0.43.0). `registerTool` with titles,
annotations, and output schemas (#212); FFmpeg 8 up front, `doctor`, and a
slimmer tarball (#195); `list_targets` (#213); docs, positioning, and release
process (#193, #194, #196, #216, #217, #219, #224).

**Smaller tool surface and safety** (0.44.0 to 0.44.2). Server instructions,
opt-in toolsets, and merged tools (#214); output paths confined to MCP roots or
`SCREENCAST_ALLOWED_DIRS` (#221); opt-in capture consent through elicitation
(#222); typed tests and stricter TypeScript (#220); an agent eval harness
(#223).

**Agent workflows** (0.45.0). `bug_report` (#198), instant replay with
`save_replay` (#197), `keystroke_overlay` (#169), `backdrop` (#171), and
markers and chapters (#174).

**Pipeline polish and search** (0.46.0). Pipeline ops for `cut_idle`, audio,
subtitles, and click zoom, plus named recipes (#244); `index_recording` /
`search_recording` (#245); `step_guide` (#172); transcript-based editing
(#173).

**GPU capture and reach** (0.47.0). `ddagrab` and hardware encoders (#199);
`pause_recording` / `resume_recording` and webcam picture-in-picture (#200);
a re-rendered cursor with spotlight (#170); `narrate` voiceover (#175); a
Claude Code plugin (#177); a headless CLI and GitHub Action (#179); generated
tool reference pages and `llms.txt` (#202).

**Hardening and onboarding** (0.48.0). Network paths refused and input paths
confined; recipe overrides in source space (#251); pause/resume/stop serialized
(#252); encoder size limits and x264 retry (#253); `narrate` and OCR past the
command-line limit (#254); index and search fixes (#255, #266); `.srt` sidecars
(#256); CLI and Action robustness (#257); bounded replay event log (#258);
transcript cue numbers and `step_guide` size (#259); FFmpeg 8 on every CI leg
and timestamp-based smoke tests (#260); every tool tested through MCP, with
coverage (#261); `screencast-mcp setup` (#267); the Action's sticky PR comment
(#268).

## Now

- Capture consent by default when the client supports elicitation (#266)
- Publish the Action to GitHub Marketplace (#264)
- Protect `main` with a ruleset that requires CI (#218)

## Next

- Windows on ARM64: verify capture, OCR, and WGC, and keep a `windows-11-arm` CI leg (#246)
- Visual baseline assertions ("golden flows") for desktop-app regression tests in CI (#269)
- Scheduled agent evals and a tool-selection scoreboard (#270)
- Directory listings and install badges (#178)
- Sharing via S3-compatible storage and YouTube upload (#176)
- A commercial-use path for the NC license (#201)
- Launch and community: Discussions, a gallery, a launch video (#271)

Bigger bets, not yet scheduled:

- A flight recorder for computer-use agents (#272)
- Remote Windows capture over Streamable HTTP (#273)

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
  both rename or merge tools. Met in 0.43.0 and 0.44.0.
- Tool-layer tests cover every tool through an MCP client. Met in 0.48.0 (#261):
  a guard test fails when a registered tool has no case.
- No open `bug` issues at high priority.
- Release hygiene: curated, dated release notes and no docs-only releases
  (#219). Met in 0.43.0.
