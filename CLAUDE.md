<!-- standards-version: 1.10.0 -->

# CLAUDE.md

This file provides guidance for Claude Code when working in this repository.

## Project

Screencast MCP -- MCP server for Windows screen recording, frame sampling, and minimal ffmpeg edits

**Version:** 0.1.0
**License:** CC-BY-NC-ND-4.0
**Author:** TMHSDigital

## Key paths

- Source: `src/` (TypeScript)
- Provider adapters: `src/providers/` (implement the `Provider` interface, wired into `ProviderManager`)
- Tools: `src/tools/`
- Package manifest: `package.json` (version source of truth)
- Tool list: `mcp-tools.json` (enumerates the MCP tools)
- Docs site: `docs/`
- CI workflows: `.github/workflows/`

## Conventions

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Bump the version in `package.json` in your PR (`npm version`, keeps the lockfile in sync); `release.yml` tags and publishes that version on merge
- Provider adapters live in `src/providers/` and implement the `Provider` interface, wired into `ProviderManager`; tools live in `src/tools/`
- Keep `mcp-tools.json` in sync with the registered tools

## Testing

```bash
npm run build
npm test
npm run typecheck
```
