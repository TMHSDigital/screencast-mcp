<!-- standards-version: 1.10.0 -->

# AGENTS.md

This file tells AI coding agents how the Screencast MCP repo works and how to contribute correctly.

## Repository overview

This is an MCP server. It contains:

- **`src/`** -- TypeScript source code
- **`src/providers/`** -- provider adapters implementing the `Provider` interface, wired into `ProviderManager`
- **`src/tools/`** -- the registered MCP tools (stdio transport only)
- **`package.json`** -- npm package manifest (version source of truth)
- **`mcp-tools.json`** -- enumerates the MCP tools this server exposes
- **`docs/`** -- documentation and GitHub Pages site
- **`CHANGELOG.md`** -- release history

## Branching and commit model

- **Single branch**: `main` only. No develop/release branches.
- **Conventional commits** are required. Use them to decide your version bump, then apply it in your PR (`npm version <patch|minor|major> --no-git-tag-version`); `release.yml` tags and publishes that version on merge, and CI never writes to `main`:
  - `feat:` or `feat(scope):` -- bump the **minor** version
  - `feat!:` or a `BREAKING CHANGE` trailer -- bump the **major** version
  - everything else (`fix:`, `chore:`, `docs:`, etc.) -- bump the **patch** version
- Commit messages should be concise and describe the "why", not the "what".

## CI/CD workflows

### `ci.yml` (runs on PR and push to main)

Builds and runs the test suite on Node 20 and 22:
- TypeScript build (`npm run build`)
- Test suite (`npm test`, vitest, offline)

### `release.yml` (runs on push to main)

Reads the version from `package.json` and, if there is no matching tag yet, pushes the `v<version>` tag (plus the floating `vMAJOR` and `vMAJOR.MINOR` tags), creates a GitHub Release, and dispatches `publish.yml`. It only pushes tags and never writes to `main`; bump the version in your PR.

### `publish.yml` (runs on release published or workflow_dispatch)

Publishes the package to npm.

### `drift-check.yml`

Checks this repo against the ecosystem standards for drift.

### `pages.yml` (deploys docs/ to GitHub Pages)

Builds and deploys the documentation site on push to main.

### `stale.yml`

Marks issues/PRs as stale after 30 days of inactivity.

### `label-sync.yml`

Keeps repository labels in sync.

## Version management

- The **source of truth** for the current version is `package.json`.
- Bump it in your PR with `npm version <patch|minor|major> --no-git-tag-version` (keeps the lockfile in sync) and update the README badge, following conventional-commit intent.
- On merge, `release.yml` tags that version and publishes it. `main` is protected and is never written to by CI.

## Code conventions

- No hardcoded credentials -- CI scans for password/token/api_key patterns.
- Conventional commits; bump the version deliberately in your PR (CI tags and publishes it).
- Keep `mcp-tools.json` in sync with the tools registered in `src/tools/`.

## Adding content

### New provider adapter

1. Implement the `Provider` interface in `src/providers/`
2. Register the adapter in `ProviderManager`
3. Use `feat:` commit prefix

### New tool

1. Register the tool in `src/tools/`
2. Add it to `mcp-tools.json`
3. Add vitest tests
4. Use `feat:` commit prefix

## License

CC-BY-NC-ND-4.0. All contributions fall under this license.
