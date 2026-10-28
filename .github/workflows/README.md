# Workflows

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` (CI) | push and PR to `main`, dispatch | Lint, build, typecheck, and test on Ubuntu and Windows, Node 22 and 24. Both legs run the ffmpeg integration suite; the Windows leg uses FFmpeg 8 with a whisper model and runs a real capture smoke test. |
| `release.yml` (Release) | a successful CI run on `main` (push or dispatch), dispatch | Only when `package.json` holds a version with no tag yet: tags the commit CI tested, creates the GitHub Release with that version's `CHANGELOG.md` section as its notes (generated notes if the section is missing), attaches the `.mcpb` bundle plus an unversioned `screencast-mcp.mcpb`, and dispatches `publish.yml` on the new tag. A push that does not bump the version releases nothing. |
| `publish.yml` (Publish to npm) | dispatch from `release.yml` | Builds the tag, publishes to npm with provenance, and lists the version in the MCP Registry. Idempotent. |
| `codeql.yml` (CodeQL) | push and PR to `main`, weekly | JavaScript/TypeScript code scanning. |
| `drift-check.yml` | push and PR to `main` | Ecosystem standards check. |
| `labeler.yml` (Label PRs) | `pull_request_target` | Path labels from `.github/labeler.yml`; never checks out PR code. |
| `pages.yml` | push to `main` touching `docs/` or `assets/` | Deploys the docs site. |
| `stale.yml` | weekly | Labels inactive issues (never closes them) and closes stale PRs. |

Every `uses:` is pinned to a commit SHA with its version in a comment; Dependabot keeps them current. Each workflow sets `permissions: {}` and grants what a job needs on that job.

## Repository rules

Rulesets live in repo settings, not in git, so the current state is recorded here.

- **`main protection`** (branch `main`): blocks force pushes and branch deletion, with no bypass.
- A release needs a green CI run on the released commit (`release.yml` is triggered by CI, not by the push), so a red `main` does not ship.

## Release process

See [CONTRIBUTING.md](../../CONTRIBUTING.md#releases) for when a version is bumped and what the floating `vMAJOR` / `vMAJOR.MINOR` tags are for.
