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
      "Requires ffmpeg and ffprobe (Windows: `winget install Gyan.FFmpeg`). Recordings stay on this computer.",
    author: { name: "TMHSDigital", url: "https://github.com/TMHSDigital" },
    homepage: "https://tmhsdigital.github.io/screencast-mcp/",
    repository: { type: "git", url: "https://github.com/TMHSDigital/screencast-mcp" },
    license: p.license,
    keywords: p.keywords,
    server: {
      type: "node",
      entry_point: "dist/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/index.js"],
        env: {
          SCREENCAST_HOME: "${user_config.screencast_home}",
          FFMPEG_PATH: "${user_config.ffmpeg_path}",
          FFPROBE_PATH: "${user_config.ffprobe_path}",
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
    },
    compatibility: {
      platforms: ["win32"],
      runtimes: { node: p.engines?.node ?? ">=22.0.0" },
    },
  };
}
