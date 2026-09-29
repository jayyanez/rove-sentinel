# Contributing to Rove Sentinel

Thanks for helping make independent code review easier to use. Start with
[what Sentinel supports](docs/support.md) and the
[architecture](docs/architecture.md). Small reproductions, clearer instructions,
platform verification and regression tests are as valuable as new features.

Coding agents should also read [AGENTS.md](AGENTS.md), the shared repository
instruction file. Keep agent guidance there rather than duplicating it across
tool-specific files.

## Run the project

Use Node.js 22 or later and pnpm. Clone the repository, then:

```powershell
pnpm install --frozen-lockfile
pnpm verify
node scripts/review-gate/cli.mjs help
```

The deterministic suite uses fake provider responses and temporary repositories;
it does not require paid AI accounts. Live review and installation acceptance
require at least one subscription-authenticated CLI and GitHub CLI. Do not run live provider tests
against forks automatically with maintainer credentials.

Keep changes on a branch. For a bug, add a regression that fails before the fix.
For a new capability, discuss the intended behavior in an issue or draft PR and
include acceptance criteria. Run the relevant tests while developing, then the
full `pnpm verify`. Explain what was tested and what was not in your PR.

## Where to help

- Reproduce and qualify macOS/Linux behavior without weakening Windows tests.
- Improve newcomer installation and actionable error messages.
- Add reference-map coverage with realistic language fixtures.
- Design provider extension points while preserving installed-policy identity.
- Build reproducible review-quality evaluations, including misses and false positives.

New providers, Git hosts, arbitrary build hooks, or changes to security boundaries
need design discussion first. Preserve bounded resources, exact-commit identity,
fail-closed cleanup, structured provider output, and explicit finding dispositions.
Never make a test pass by dropping the behavior it was meant to protect.

## Review and release

Maintainers run the shared review pipeline against the committed change and
inspect its findings. The package tarball must install into a fresh consumer
without this source checkout. Release qualification includes CLI smoke tests,
hook behavior, installed-policy checks and Windows lifecycle acceptance.
Release archives and checksums are published on GitHub; consumers pin a release
URL and lockfile integrity. See the [release plan](docs/plans/first-standalone-release.md).

From 1.10.0, that pin installs the launcher. Automatic Windows updates select
immutable managed engines independently for each repository. Read the
[update contract](docs/updates.md) before changing that boundary. Packages declaring
`sentinelEngineProtocol: 1` must keep the CLI version/status/install contract,
including `install --preserve-policy`, and the repository selection format
compatible. Do not claim protocol compatibility for a breaking update.
Managed engines must also accept evidence produced by the pinned launcher's
public helper exports; automatic updates do not replace those imported libraries.

Run `node scripts/runtime-smoke.mjs` for explicit Windows lifecycle acceptance.
It creates synthetic local consumers and scheduled tasks, requires existing CLI
authentication, runs no paid reviews, and removes its fixture watchers afterward.
It uses synthetic future-version archives, not public releases. Keep its ignored
evidence until the review is complete; an unsuccessful cleanup is unfinished work.

Use English for code, comments, documentation, commits, and public discussion.
Do not include private Rove source, private review logs or credentials in fixtures.
By contributing, you agree that your contribution is available under this
repository's Apache-2.0 license. Third-party material must retain its license and
attribution and be compatible with redistribution.
