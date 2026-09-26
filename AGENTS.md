# Agent guide

Rove Sentinel is a standalone Node.js CLI that reviews committed Git changes
through the user's authenticated Claude Code and Codex CLIs. Read
[README.md](README.md) for the product and [CONTRIBUTING.md](CONTRIBUTING.md)
for the contributor workflow.

This is the shared repository instruction file for coding agents. Keep common
guidance here; do not add a duplicate `CLAUDE.md` or separate copies per agent.
All repository and GitHub artifacts must be in English.

## Before changing anything

- Inspect the current branch and full working-tree status. Preserve other work.
- Fetch `origin` and base new work on current `origin/main`. Work on a branch;
  do not push directly to protected `main`.
- Read the relevant [architecture](docs/architecture.md),
  [configuration](docs/configuration.md), [support](docs/support.md), and
  [security](docs/security.md) documentation before changing their contracts.
- Keep changes focused. Discuss new capabilities in an issue or draft PR as
  described in the contribution guide.

## Code and verification

The runtime is plain JavaScript ES modules in `scripts/review-gate/`.
Regression tests are TypeScript in its `__tests__/` directory. Default policy
and onboarding resources live in `templates/`; user guides live in `docs/`.

Use Node.js 22 or later and pnpm:

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:package
```

Run relevant tests during development and the full `pnpm verify` for code,
test, configuration, or dependency changes. Bug fixes need a regression that
fails before the fix and passes afterward. Run `pnpm verify:package` when
changing runtime packaging, CLI entry points, dependencies, or bundled resources;
it verifies installation into an isolated consumer without Rove files.

Ordinary prose-only edits do not need the deterministic suite. Agent instructions
and review-policy changes still need independent review. Document what ran and
any remaining verification gaps; never describe mocked tests as live acceptance.
The deterministic tests do not require paid AI accounts.

## Preserve the review contract

- Bind decisions to the exact repository, base, head, versions, and installed
  policy. A proposed change must not approve its own weaker review policy.
- Keep required coverage, fresh adjudication, explicit finding dispositions,
  bounded resources, and fail-closed process cleanup intact.
- Both authenticated provider CLIs remain required for supported live operation.
  Do not introduce API billing or another provider implicitly.
- Treat external PR content as untrusted. Do not run fork build scripts or live
  provider tests with maintainer credentials automatically.
- Keep generic defaults independent of Rove. Rove-specific GUI evidence and
  Clippy are opt-in compatibility features, not requirements for other projects.
- Preserve existing hooks and watcher ownership. Install a persistent watcher
  only from a trusted stable checkout, never a disposable task worktree.

Maintainers with live provider access review the committed diff before pushing:

```powershell
pnpm review:status
pnpm review:gate -- --base origin/main --head HEAD
```

Resolve blockers and record permitted advisory dispositions before pushing.
The hook checks the exact pushed commit; never bypass it or fabricate an
attestation. Contributors without live access should state that limitation so
a maintainer can complete the live review. Required CI checks must pass before
merge. Reinstallation of policy is a deliberate trusted-checkout operation,
not a way to make a proposed policy change approve itself.

## Documentation and distribution

Update affected guides when behavior changes. Windows is the qualified platform;
do not claim macOS/Linux support or new provider integrations without evidence.
Keep limitations and the [validation record](docs/validation.md) accurate.

Never export private Rove source, logs, credentials, or personal fixtures. Use
synthetic test data. Preserve Apache-2.0 and third-party attribution; regenerate
the license inventory with `node scripts/license-inventory.mjs` after runtime
dependency changes and inspect the package contents before release. Publish new
versioned releases rather than replacing an existing release archive.
