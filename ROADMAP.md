# Roadmap

## Current status

The public repository and project identity are established. The working engine
remains inside Rove. No standalone package has been released, and Rove has not
yet switched to an external dependency.

## First release

The first release targets local development on Windows, with both Codex CLI
and Claude Code installed and authenticated. The scope is a reusable review
engine and its local workflow integration.

- Extract the engine and regression tests without private Rove source or data.
- Separate trusted project policy from engine behavior.
- Package a Node CLI that resolves its own installation independently of Rove.
- Preserve the required Claude Code + Codex configuration and explicit billing
  boundaries.
- Make optional executable validation lanes project-configurable and safe for
  their input trust level.
- Validate Windows installation, provider invocation, hooks, watcher lifecycle,
  recovery, and cleanup outside the Rove checkout.
- Publish an audited, versioned prerelease with licenses and dependency notices.
- Move Rove onto an exact released version while preserving its project policy.

Implementation should begin from a published extraction plan. Progress and
acceptance evidence belong in the pull request that owns that work.

## Later evaluation

- Qualify macOS support already represented in the original implementation.
- Complete and qualify Linux lifecycle integration.
- Evaluate additional agents, including GitHub Copilot, OpenCode, Muse, and
  Grok Build.
- Evaluate server-enforced review checks and other hosting integrations.

These are possible directions, not release commitments. A hosted multi-user
service, provider credential proxy, and new website are outside the initial
release scope.
