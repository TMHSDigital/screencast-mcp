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

### Provider adapters

- Implement the `Provider` interface in `src/providers/`
- Register the adapter in `ProviderManager`

### Tools

- Register the tool in `src/tools/`
- Add it to `mcp-tools.json`
- Add vitest tests

Bump the version in `package.json` in your PR (e.g. `npm version <patch|minor|major> --no-git-tag-version`); CI tags and publishes it on merge.

## Pull Request Process

1. Ensure CI passes (`npm run build`, `npm test`, `npm run typecheck`)
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
