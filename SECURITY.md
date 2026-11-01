# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Screencast MCP, please report it responsibly.

**Do not** open a public issue for security vulnerabilities.

Instead, report it privately through GitHub:
**[Report a vulnerability](https://github.com/TMHSDigital/screencast-mcp/security/advisories/new)**
(Security tab → "Report a vulnerability"). Include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact

We will acknowledge receipt within 48 hours and provide a timeline for resolution.

## Supported Versions

Only the latest release (currently the 0.x line published as
`@tmhs/screencast-mcp` on npm) receives security fixes. Upgrade to the newest
version before reporting.

## Redaction guarantees

The `redact_region` tool covers rectangles that the caller declares. It does not
detect secrets on its own, so it cannot redact a secret nobody pointed it at.

- The default `box` style writes a solid, filled rectangle. A solid fill is
  irreversible. The `blur` and `pixelate` styles are softer but can be partially
  recovered, so `box` is the correct choice for an actual secret.
- A region that falls outside the source frame is rejected, so an off-frame typo
  fails loudly instead of leaving the secret visible.
- Redaction re-encodes to a new file. Always review the output (for example with
  `sample_frames`) before sharing, and delete the unredacted original if it is no
  longer needed.

## File access

Tool arguments come from the model, so a prompt injection (text on screen, a
web page, a file) can try to steer them. The server limits what a call can touch:

- **Network and device paths are always refused.** A UNC (`\\host\share`),
  `//host/share`, WebDAV (`\\host@SSL@443\...`), `\\?\UNC\` or `\\.\` path in
  any input or output argument is rejected before anything opens it, because
  opening one makes Windows send the user's NTLM credentials to that host.
  Copy remote files to a local folder first.
- **Confinement.** When the client sends workspace roots, or
  `SCREENCAST_ALLOWED_DIRS` is set, both inputs and outputs must sit inside
  `SCREENCAST_HOME`, the roots, or those folders. A client whose roots request
  fails gets `SCREENCAST_HOME` and `SCREENCAST_ALLOWED_DIRS` only (fail closed).
- **No confinement configured.** With no roots and no `SCREENCAST_ALLOWED_DIRS`,
  reads and new files may go anywhere the user can reach, but replacing an
  existing file outside `SCREENCAST_HOME` is refused even with
  `overwrite: true`. Set `SCREENCAST_ALLOWED_DIRS` to allow it in specific folders.
