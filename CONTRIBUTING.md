# Contributing to Screencast MCP

Thank you for your interest in contributing.

## Getting Started

You need **Node.js 22 or newer** (CI tests the 22 and 24 LTS lines) and, for
the integration suite, `ffmpeg` and `ffprobe` on `PATH`.

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the conventions below
4. Submit a pull request

## Development

```bash
git clone https://github.com/TMHSDigital/screencast-mcp.git
cd screencast-mcp
npm install
npm run build      # tsc -> dist/
npm test           # vitest: unit tests, plus the ffmpeg integration suite when ffmpeg is on PATH
npm run dev        # tsx watch
npm run docs       # regenerate mcp-tools.json, the tool tables, docs/tools/, llms.txt
```

The tool tables in the README and on the site, `mcp-tools.json`, and the per-tool pages are generated from the registered tools' schemas; after adding or changing a tool, run `npm run docs` (the docs test fails on a stale copy; `npm run docs:check` checks without writing).

To run your build from a client, point it at `dist/index.js`: `"command": "node"`, `"args": ["C:/path/to/screencast-mcp/dist/index.js"]`.

Agent evals (`evals/`) score tool selection, argument validity and outcomes on scripted tasks against lavfi-generated fixtures, through the built server over MCP. The default oracle mode replays known-good calls and needs no model or network; `--agent anthropic` runs a real model (install the SDK ad hoc with `npm install --no-save @anthropic-ai/sdk`; `EVAL_MODEL` defaults to `claude-sonnet-5-5`). Live-capture tools are always blocked.

```bash
npm run build && npm run eval                  # oracle mode
npm run eval -- --agent anthropic --json evals/results/baseline.json
```

## Project structure

```
.
├── src/
│   ├── index.ts          # entry: connects the server over stdio, or hands a subcommand to cli.ts
│   ├── server.ts         # builds the McpServer and wires every tool, prompt, and resource
│   ├── context.ts        # process-wide singletons (the session store)
│   ├── cli.ts            # headless CLI: record -- <command>, call <tool>
│   ├── prompts.ts        # MCP prompts (workflows as slash commands)
│   ├── resources.ts      # MCP resources (sessions, posters)
│   ├── wgcRecorder.ts    # recorder process for backend: "wgc"
│   ├── tools/            # one file per tool, each exporting register(server)
│   ├── utils/            # pure builders and helpers (ffmpeg args, targets, sessions, ...)
│   └── __tests__/        # vitest: unit, ffmpeg integration, capture smoke, guarded local-capture harness
├── evals/                # agent evals: scripted tasks, oracle and live-model runners
├── assets/               # bundled fonts, the review player (assets/ui), the bundle icon
├── docs/                 # GitHub Pages site; tools/, llms.txt, and the workflow pages are generated
├── scripts/              # Claude Desktop bundle (.mcpb) and the docs generators (npm run docs)
├── plugin/               # Claude Code plugin: the server plus workflow skills
├── action.yml            # GitHub Action: record a test run on windows-latest
├── mcp-tools.json        # tool manifest, generated from the registry by npm run docs
├── server.json           # MCP Registry listing (name matches package.json mcpName)
├── .github/workflows/    # CI, release, npm publish, Pages, ecosystem drift check
├── CHANGELOG.md · ROADMAP.md · CONTRIBUTING.md · SECURITY.md · LICENSE
└── package.json
```

[AGENTS.md](AGENTS.md) describes the same layout in more detail.

## Conventions

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` -- new feature or tool
- `fix:` -- bug fix
- `docs:` -- documentation changes
- `chore:` -- maintenance, dependency updates
- `refactor:` -- code restructuring

### Tools

- One tool per file in `src/tools/`, exporting `register(server)`; wire it up in `src/server.ts`
- Keep ffmpeg argument building in pure helpers under `src/utils/` (string in, args out) so it is unit-testable without ffmpeg
- Run `npm run docs` to regenerate `mcp-tools.json`, the tool tables, and the tool's reference page (a test fails when they are stale)
- Add vitest tests: unit tests for the builder, plus an ffmpeg-backed case in `src/__tests__/integration/` for anything that produces media

Capture is Windows-only (gdigrab, plus Windows Graphics Capture for `backend: "wgc"`; see `src/utils/targets.ts`), and cross-platform capture is not planned (see the [roadmap](ROADMAP.md#not-planned)). The watch, edit, and produce tools run anywhere ffmpeg runs.

### Tests

- `npm test` runs the unit tests, plus the ffmpeg integration suite when ffmpeg is on PATH (it skips otherwise; set `REQUIRE_FFMPEG=1` to make a missing ffmpeg fail, as CI does)
- `src/__tests__/server.test.ts` drives the tool handlers through an in-memory MCP client, with monitors and windows faked; add a case there for a tool that resolves a capture target
- `RUN_CAPTURE_SMOKE=1 npm test` (Windows) takes a real screenshot and a 2 s recording through the handlers; CI's Windows leg sets it
- `RUN_LOCAL_CAPTURE_TESTS=1 npm test` (after `npm run build`) drives the built server through real gdigrab capture; Windows with a display only

## Pull Request Process

1. Ensure CI passes (`npm run lint`, `npm run build`, `npm run typecheck`, `npm test`)
2. Add a `CHANGELOG.md` entry under `## Unreleased` if the change is user-facing
3. Do not bump the version; the maintainer does that when cutting a release (see below)
4. Use a descriptive PR title following conventional commit format

The PR template carries this checklist. Bug reports and feature requests use the
issue forms; security problems go through [private vulnerability reporting](SECURITY.md).

## Releases

A version bump is a release: after CI passes on `main`, `release.yml` tags and
releases any `package.json` version that has no tag yet, publishes it to npm and
the MCP Registry, and attaches the Claude Desktop bundle. A commit that does not
change the version releases nothing (the docs site deploys on its own).

- **When to bump.** The maintainer commits to `main` in batches and bumps the
  version once per batch that changes what users install: tools, parameters,
  results, the bundle, or runtime behavior. A batch of only `docs:`, `ci:`,
  `chore:`, `test:`, or `refactor:` work does not bump and does not publish;
  its CHANGELOG entries (if any) wait under `## Unreleased`.
- **How.** Rename `## Unreleased` to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty
  `## Unreleased` above it, and run `npm version <patch|minor|major> --no-git-tag-version`.
  Before 1.0, `feat:` bumps the minor version and everything else the patch; a
  breaking change also bumps the minor and is called out under `### Changed`.
- **Release notes.** The GitHub Release body is that version's CHANGELOG
  section, so write entries for users. GitHub's generated notes are only a
  fallback when the section is missing.
- **Floating tags.** Each release also moves `vMAJOR` and `vMAJOR.MINOR` to the
  newest release in that line (the ecosystem standard this repo follows), so a
  git reference can track a release line. They only move forward and are never
  used to publish.
- **1.0.** What freezes at 1.0, the deprecation policy, and the criteria are in
  the [roadmap](ROADMAP.md#path-to-10).

## Inbound license grant and DCO

This project's outbound license is CC-BY-NC-ND-4.0. Contributions are accepted inbound under a broader grant via the Developer Certificate of Origin (DCO). Both pieces are required because CC-BY-NC-ND-4.0 alone cannot cleanly accept third-party derivatives.

### Required grant

By submitting a contribution to this repository, you certify that you have the right to do so under the Developer Certificate of Origin (DCO) 1.1, and you grant TMHSDigital a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, prepare derivative works of, publicly display, publicly perform, sublicense, and distribute your contribution under the project's current license (CC-BY-NC-ND-4.0) or any successor license chosen by the project.

### DCO sign-off

Every commit in a pull request must carry a `Signed-off-by:` trailer matching the commit author. Sign at commit time with the `-s` flag:

```bash
git commit -s -m "feat: add new tool"
```

This appends a line like `Signed-off-by: Jane Developer <jane@example.com>` to the commit message. Pull requests whose commits lack a matching sign-off are not merged until they are re-signed (`git rebase --signoff main`).

For the full inbound/outbound model and rationale, see [`standards/licensing.md`](https://github.com/TMHSDigital/Developer-Tools-Directory/blob/main/standards/licensing.md) in the Developer-Tools-Directory meta-repo.
