# Contributing to Screencast MCP

Thank you for your interest in contributing.

## Getting Started

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the conventions below
4. Submit a pull request

## Conventions

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` -- new feature, provider adapter, or tool
- `fix:` -- bug fix
- `docs:` -- documentation changes
- `chore:` -- maintenance, dependency updates
- `refactor:` -- code restructuring

### Tools

- One tool per file in `src/tools/`, exporting `register(server)`; wire it up in `src/index.ts`
- Keep ffmpeg argument building in pure helpers under `src/utils/` (string in, args out) so it is unit-testable without ffmpeg
- Add it to `mcp-tools.json` (a test checks the manifest matches the registered tools)
- Add vitest tests: unit tests for the builder, plus an ffmpeg-backed case in `src/__tests__/integration/` for anything that produces media

Capture is Windows-only today (gdigrab, see `src/utils/targets.ts`); there is no capture-backend abstraction yet. Cross-platform capture is tracked in #15.

### Tests

- `npm test` runs the unit tests, plus the ffmpeg integration suite when ffmpeg is on PATH (it skips otherwise; set `REQUIRE_FFMPEG=1` to make a missing ffmpeg fail, as CI's Linux job does)
- `RUN_LOCAL_CAPTURE_TESTS=1 npm test` (after `npm run build`) drives the built server through real gdigrab capture; Windows with a display only

Bump the version in `package.json` in your PR (e.g. `npm version <patch|minor|major> --no-git-tag-version`); CI tags and publishes it on merge.

## Pull Request Process

1. Ensure CI passes (`npm run lint`, `npm run build`, `npm run typecheck`, `npm test`)
2. Update `CHANGELOG.md` if the change is user-facing
3. Use a descriptive PR title following conventional commit format

## Inbound license grant and DCO

This project's outbound license is CC-BY-NC-ND-4.0. Contributions are accepted inbound under a broader grant via the Developer Certificate of Origin (DCO). Both pieces are required because CC-BY-NC-ND-4.0 alone cannot cleanly accept third-party derivatives.

### Required grant

By submitting a contribution to this repository, you certify that you have the right to do so under the Developer Certificate of Origin (DCO) 1.1, and you grant TMHSDigital a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, prepare derivative works of, publicly display, publicly perform, sublicense, and distribute your contribution under the project's current license (CC-BY-NC-ND-4.0) or any successor license chosen by the project.

### DCO sign-off

Every commit in a pull request must carry a `Signed-off-by:` trailer matching the commit author. Sign at commit time with the `-s` flag:

```bash
git commit -s -m "feat: add new tool"```

This appends a line like `Signed-off-by: Jane Developer <jane@example.com>` to the commit message. The GitHub DCO App enforces this on every PR.

For the full inbound/outbound model and rationale, see [`standards/licensing.md`](https://github.com/TMHSDigital/Developer-Tools-Directory/blob/main/standards/licensing.md) in the Developer-Tools-Directory meta-repo.
