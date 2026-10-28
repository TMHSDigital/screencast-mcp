# CLAUDE.md

Guidance for Claude Code in this repository. The full contributor and agent
guide is [AGENTS.md](AGENTS.md); this file only summarizes it.

## Project

Screencast MCP -- MCP server for Windows screen recording, frame sampling, and ffmpeg edits

**Version:** see `package.json` (the source of truth)
**License:** CC-BY-NC-ND-4.0
**Author:** TMHSDigital

## Key paths

- Source: `src/` (TypeScript); entry `src/index.ts`, wiring `src/server.ts`
- Tools: `src/tools/`; pure helpers: `src/utils/`
- Tool list: `mcp-tools.json` (enumerates the MCP tools)
- Claude Desktop bundle and Registry listing: `scripts/mcpb-manifest.mjs`, `server.json`
- Docs site: `docs/`; CI workflows: `.github/workflows/`

## Conventions

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Tools live in `src/tools/` (one `register(server)` per file, wired in `src/server.ts`); pure helpers live in `src/utils/`
- Keep `mcp-tools.json`, the README tools table, and `docs/index.html` in sync with the registered tools
- Add a `CHANGELOG.md` entry under `## Unreleased`
- A version bump is a release: bump once per batch of user-facing changes (`npm version <patch|minor|major> --no-git-tag-version`), never for docs/CI/chore-only work. See [CONTRIBUTING.md](CONTRIBUTING.md#releases)

## Testing

```bash
npm run build
npm test
npm run typecheck
npm run lint
```

Machine-local instructions (personal MCP tools, routing rules) belong in
`CLAUDE.local.md`, which is gitignored.
