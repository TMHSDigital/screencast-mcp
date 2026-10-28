// The shared page shell for the generated docs pages: the REC/timecode HUD,
// the head metadata, and the footer. Used by build-docs-pages.mjs (workflows,
// connect) and tool-docs.mjs (the per-tool reference). docs/index.html and
// docs/404.html are written by hand and carry the same header.

export const SITE = "https://tmhsdigital.github.io/screencast-mcp/";

/** Escapes text for HTML element content and attribute values. */
export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const navLink = (root, href, label, here) => `<a href="${root}${href}"${here ? ' class="here"' : ""}>${label}</a>`;

export function page({ path, title, description, root, crumbs, body, type = "article" }) {
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
  <meta property="og:type" content="${type}">
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
      ${navLink(root, "tools/", "Tools", path.startsWith("tools/"))}
      ${navLink(root, "workflows/", "Workflows", path.startsWith("workflows"))}
      ${navLink(root, "connect.html", "Connect", path === "connect.html")}
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
