// Generate the workflow recipe pages and the Connect page under docs/.
// The pages are committed static HTML; edit the data below and run
//   node scripts/build-docs-pages.mjs docs
// docs/index.html and docs/404.html are written by hand.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const docs = process.argv[2] ?? "docs";
mkdirSync(join(docs, "workflows"), { recursive: true });
const SITE = "https://tmhsdigital.github.io/screencast-mcp/";

function page({ path, title, description, root, crumbs, body }) {
  const url = SITE + path.replace(/index\.html$/, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Screencast MCP</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${url}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='34' fill='%23FF4545'/></svg>">
  <meta property="og:title" content="${title} — Screencast MCP">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="Screencast MCP">
  <meta property="og:image" content="https://tmhsdigital.github.io/screencast-mcp/media/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Screencast MCP: give your agent eyes on the screen. A recorded window zooms in on a clicked Save button.">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://tmhsdigital.github.io/screencast-mcp/media/og.png">
  <link rel="preload" href="${root}fonts/bricolage-grotesque-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="${root}fonts/figtree-latin.woff2" as="font" type="font/woff2" crossorigin>
  <script>document.documentElement.classList.add("js")</script>
  <link rel="stylesheet" href="${root}site.css">
</head>
<body>
  <header class="hud" aria-label="Recording status bar">
    <div class="hud-left">
      <span class="rec-dot" aria-hidden="true"></span>
      <span class="rec-label">REC</span>
      <span id="tc">00:00:00;00</span>
    </div>
    <div class="hud-right">
      <a class="home" href="${root}">screencast-mcp</a>
      <a href="${root}workflows/"${path.startsWith("workflows") ? ' class="here"' : ""}>Workflows</a>
      <a href="${root}connect.html"${path === "connect.html" ? ' class="here"' : ""}>Connect</a>
      <a class="gh" href="https://github.com/TMHSDigital/screencast-mcp">GitHub &nearr;</a>
    </div>
  </header>

  <main class="wrap">
    <section class="page-head">
      <p class="crumbs">${crumbs}</p>
${body}
    <footer>
      <span>Built by <a href="https://github.com/TMHSDigital">TMHSDigital</a></span>
      <span>License: <a href="https://github.com/TMHSDigital/screencast-mcp/blob/main/LICENSE">CC BY-NC-ND 4.0</a> &middot; free for non-commercial use</span>
    </footer>
  </main>

  <script src="${root}site.js"></script>
</body>
</html>
`;
}

const take = (call, why, ret) =>
  `        <li><span class="call">${call}</span>${why ? `<span class="why">${why}</span>` : ""}${ret ? `<span class="ret">${ret}</span>` : ""}</li>`;
const b = (name) => `<b>${name}</b>`;

const RECIPES = [
  {
    slug: "bug-repro", n: "01", name: "Bug-repro clip for a PR",
    chain: "start_recording → find_text → redact_region → trim → callout → export_gif",
    description: "Have your agent record a bug, hide the secrets on screen, trim it, mark the problem, and export a GIF small enough for a GitHub PR.",
    lede: "A reviewer understands a bug faster from five seconds of video than from five paragraphs. The agent records the repro, finds and covers anything secret on screen, cuts it to the moment that matters, points at the problem, and hands back a GIF that fits GitHub's 10 MB limit.",
    prompt: "Record the Demo Settings window while I click Save. Then hide the API key, trim it to the save, put a box on the Save button saying it hangs, and give me a GIF for the PR.",
    takes: [
      take(`${b("start_recording")} { "target": "window:Demo Settings", "fps": 15 }`, "Matches the window by title and records just its frame.", `{ "sessionId": "rec-…", "matchKind": "exact", "region": { "width": 602, "height": 352 } }`),
      take(`${b("stop_recording")} { "sessionId": "rec-…" }`, "Quits ffmpeg cleanly so the mp4 is finalized.", `{ "durationSec": 7.07, "finalizedGracefully": true }`),
      take(`${b("find_text")} { "input": "rec-….mp4", "timestamp": 0.5, "query": "sk-[\\\\w-]+", "regex": true, "redact": true }`, "Windows OCR reads the frame and returns a padded rectangle for each match. Match on a prefix: OCR read this key's <code>live</code> as <code>1ive</code>.", `{ "matchCount": 1, "redactRegions": [{ "x": 152, "y": 121, "width": 196, "height": 22 }] }`),
      take(`${b("redact_region")} { "input": "rec-….mp4", "regions": [{ "x": 152, "y": 121, "width": 196, "height": 22 }] }`, "Covers the rectangle for the whole clip (a solid box by default; <code>style</code> can be blur or pixelate).", `{ "outputPath": "redact-….mp4", "regions": 1 }`),
      take(`${b("find_text")} { "input": "redact-….mp4", "timestamp": 0.5, "query": "sk-" }`, "Check the redaction worked before anything leaves the machine.", `{ "matchCount": 0 }`),
      take(`${b("trim")} { "input": "redact-….mp4", "start": 0.5, "end": 5 }`, "", `{ "outputPath": "trim-….mp4" }`),
      take(`${b("callout")} { "input": "trim-….mp4", "items": [<br>&nbsp;&nbsp;{ "type": "box", "x": 28, "y": 178, "width": 128, "height": 50, "from": 0.3, "to": 2.6, "color": "red" },<br>&nbsp;&nbsp;{ "type": "text", "x": 170, "y": 188, "text": "Save hangs for 2.5 s", "size": 22, "color": "red", "from": 0.3, "to": 2.6 } ] }`, "Timed annotations, drawn only while the bug is on screen.", `{ "outputPath": "callout-….mp4", "callouts": 2 }`),
      take(`${b("export_gif")} { "input": "callout-….mp4", "width": 480, "fps": 10, "maxBytes": 2000000 }`, "Steps fps, width, and colors down until the file fits the budget.", `{ "sizeBytes": 71206, "withinBudget": true, "settings": { "fps": 10, "width": 480, "colors": 256 } }`),
    ],
    output: { src: "../media/bug-repro.gif", w: 480, h: 281, alt: "A settings window with the API key covered by a black box. A red box and the label 'Save hangs for 2.5 s' point at the Save button until a progress bar fills and a green Saved banner appears.", cap: `<span class="tc">bug-repro.gif</span> · 480 × 281 · 70 KB · the real output of the calls above` },
    after: `<p>Drop the GIF into the PR description. <code>find_text</code> is best-effort: OCR can miss small or stylised text, so look at a frame before you share. If you know where a secret sits, pass the rectangle to <code>redact_region</code> yourself.</p>`,
  },
  {
    slug: "demo-gif", n: "02", name: "README demo GIF",
    chain: "start_recording → contact_sheet → export_gif (webp)",
    description: "Record a feature, check the take at a glance, and export an animated WebP or GIF sized for a README.",
    lede: "A README gets one shot at showing what the project does. Record the feature, look over the take as one image before you spend time on it, then export an animation sized for the page. Animated WebP is usually much smaller than GIF for the same frames, and GitHub renders both.",
    prompt: "Record the Demo Settings window for about five seconds while the save runs, show me the take, and make a WebP under 3 MB for the README.",
    takes: [
      take(`${b("start_recording")} { "target": "window:Demo Settings", "fps": 15 }`, "", `{ "sessionId": "rec-…", "matchedWindow": "Demo Settings" }`),
      take(`${b("stop_recording")} { "sessionId": "rec-…" }`, "", `{ "durationSec": 6.53, "finalizedGracefully": true }`),
      take(`${b("contact_sheet")} { "input": "rec-….mp4", "mode": "scenes" }`, "One image with a timestamped tile at each point the screen changed, returned inline for the agent (and you) to check the take.", `{ "frameTimes": [0, 3], "columns": 2, "rows": 1 }`),
      take(`${b("export_gif")} { "input": "rec-….mp4", "format": "webp", "width": 480, "maxBytes": 3000000 }`, "", `{ "format": "webp", "sizeBytes": 37636, "withinBudget": true }`),
    ],
    output: { src: "../media/demo.webp", w: 480, h: 281, alt: "Animated WebP of the settings window: a progress bar fills under the Save button, then a green Saved banner slides in.", cap: `<span class="tc">demo.webp</span> · 480 × 281 · 37 KB. The same clip as a GIF was 99 KB.` },
    after: `<p>Reference it from the README with an ordinary image tag: <code>![Saving settings](docs/demo.webp)</code>. Need GIF for an older viewer? Drop <code>format</code>; the default budget is GitHub's 10 MB.</p>`,
  },
  {
    slug: "verify-ui", n: "03", name: "Agent UI verification loop",
    chain: "screenshot → wait_for_change → screen_diff → find_text",
    description: "Let a coding agent check its own UI change: screenshot, wait for the screen to settle, diff before and after, and read the result.",
    lede: "When an agent changes UI code, it should check the result the way a person would: look before, trigger the change, wait for the screen to stop moving, then see exactly what changed and read the text. No guessed <code>sleep</code>, and no burning a full-size image on every poll.",
    prompt: "Take a screenshot of Demo Settings, wait until the save finishes, and tell me what changed. Did it say Saved?",
    takes: [
      take(`${b("screenshot")} { "target": "window:Demo Settings" }`, "The before image. Returned inline by default so the model sees it.", `{ "outputPath": "shot-a.png", "region": { "width": 602, "height": 352 } }`),
      take(`${b("wait_for_change")} { "target": "window:Demo Settings", "mode": "change", "timeoutSec": 10 }`, "Returns as soon as anything on screen changes, with where it changed.", `{ "outcome": "changed", "elapsedSec": 0.87, "regions": [{ "x": 177, "y": 321, "width": 120, "height": 30 }] }`),
      take(`${b("wait_for_change")} { "target": "window:Demo Settings", "mode": "settle", "settleSec": 0.75, "timeoutSec": 10 }`, "Then waits until the screen has been still for 0.75 s: the save has finished animating.", `{ "outcome": "settled", "elapsedSec": 2.56, "changedWhileWaiting": true }`),
      take(`${b("screenshot")} { "target": "window:Demo Settings" }`, "The after image.", `{ "outputPath": "shot-b.png" }`),
      take(`${b("screen_diff")} { "a": "shot-a.png", "b": "shot-b.png" }`, "SSIM plus boxes around each changed area, drawn on the after image.", `{ "identical": false, "ssim": 0.8214, "changedFraction": 0.2833, "regions": [ 3 boxes ] }`),
      take(`${b("find_text")} { "input": "shot-b.png", "query": "Saved" }`, "Confirms the text, not just that pixels moved.", `{ "matchCount": 1, "matches": [{ "text": "Saved", "x": 21, "y": 301 }] }`),
    ],
    output: { src: "../media/diff.jpg", w: 602, h: 352, alt: "The settings window after saving, with red boxes around the three areas that changed: the Save button text, the progress bar, and the green Saved banner.", cap: `<span class="tc">screen_diff</span> · the highlighted after image it returns inline` },
    after: `<p>Each box is a place the agent can look closer, with <code>find_text</code> or a cropped screenshot. <code>screen_diff</code> on two identical images returns <code>identical: true</code>, so the loop can also prove nothing changed.</p>`,
  },
  {
    slug: "social-clip", n: "04", name: "Social clip",
    chain: "reframe → title_card → assemble_highlights → music_bed → normalize_audio → export_preset",
    description: "Turn a landscape screen recording into a vertical clip with a title card, music, normalized loudness, and a platform preset.",
    lede: "Screen recordings are landscape; short-form feeds are vertical. The agent re-aspects the recording, puts a title card in front, crossfades the two, lays music under it at a sane level, normalizes loudness, and encodes for the platform.",
    prompt: "Make a TikTok from the demo recording: 9:16 with the window letterboxed, a 1.5 s title card that says “Saving, fixed”, a fade into the clip, and this music under it.",
    takes: [
      take(`${b("reframe")} { "input": "rec-….mp4", "aspect": "9:16", "fit": "pad" }`, "<code>pad</code> letterboxes and keeps the whole window; <code>crop</code> fills the frame and loses the sides.", `{ "outputPath": "reframe-….mp4" }`),
      take(`${b("title_card")} { "text": "Saving, fixed", "duration": 1.5, "width": 1080, "height": 1920 }`, "", `{ "outputPath": "title-….mp4" }`),
      take(`${b("assemble_highlights")} { "clips": ["title-….mp4", "reframe-….mp4"], "transition": "fade", "width": 1080, "height": 1920 }`, "Normalizes size, fps, and audio first, so mixed clips join cleanly.", `{ "clips": 2, "transition": "fade" }`),
      take(`${b("music_bed")} { "video": "highlights-….mp4", "music": "music.wav", "musicVolume": 0.3 }`, "Loops or trims the track to the video and fades it in and out.", `{ "mixedWithOriginal": true }`),
      take(`${b("normalize_audio")} { "input": "music-….mp4", "target": "youtube" }`, "Two-pass loudnorm to −14 LUFS, the level most feeds normalize to anyway.", `{ "before": { "lufs": -41.59 }, "after": { "lufs": -14.05 } }`),
      take(`${b("export_preset")} { "input": "loudnorm-….mp4", "platform": "tiktok" }`, "", `{ "aspect": "9:16", "fps": 30 }`),
    ],
    output: { src: "../media/social.png", w: 736, h: 434, alt: "Three frames of the vertical clip: the title card fading into the letterboxed settings window, then the window with the Saved banner.", cap: `<span class="tc">contact_sheet</span> of the final tiktok-….mp4 · 1080 × 1920 · 30 fps` },
    after: `<p>Swap <code>platform</code> for <code>youtube</code>, <code>instagram_reel</code>, <code>x</code>, or <code>square</code>. Have narration? Run <code>transcribe</code> and <code>burn_subtitles</code> with <code>style: "social"</code> before the export: most feeds autoplay muted.</p>`,
  },
  {
    slug: "review-recording", n: "05", name: "Review a long recording cheaply",
    chain: "get_media_info → contact_sheet → sample_frames (scenes) → cut_idle",
    description: "Have an agent review a long screen recording without sending it hundreds of frames: contact sheet, scene sampling, and dead-air detection.",
    lede: "A model can't watch video, and sampling a long recording at a fixed rate burns tokens on near-identical frames. Get the shape of it from one image, pull full frames only where the screen changed, and find the dead air.",
    prompt: "What happens in this recording? Don't send me every frame. And how much of it is dead air?",
    takes: [
      take(`${b("get_media_info")} { "input": "rec-….mp4" }`, "Cheap, and tells the agent what it is dealing with.", `{ "durationSec": 7.07, "width": 602, "height": 352, "fps": 15 }`),
      take(`${b("contact_sheet")} { "input": "rec-….mp4", "count": 6, "columns": 3, "tileWidth": 320 }`, "The whole recording in one inline image, each tile stamped with its time.", `{ "frameTimes": [0.59, 1.77, 2.94, 4.12, 5.3, 6.48], "columns": 3, "rows": 2 }`),
      take(`${b("sample_frames")} { "input": "rec-….mp4", "mode": "scenes" }`, "Full-resolution frames only where the screen changed, plus the opening frame. <code>sceneThreshold</code> (default 0.1) sets how big a change counts.", `{ "frameTimes": [0, 2.87], "sceneChangesFound": 1 }`),
      take(`${b("cut_idle")} { "input": "rec-….mp4", "minIdleSec": 1, "dryRun": true }`, "<code>dryRun</code> reports the cuts without writing a file. Drop it to get the tightened video.", `{ "cuts": [{ "start": 3.267, "end": 6.667 }], "removedSec": 3.4, "newDurationSec": 3.67 }`),
    ],
    output: { src: "../media/contact-sheet.png", w: 976, h: 388, alt: "A 3 by 2 grid of frames from the recording, each stamped with its time: the progress bar fills, then the Saved banner stays on screen for the last half.", cap: `<span class="tc">contact_sheet</span> · 6 tiles in one image` },
    after: `<p>Two images and two frames told the agent the whole story: the save takes about 2.9 s, then nothing moves for 3.4 s. On a 20-minute recording the contact sheet is still one image, and scene sampling still sends only the moments that changed.</p>`,
  },
  {
    slug: "zoom-clicks", n: "06", name: "Zoom toward every click",
    chain: "start_recording (events) → stop_recording → read_events → zoom (follow clicks, highlightClicks) → export_gif",
    description: "Record with an input event log, then zoom smoothly toward each click and ring it, Screen Studio style, all from one tool call.",
    lede: "A full-window recording makes viewers hunt for the cursor. Record with the input event log on, and <code>zoom</code> glides the camera in as each click happens, pans between clicks close together, rings the click, and zooms back out when things go quiet. The log never records what you type.",
    prompt: "Record the Demo Settings window while I click Save, then make a version that zooms in on my clicks and highlights them.",
    takes: [
      take(`${b("start_recording")} { "target": "window:Demo Settings", "fps": 30, "events": true }`, "Starts a small input hook alongside ffmpeg. Keys are <code>masked</code> by default: the log says a key went down, never which.", `{ "sessionId": "rec-…", "eventsPath": "rec-….events.jsonl", "keys": "masked" }`),
      take(`${b("stop_recording")} { "sessionId": "rec-…" }`, "The log is converted to the video's clock and pixels as the recording stops.", `{ "durationSec": 6.9, "eventsPath": "rec-….events.jsonl", "events": { "moves": 1, "clicks": 1 } }`),
      take(`${b("read_events")} { "sessionId": "rec-…", "types": ["down"] }`, "Each click with its video time and position. Handy on its own: sample_frames at those times shows what each click did.", `{ "matched": 1, "events": [{ "t": 3.183, "type": "down", "x": 91, "y": 204, "inFrame": true, "button": "left" }] }`),
      take(`${b("zoom")} { "input": "rec-….mp4", "dryRun": true }`, "With an event log next to the recording, <code>follow</code> defaults to clicks. The plan is editable: pass it back as <code>keyframes</code>.", `{ "follow": "clicks", "keyframes": [{ "t": 3.18, "x": 0, "y": 134, "width": 241, "height": 141 }, { "t": 5.18, "full": true }] }`),
      take(`${b("zoom")} { "input": "rec-….mp4", "highlightClicks": true }`, "The camera arrives on the click as it happens (the ease starts 0.6 s earlier), holds 2 s, and zooms out. Rings are drawn before the zoom, so they move with it.", `{ "outputPath": "zoom-….mp4", "follow": "clicks", "ringedClicks": 1 }`),
      take(`${b("export_gif")} { "input": "zoom-….mp4", "width": 480, "fps": 15 }`, "", `{ "sizeBytes": 317734, "withinBudget": true }`),
    ],
    outputs: [
      { src: "../media/zoom-before.gif", w: 480, h: 281, alt: "The raw recording: the whole settings window, the cursor moves to Save and clicks, and a green Saved banner appears.", cap: `<span class="tc">before</span> · the raw recording, 480 × 281` },
      { src: "../media/zoom-after.gif", w: 480, h: 281, alt: "The zoomed version: the camera glides in on the Save button as the cursor clicks it, a red ring expands from the click, then the view eases back out to the whole window with the Saved banner.", cap: `<span class="tc">after</span> · zoom with highlightClicks, the real output of the calls above` },
    ],
    after: `<p>No event log? <code>zoom</code> falls back to <code>follow: "changes"</code> and zooms toward where the screen changed. Keep the event log next to the original recording: its times and pixels match that file, not a trimmed or rescaled copy.</p>`,
  },
  {
    slug: "pipeline", n: "07", name: "The whole edit in one call",
    chain: "start_recording → find_text → pipeline (redact → trim → callout → export_gif)",
    description: "Redact, trim, annotate, and export a bug-repro GIF in one pipeline call: one ffmpeg pass, no intermediate files, and a recipe you can re-run on the next recording.",
    lede: "REC 01 takes six edit calls, six re-encodes, and five intermediate files. <code>pipeline</code> takes the same steps, with the same options as each tool, and runs them as one ffmpeg process. The steps are plain JSON, so save them as your team's standard PR clip and re-run them on the next recording.",
    prompt: "Record Demo Settings while I click Save, then in one go: hide the API key, trim to the save, box the Save button saying it hangs, and give me a GIF under 2 MB.",
    takes: [
      take(`${b("start_recording")} { "target": "window:Demo Settings", "fps": 15 }`, "Then <code>stop_recording</code> when the repro is done.", `{ "sessionId": "rec-…", "region": { "width": 602, "height": 352 } }`),
      take(`${b("find_text")} { "input": "rec-….mp4", "timestamp": 0.5, "query": "sk-[\\\\w-]+", "regex": true, "redact": true }`, "Finding the secret is the one step that stays separate: its rectangles feed the pipeline.", `{ "matchCount": 1, "redactRegions": [{ "x": 152, "y": 121, "width": 196, "height": 22 }] }`),
      take(`${b("pipeline")} { "input": "rec-….mp4", "dryRun": true, "steps": [<br>&nbsp;&nbsp;{ "op": "redact", "regions": [{ "x": 152, "y": 121, "width": 196, "height": 22 }] },<br>&nbsp;&nbsp;{ "op": "trim", "start": 0.5, "end": 5 },<br>&nbsp;&nbsp;{ "op": "callout", "items": [ { "type": "box", … }, { "type": "text", "text": "Save hangs for 2.5 s", … } ] },<br>&nbsp;&nbsp;{ "op": "export_gif", "width": 480, "fps": 10, "maxBytes": 2000000 } ] }`, "The plan: what each step became, and the fused ffmpeg command. Redact runs first, so it covers the whole clip; callout times are on the trimmed timeline.", `{ "steps": ["redact 1 region(s), box", "trim 0.5-5s: trim filter", "callout 2 item(s)", "export_gif (gif): second stage, size-budget ladder"], "processes": 2, "width": 602, "height": 352, "durationSec": 4.5 }`),
      take(`${b("pipeline")} { …the same steps, without dryRun }`, "One fused encode, then the GIF size ladder. 368 ms here, against six tool calls for REC 01.", `{ "outputPath": "pipeline-….gif", "animation": { "sizeBytes": 47020, "withinBudget": true } }`),
    ],
    output: { src: "../media/pipeline.gif", w: 480, h: 281, alt: "The same bug-repro GIF as REC 01: the API key covered by a black box, a red box and label on the Save button, then the Saved banner.", cap: `<span class="tc">pipeline.gif</span> · 480 × 281 · 46 KB · one pipeline call` },
    after: `<p>Steps run in order, and each sees the frame and timeline left by the steps before it: crop then redact means redact coordinates are in the cropped frame. <code>export_preset</code> or <code>export_gif</code> can only come last. Without one, the result is an mp4 at <code>quality</code> (default standard).</p>`,
  },
];

// Under reduced motion, an animated output shows a still frame instead (#224).
// Every animated output has a <name>-still.webp beside it in docs/media.
const media = (o) => {
  const img = `<img src="${o.src}" width="${o.w}" height="${o.h}" alt="${o.alt}" loading="lazy">`;
  if (!/\.(gif|webp)$/.test(o.src)) return img;
  const still = o.src.replace(/\.(gif|webp)$/, "-still.webp");
  return `<picture><source srcset="${still}" media="(prefers-reduced-motion: reduce)">${img}</picture>`;
};

RECIPES.forEach((r, i) => {
  const prev = RECIPES[i - 1];
  const next = RECIPES[i + 1];
  const body = `      <h1>${r.name}</h1>
      <p class="lede">${r.lede}</p>
    </section>

    <section class="chapter">
      <div class="tc-mark"><span class="tc">00:00</span><span>THE PROMPT</span></div>
      <p class="prompt">${r.prompt}</p>
    </section>

    <section class="chapter">
      <div class="tc-mark"><span class="tc">00:05</span><span>THE CALLS IT MAKES</span></div>
      <p>${r.chain.replace(/ → /g, " &rarr; ")}. Paths are shortened; every value is from a real run.</p>
      <ol class="takes">
${r.takes.join("\n")}
      </ol>
    </section>

    <section class="chapter">
      <div class="tc-mark"><span class="tc">00:30</span><span>THE OUTPUT</span></div>
${(r.outputs ?? [r.output]).map((o) => `      <figure class="output">
        <div class="frame">${media(o)}</div>
        <figcaption>${o.cap}</figcaption>
      </figure>`).join("\n")}
      ${r.after}
      <nav class="pager" aria-label="More recipes">
        <span>${prev ? `<a href="${prev.slug}.html">&larr; REC ${prev.n} ${prev.name}</a>` : `<a href="./">&larr; All workflows</a>`}</span>
        <span>${next ? `<a href="${next.slug}.html">REC ${next.n} ${next.name} &rarr;</a>` : `<a href="../connect.html">Connect your client &rarr;</a>`}</span>
      </nav>
    </section>
`;
  writeFileSync(join(docs, "workflows", `${r.slug}.html`), page({
    path: `workflows/${r.slug}.html`, title: r.name, description: r.description, root: "../",
    crumbs: `<a href="../">SCREENCAST-MCP</a> / <a href="./">WORKFLOWS</a> / REC ${r.n}`, body,
  }));
});

writeFileSync(join(docs, "workflows", "index.html"), page({
  path: "workflows/index.html", title: "Workflows",
  description: "Copy-paste recipes for screencast-mcp: bug-repro clips, README GIFs, UI verification, social clips, and reviewing long recordings.",
  root: "../", crumbs: `<a href="../">SCREENCAST-MCP</a> / WORKFLOWS`,
  body: `      <h1>Workflows</h1>
      <p class="lede">Seven things people actually do with a screen recorder in an agent loop. Each recipe starts from a prompt you would type, shows the tool calls the agent makes, and ends with the real output. Every recipe was run end to end with the tool, and the outputs shown are what it produced.</p>
    </section>

    <section class="chapter">
      <div class="tc-mark"><span class="tc">00:00</span><span>RECIPES</span></div>
      <ul class="recipes">
${RECIPES.map((r) => `        <li><a href="${r.slug}.html"><span class="tc">REC ${r.n}</span><span class="name">${r.name}</span><span class="chain">${r.chain.replace(/ → /g, " &rarr; ")}</span></a></li>`).join("\n")}
      </ul>
      <p>Not set up yet? <a href="../connect.html">Connect your client</a> first. The server also ships these as MCP prompts (<code>bug-repro-clip</code>, <code>demo-gif</code>, <code>verify-ui-change</code>, <code>review-recording</code>), which Claude Code and VS Code show as slash commands.</p>
    </section>
`,
}));

const json = (o) => JSON.stringify(o, null, 2);
const NPX = { command: "npx", args: ["-y", "@tmhs/screencast-mcp"] };
const pre = (code) => `      <pre class="copyable"><code>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>`;
// The stable, unversioned Claude Desktop bundle the release attaches (#216).
const BUNDLE = "https://github.com/TMHSDigital/screencast-mcp/releases/latest/download/screencast-mcp.mcpb";
// `code --add-mcp` JSON, quoted for cmd.exe (and for PowerShell after --%, which
// hands the line to code.cmd verbatim): "..." with every inner quote as \" (#217).
const ADD_MCP = JSON.stringify({ name: "screencast", ...NPX });
const cmdQuote = (s) => `"${s.replace(/"/g, '\\"')}"`;
const VSCODE_INSTALL = "https://insiders.vscode.dev/redirect/mcp/install?name=screencast&config=" +
  encodeURIComponent(JSON.stringify(NPX));
const CLIENTS = [
  { id: "claude-code", name: "Claude Code", body: `      <p>One command. On native Windows, <code>npx</code> needs the <code>cmd /c</code> wrapper:</p>
${pre("claude mcp add screencast -- cmd /c npx -y @tmhs/screencast-mcp")}
      <p>Add <code>--scope user</code> to make it available in every project, or <code>--scope project</code> to share it through a checked-in <code>.mcp.json</code>. Check it with <code>claude mcp list</code>, or <code>/mcp</code> inside a session.</p>` },
  { id: "claude-desktop", name: "Claude Desktop", body: `      <p><strong>One click:</strong> download <a href="${BUNDLE}"><code>screencast-mcp.mcpb</code></a> (always the <a href="https://github.com/TMHSDigital/screencast-mcp/releases/latest">latest release</a>) and open it, or drag it into <strong>Settings &rsaquo; Extensions</strong>. Claude Desktop runs it with its own Node and lets you set every option without editing JSON: the output folder, <code>ffmpeg.exe</code> and <code>ffprobe.exe</code> if they are not on <code>PATH</code>, a Whisper model for <code>transcribe</code>, the default recording cap, the edit job timeout, capture retention, and the PowerShell helper timeout.</p>
      <p>Or by hand: <strong>Settings &rsaquo; Developer &rsaquo; Edit Config</strong> opens <code>%APPDATA%\\Claude\\claude_desktop_config.json</code>. Add:</p>
${pre(json({ mcpServers: { screencast: NPX } }))}
      <p>Restart Claude Desktop after saving.</p>` },
  { id: "cursor", name: "Cursor", body: `      <p>Add to <code>~/.cursor/mcp.json</code> for every project, or <code>.cursor/mcp.json</code> in one project:</p>
${pre(json({ mcpServers: { screencast: NPX } }))}
      <p>Then check that it is enabled in Cursor's MCP settings. The inline images that <code>screenshot</code> and <code>sample_frames</code> return show up in the chat.</p>` },
  { id: "vs-code", name: "VS Code", body: `      <p><strong>One click:</strong> <a href="${VSCODE_INSTALL}">Install in VS Code</a> (it asks before adding the server).</p>
      <p>Or from a terminal. The JSON needs different quoting in each Windows shell; <code>--%</code> makes PowerShell pass the rest of the line through unchanged.</p>
      <p class="shell">PowerShell (Windows PowerShell 5.1 and PowerShell 7):</p>
${pre(`code --% --add-mcp ${cmdQuote(ADD_MCP)}`)}
      <p class="shell">Command Prompt (cmd.exe):</p>
${pre(`code --add-mcp ${cmdQuote(ADD_MCP)}`)}
      <p>Or add <code>.vscode/mcp.json</code> to a workspace. VS Code uses <code>servers</code>, not <code>mcpServers</code>:</p>
${pre(json({ servers: { screencast: { type: "stdio", ...NPX } } }))}
      <p>Use it from Copilot Chat in agent mode. The server's prompts appear as <code>/mcp.screencast.*</code> slash commands.</p>` },
];
writeFileSync(join(docs, "connect.html"), page({
  path: "connect.html", title: "Connect your client",
  description: "Set up screencast-mcp in Claude Code, Claude Desktop, Cursor, or VS Code.",
  root: "./", crumbs: `<a href="./">SCREENCAST-MCP</a> / CONNECT`,
  body: `      <h1>Connect your client</h1>
      <p class="lede">screencast-mcp speaks MCP over stdio, so any MCP client can run it. You need <strong>Windows</strong> for capture, plus <code>ffmpeg</code> and <code>ffprobe</code> on <code>PATH</code> (or <code>FFMPEG_PATH</code> / <code>FFPROBE_PATH</code>); <code>winget install Gyan.FFmpeg</code> covers both.</p>
    </section>

    <section class="chapter">
      <div class="tc-mark"><span class="tc">00:00</span><span>PICK YOUR CLIENT</span></div>
      <div class="tabs" role="tablist" aria-label="MCP client">
${CLIENTS.map((c) => `        <button type="button" role="tab" id="tab-${c.id}" aria-controls="${c.id}">${c.name}</button>`).join("\n")}
      </div>
${CLIENTS.map((c) => `      <div class="panel" role="tabpanel" id="${c.id}" aria-labelledby="tab-${c.id}">
        <h3>${c.name}</h3>
${c.body}
      </div>`).join("\n")}
    </section>

    <section class="chapter">
      <div class="tc-mark"><span class="tc">00:20</span><span>CHECK IT WORKS</span></div>
      <p class="prompt">Take a screenshot of my primary monitor and tell me what's on it.</p>
      <p>The agent calls <code>screenshot { "target": "monitor:0" }</code> and gets the image back inline. Then try a <a href="workflows/">workflow</a>.</p>
      <p>Running from a clone instead of the published package? Point the client at the build: <code>"command": "node"</code>, <code>"args": ["C:/path/to/screencast-mcp/dist/index.js"]</code>.</p>
    </section>
`,
}));
console.log("wrote", RECIPES.length + 2, "pages");
