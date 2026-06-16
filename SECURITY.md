# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Screencast MCP, please report it responsibly.

**Do not** open a public issue for security vulnerabilities.

Instead, email contact@users.noreply.github.com with:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact

We will acknowledge receipt within 48 hours and provide a timeline for resolution.

## Supported Versions

Only the latest release is supported with security updates.

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
