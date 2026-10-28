<!-- standards-version: 1.10.0 -->

# AGENTS.md

How the Screencast MCP repo works, for AI coding agents and human contributors.
This is the single source: `CLAUDE.md` and `.cursorrules` point here.

## Repository layout

A stdio MCP server (TypeScript, Node 22+) that records the Windows screen,
returns frames the model can see, and edits media with ffmpeg.

- **`src/index.ts`** -- entry point: connects the server over stdio
- **`src/server.ts`** -- builds the `McpServer` and wires every tool, prompt, and resource (no transport, so tests connect it in memory)
- **`src/tools/`** -- one MCP tool per file; each exports `register(server)`, which `src/server.ts` calls
- **`src/utils/`** -- pure helpers: ffmpeg argument builders (input in, args out), target resolution, sessions, jobs, OCR, and so on. Keep logic here so it is unit-testable without ffmpeg
- **`src/prompts.ts`, `src/resources.ts`** -- MCP prompts and resources
- **`src/wgcRecorder.ts`** -- the recorder process `start_recording` spawns for `backend: "wgc"` (Windows Graphics Capture)
- **`src/__tests__/`** -- vitest unit tests; `src/__tests__/integration/` runs real ffmpeg; `server.test.ts` drives the tool handlers through an in-memory MCP client
- **`assets/`** -- shipped with the package: bundled fonts, the review player UI (`assets/ui/`), and the bundle icon
- **`scripts/`** -- the Claude Desktop bundle (`build-mcpb.mjs`, `mcpb-manifest.mjs`) and the docs page builder
- **`mcp-tools.json`** -- the registered tools; a test checks it matches `src/server.ts`
- **`server.json`** -- the MCP Registry listing
- **`docs/`** -- the GitHub Pages site (hand-written HTML/CSS/JS, no build step for most pages)
- **`package.json`** -- version source of truth; **`CHANGELOG.md`** -- release history

There is no provider or capture-backend abstraction. Capture is Windows-only
(gdigrab, plus Windows Graphics Capture for `backend: "wgc"`; see `src/utils/targets.ts` and `src/utils/wgc.ts`); the edit,
watch, and produce tools run anywhere ffmpeg runs.

## Adding a tool

1. Add `src/tools/<camelName>.ts` exporting `register(server)`; keep ffmpeg argument building in a pure helper under `src/utils/`
2. Wire it up in `src/server.ts`
3. Add it to `mcp-tools.json`, the README tools table, and the tools table in `docs/index.html` (tests check all three)
4. Add vitest tests: unit tests for the builder, plus a case in `src/__tests__/integration/` for anything that produces media
5. Add a `CHANGELOG.md` entry under `## Unreleased`

## Commands

```bash
npm run lint        # eslint .
npm run build       # tsc
npm run typecheck   # tsc --noEmit
npm test            # vitest; the ffmpeg integration suite skips without ffmpeg on PATH
```

`REQUIRE_FFMPEG=1` makes a missing ffmpeg fail instead of skip. `RUN_CAPTURE_SMOKE=1`
and `RUN_LOCAL_CAPTURE_TESTS=1` run real capture on Windows (see CONTRIBUTING.md).

## Commits, versions, and releases

- `main` is the only branch. Conventional commits (`feat:`, `fix:`, `perf:`, `docs:`, `ci:`, `chore:`, `test:`, `refactor:`).
- A version bump is a release: `release.yml` tags and releases any `package.json` version that has no tag yet, after CI passes. Bump with `npm version <patch|minor|major> --no-git-tag-version`, once per batch of user-facing changes, never for docs/CI/chore-only work. Contributor PRs do not bump; the maintainer does when releasing.
- The full policy (when to bump, release notes, the path to 1.0) is in [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## CI/CD workflows

See [`.github/workflows/README.md`](.github/workflows/README.md). In short: `ci.yml`
lints, builds, typechecks, and tests on Ubuntu and Windows with Node 22 and 24;
`release.yml` runs after a green CI on `main`; `publish.yml` publishes to npm and
the MCP Registry; `pages.yml` deploys `docs/`.

## Code conventions

- No hardcoded credentials; never commit captured media (`.gitignore` blocks it).
- Keep `mcp-tools.json`, the README tools table, and `docs/index.html` in sync with the registered tools.
- Every environment variable in the README's Configuration table must also be in `server.json` and `scripts/mcpb-manifest.mjs` (tests check this).
- Machine-local agent instructions go in `CLAUDE.local.md` (gitignored), not in checked-in files.

## License

CC-BY-NC-ND-4.0. Contributions are accepted under the DCO and inbound grant in CONTRIBUTING.md.
