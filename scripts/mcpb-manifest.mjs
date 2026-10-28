/** MCPB manifest (#127), shared by scripts/build-mcpb.mjs and its test. */

/** The bundle manifest (MCPB spec 0.3). Pure function of package.json + tools. */
export function buildManifest(p, toolList) {
  return {
    manifest_version: "0.3",
    name: "screencast-mcp",
    display_name: "Screencast MCP",
    version: p.version,
    description: p.description,
    long_description:
      "Record the screen, sample frames the model can see, and edit with ffmpeg: trim, annotate, redact, " +
      "export GIFs, normalize audio, read on-screen text, and wait for the screen to change. " +
      "Requires ffmpeg and ffprobe (Windows: `winget install Gyan.FFmpeg`). The server makes no network requests; what its tools return to your agent goes to your model provider like any tool result.",
    author: { name: "TMHSDigital", url: "https://github.com/TMHSDigital" },
    homepage: "https://tmhsdigital.github.io/screencast-mcp/",
    repository: { type: "git", url: "https://github.com/TMHSDigital/screencast-mcp" },
    license: p.license,
    keywords: p.keywords,
    // The REC viewfinder mark (#216); assets/ is copied into the bundle.
    icon: "assets/icon.png",
    server: {
      type: "node",
      entry_point: "dist/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/index.js"],
        env: {
          SCREENCAST_HOME: "${user_config.screencast_home}",
          SCREENCAST_ALLOWED_DIRS: "${user_config.allowed_dirs}",
          FFMPEG_PATH: "${user_config.ffmpeg_path}",
          FFPROBE_PATH: "${user_config.ffprobe_path}",
          SCREENCAST_WHISPER_MODEL: "${user_config.whisper_model}",
          SCREENCAST_MAX_RECORDING_SEC: "${user_config.max_recording_sec}",
          SCREENCAST_JOB_TIMEOUT_MS: "${user_config.job_timeout_ms}",
          SCREENCAST_RETENTION_DAYS: "${user_config.retention_days}",
          SCREENCAST_PS_TIMEOUT_MS: "${user_config.ps_timeout_ms}",
          SCREENCAST_CONFIRM_CAPTURE: "${user_config.confirm_capture}",
          SCREENCAST_TOOLSETS: "${user_config.toolsets}",
        },
      },
    },
    tools: toolList.map((t) => ({ name: t.name, description: t.description })),
    prompts_generated: true,
    user_config: {
      screencast_home: {
        type: "directory",
        title: "Output folder",
        description: "Where recordings, frames, screenshots, and edits are saved (default: ~/.screencast-mcp).",
        required: false,
      },
      allowed_dirs: {
        type: "string",
        title: "Allowed output folders",
        description:
          "Semicolon-separated folders a call may write outside the output folder. When set (or when the client " +
          "sends workspace roots), outputs anywhere else are refused.",
        required: false,
      },
      ffmpeg_path: {
        type: "file",
        title: "ffmpeg.exe",
        description: "Only needed if ffmpeg is not on PATH.",
        required: false,
      },
      ffprobe_path: {
        type: "file",
        title: "ffprobe.exe",
        description: "Only needed if ffprobe is not on PATH.",
        required: false,
      },
      // Every env var the README documents is settable here (#216). Each one
      // is optional; the server treats an empty value as unset.
      whisper_model: {
        type: "file",
        title: "Whisper model",
        description: "whisper.cpp model file (ggml-*.bin) for `transcribe`, so calls need not pass `model`.",
        required: false,
      },
      max_recording_sec: {
        type: "number",
        title: "Max recording length (seconds)",
        description: "Default recording cap when a call does not set maxDurationSec. 0 disables it.",
        required: false,
        default: 3600,
        min: 0,
        max: 604800,
      },
      job_timeout_ms: {
        type: "number",
        title: "Edit job timeout (ms)",
        description: "Override the edit/produce job timeout. Leave empty to scale it with the media length.",
        required: false,
        min: 1,
      },
      retention_days: {
        type: "number",
        title: "Capture retention (days)",
        description: "At startup, delete screenshots, frames, and leftover raw event logs older than this. Never recordings or edits. Leave empty to keep everything.",
        required: false,
        min: 1,
      },
      ps_timeout_ms: {
        type: "number",
        title: "PowerShell helper timeout (ms)",
        description: "Limit for the helpers that list monitors and windows and run OCR (default 20000; OCR 60000).",
        required: false,
        min: 1,
      },
      confirm_capture: {
        type: "boolean",
        title: "Confirm each capture",
        description:
          "Ask before every recording, screenshot, live find_text, and wait_for_change, showing what will be " +
          "captured. Needs a client that supports MCP elicitation; others are refused.",
        required: false,
        default: false,
      },
      toolsets: {
        type: "string",
        title: "Toolsets",
        description:
          "Comma-separated tool groups to load: capture, watch, edit, produce, audio (doctor and get_media_info " +
          "are always on). Leave empty for all; fewer tools means less context per turn.",
        required: false,
      },
    },
    compatibility: {
      platforms: ["win32"],
      runtimes: { node: p.engines?.node ?? ">=22.0.0" },
    },
  };
}
