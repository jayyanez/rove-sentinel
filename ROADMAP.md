# Roadmap

## Current status

[Rove Sentinel v1.9.0](https://github.com/jayyanez/rove-sentinel/releases/tag/v1.9.0)
is published: engine, regression suite, onboarding CLI and documentation.
Rove's adoption is merged. Its canonical checkout and Windows watcher use the
pinned release, and its embedded reusable engine has been removed.

## First release — delivered

The first release supports the qualified local workflow on Windows, with both Codex CLI
and Claude Code installed and authenticated. The scope is a reusable review
engine and its local workflow integration.

- [x] Extract the engine and regression tests without private Rove source or data.
- [x] Separate trusted project policy from engine behavior.
- [x] Package a Node CLI that resolves its own installation independently of Rove.
- [x] Preserve the required Claude Code + Codex configuration and explicit billing
  boundaries.
- [x] Make the inherited Clippy lane opt-in through installed project policy;
  restrict automatic review to trusted same-repository authors.
- [x] Validate Windows installation, provider invocation, hooks, watcher lifecycle,
  recovery, and cleanup outside the Rove checkout within the documented test scope.
- [x] Publish an audited, versioned release with licenses and dependency notices.
- [x] Move Rove onto an exact released version while preserving its project policy.

See the [completed extraction plan](docs/plans/first-standalone-release.md),
[validation record](docs/validation.md), and [current limitations](docs/support.md).
Release completion does not imply universal platform qualification or defect-free
AI review.

## Later evaluation

- Qualify macOS support already represented in the original implementation.
- Complete and qualify Linux lifecycle integration.
- Evaluate additional agents, including GitHub Copilot, OpenCode, Muse, and
  Grok Build.
- Evaluate server-enforced review checks and other hosting integrations.

These are possible directions, not release commitments. A hosted multi-user
service, provider credential proxy, and new website are outside the initial
release scope.
