## What and why

<!-- What this changes and the issue it fixes (Fixes #123). -->

## Checklist

- [ ] `npm run lint`, `npm run build`, `npm run typecheck`, and `npm test` pass
- [ ] Tests added or updated (a unit test for any builder in `src/utils/`; an integration case for anything that produces media)
- [ ] `CHANGELOG.md` entry under `## Unreleased` for a user-facing change
- [ ] After adding, renaming, or re-describing a tool, `npm run docs` was run (it regenerates `mcp-tools.json`, the tool tables, and `docs/tools/`)
- [ ] A new environment variable is in the README Configuration table, `server.json`, and `scripts/mcpb-manifest.mjs`
- [ ] The version in `package.json` is **not** bumped (the maintainer bumps it when releasing, see [CONTRIBUTING](https://github.com/TMHSDigital/screencast-mcp/blob/main/CONTRIBUTING.md#releases))
- [ ] Every commit is signed off (`git commit -s`, see the DCO in CONTRIBUTING)
- [ ] No captured media or secrets in the diff
