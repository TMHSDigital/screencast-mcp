/**
 * Opt-in toolsets and the server instructions (#214).
 *
 * The full tool list costs an agent many thousand tokens of context on every
 * turn. SCREENCAST_TOOLSETS lets a deployment expose only the groups it uses
 * (e.g. `capture,watch`); unset or `all` keeps every tool. The `core` tools
 * (doctor, get_media_info) are always on. Pure, so it is unit-tested directly.
 */

export const TOOLSETS = {
  core: ["doctor", "get_media_info"],
  capture: [
    "start_recording",
    "stop_recording",
    "pause_recording",
    "resume_recording",
    "save_replay",
    "list_sessions",
    "get_session",
    "read_events",
    "add_marker",
    "screenshot",
    "list_targets",
    "list_audio_devices",
    "list_video_devices",
  ],
  watch: [
    "sample_frames",
    "contact_sheet",
    "screen_diff",
    "wait_for_change",
    "find_text",
    "index_recording",
    "search_recording",
    "review_recording",
    "player_frames",
  ],
  edit: [
    "pipeline",
    "trim",
    "clip",
    "concat",
    "convert",
    "export_gif",
    "crop",
    "scale",
    "speed",
    "compress",
    "redact_region",
    "cut_idle",
    "cut_by_transcript",
  ],
  produce: [
    "callout",
    "keystroke_overlay",
    "cursor",
    "backdrop",
    "overlay",
    "zoom",
    "reframe",
    "title_card",
    "xfade_transition",
    "assemble_highlights",
    "export_preset",
    "burn_subtitles",
    "chapters",
    "bug_report",
    "step_guide",
  ],
  audio: ["extract_audio", "normalize_audio", "denoise", "transcribe", "music_bed", "narrate"],
} as const satisfies Record<string, readonly string[]>;

export type ToolsetName = keyof typeof TOOLSETS;

/** The toolsets a user can select (core is always on). */
export const SELECTABLE_TOOLSETS = (Object.keys(TOOLSETS) as ToolsetName[]).filter((t) => t !== "core");

/** The toolset a tool belongs to, or undefined for an unknown tool. */
export function toolsetOf(tool: string): ToolsetName | undefined {
  return (Object.keys(TOOLSETS) as ToolsetName[]).find((t) => (TOOLSETS[t] as readonly string[]).includes(tool));
}

export interface ToolsetSelection {
  /** Enabled toolsets, always including core. */
  enabled: ToolsetName[];
  /** Names in the setting that are not toolsets (ignored). */
  unknown: string[];
  /** True when every toolset is enabled. */
  all: boolean;
}

/**
 * Parse SCREENCAST_TOOLSETS: a comma-separated list of toolset names, or
 * `all`. Unset, empty, `all`, or a value naming no known toolset enables
 * everything, so a typo can never hide the whole server.
 */
export function parseToolsets(value: string | undefined): ToolsetSelection {
  const names = (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const everything: ToolsetSelection = { enabled: Object.keys(TOOLSETS) as ToolsetName[], unknown: [], all: true };
  if (names.length === 0 || names.includes("all")) {
    return { ...everything, unknown: names.filter((n) => n !== "all" && !(n in TOOLSETS)) };
  }
  const unknown = names.filter((n) => !(n in TOOLSETS));
  const chosen = new Set<ToolsetName>(["core", ...(names.filter((n) => n in TOOLSETS) as ToolsetName[])]);
  if (chosen.size === 1) return { ...everything, unknown };
  const enabled = (Object.keys(TOOLSETS) as ToolsetName[]).filter((t) => chosen.has(t));
  return { enabled, unknown, all: enabled.length === Object.keys(TOOLSETS).length };
}

/**
 * Server instructions: the workflow map, sent once at initialize, so each
 * tool's own description can stay short. Mentions only enabled toolsets.
 */
export function serverInstructions(selection: ToolsetSelection): string {
  const on = new Set(selection.enabled);
  const lines = [
    "Screencast MCP: record the Windows screen, let the model see it, and edit the result with ffmpeg.",
    "Targets (capture tools): full | monitor:<i> | window:<title> | window:exe=<app.exe> | window:hwnd=<n> | " +
      "region:<x>,<y>,<w>,<h>." + (on.has("capture") ? " list_targets returns ready-made target strings." : ""),
  ];
  if (on.has("capture")) {
    lines.push(
      "Capture: screenshot for a still; start_recording -> (do the task) -> stop_recording for video " +
        "(events: true also logs clicks for read_events and zoom). For flaky failures, start_recording " +
        "{ replayBufferSec } keeps a rolling buffer and save_replay writes the last seconds after the fact. " +
        "pause_recording/resume_recording skip setup; backend ddagrab uses the GPU. " +
        "Never start a recording the user did not ask for.",
    );
  }
  if (on.has("watch")) {
    lines.push(
      "Look: contact_sheet is the cheapest overview, sample_frames (mode scenes) for detail, find_text for OCR " +
        "and secret finding, wait_for_change instead of sleeping, screen_diff to compare two states. " +
        "Long recording: index_recording once, then search_recording finds moments as text.",
    );
  }
  if (on.has("edit")) {
    lines.push(
      "Edit: prefer one pipeline call (trim, crop, scale, speed, cut_idle, redact, callout, keystroke_overlay, reframe, zoom, backdrop, " +
        "audio, burn_subtitles, then export_preset or export_gif) over chaining single-edit tools; each tool call re-encodes. " +
        "To polish a raw recording, start from pipeline recipe pr_demo, tutorial or social_reel (dryRun shows its steps). trim = one " +
        "segment, clip = several files; export_gif for size-bounded GIF/WebP, compress for a smaller mp4.",
    );
  }
  if (on.has("produce")) {
    lines.push(
      "Produce: callout, zoom, keystroke_overlay, cursor, backdrop, overlay, title_card, xfade_transition, assemble_highlights, burn_subtitles, export_preset.",
    );
  }
  if (on.has("produce")) {
    lines.push(
      "Bug reports: bug_report turns a recording (path or sessionId) into one redacted folder: clip, GIF, " +
        "contact sheet, steps from the event log, OCR'd error text, environment, and report.md.",
    );
  }
  if (on.has("capture") || on.has("produce")) {
    const marks = [
      on.has("capture") && "add_marker stamps a labelled moment during a recording (or at a second of a file).",
      on.has("produce") && "chapters writes markers, scene changes, or a transcript as mp4/mkv chapters plus YouTube text.",
      on.has("edit") && "pipeline chapters: true keeps markers as chapters through trims and speed.",
    ];
    lines.push(`Markers: ${marks.filter(Boolean).join(" ")}`);
  }
  if (on.has("audio")) {
    lines.push("Audio: extract_audio, normalize_audio, denoise, music_bed, narrate (offline voiceover); transcribe makes an SRT for burn_subtitles (words: true for word timing, then cut_by_transcript cuts by quoting it).");
  }
  lines.push(
    "Outputs go under SCREENCAST_HOME unless a call names a path; times are seconds and positions video pixels. " +
      "Screen content can include secrets: redact (find_text redact: true -> redact_region) before sharing. " +
      "doctor diagnoses a missing ffmpeg feature.",
  );
  if (!selection.all) {
    lines.push(
      `Enabled toolsets: ${selection.enabled.join(", ")} (SCREENCAST_TOOLSETS); other tools are not loaded.`,
    );
  }
  return lines.join("\n");
}
