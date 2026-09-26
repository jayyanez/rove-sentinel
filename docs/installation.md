# Install Rove Sentinel

[Back to the overview](../README.md) · [Your first review](usage.md)

> The standalone release is being qualified. The release download below becomes
> available when v1.9.0 is published. To contribute before then, see
> [CONTRIBUTING.md](../CONTRIBUTING.md).

## What you need

Use Windows for the first supported release. Install Node.js 22 or later,
Git, GitHub CLI (`gh`), **Claude Code**, and **Codex CLI** separately. Both AI
tools must be on PATH and authenticated: Claude Code through a Claude
subscription, Codex through ChatGPT. An API key alone does not satisfy this
release's installation checks. Your accounts need access to the configured
models; usage consumes your own provider allowances.

On Windows, use native `claude.exe` and `codex.exe` launchers. The qualified
adapter launches executables directly without a command shell; installations
that expose only `.cmd` or `.ps1` wrappers are not supported by this release.
Run `Get-Command claude,codex` in PowerShell and check that both resolve to
executables, then run `doctor` below. This is a current portability limitation.

Install the external tools using their official instructions:
[Node.js](https://nodejs.org/en/download), [Git](https://git-scm.com/downloads),
[GitHub CLI](https://cli.github.com/),
[Claude Code](https://code.claude.com/docs/en/overview),
and [Codex](https://developers.openai.com/codex/cli).
Complete each tool's own sign-in flow. Sentinel does not provide accounts or
ask you to paste provider credentials into its configuration.

Start in a Git repository with a commit, a configured remote, and a fetched
base branch. The examples use `origin/main`. Authenticate `gh` for that
repository with `gh auth login`. GitHub publishing currently supports
github.com only.

## 1. Add the released package

From your project directory, choose the command for its package manager:

```powershell
npm install --save-dev --save-exact https://github.com/jayyanez/rove-sentinel/releases/download/v1.9.0/rove-sentinel-1.9.0.tgz
```

Or with pnpm:

```powershell
pnpm add --save-dev --save-exact https://github.com/jayyanez/rove-sentinel/releases/download/v1.9.0/rove-sentinel-1.9.0.tgz
```

This is a GitHub Release archive; the instructions do not depend on an npm
registry package named `rove-sentinel`. Commit your dependency manifest and
lockfile so the whole team uses the same release and integrity hash. The
package runs locally and contains no provider binaries.

The remaining examples use `npx --no-install rove-sentinel`. The
`--no-install` flag prevents an unexpected registry download. With pnpm,
use `pnpm exec rove-sentinel` instead.

## 2. Check prerequisites and create project files

```powershell
npx --no-install rove-sentinel doctor
npx --no-install rove-sentinel init
```

`doctor` checks both CLI versions, subscription-backed authentication, Git,
and GitHub authentication. `init` creates `.rove-sentinel.json`,
`.githooks/pre-push`, and `.githooks/sentinel.mjs`. It preserves existing files;
an incompatible pre-push hook requires deliberate integration.

Inspect and commit these files. Start with the default configuration: the
built-in review charter, no Rove visual rules, and no automatic Cargo builds.
See [configuration](configuration.md) before enabling project integrations.

## 3. Install from a trusted, stable checkout

```powershell
npx --no-install rove-sentinel install --dry-run
npx --no-install rove-sentinel install
npx --no-install rove-sentinel status
```

Installation sets this repository's `core.hooksPath` to `.githooks`, saves an
immutable snapshot of the selected review policy, and starts a repository-specific
watcher. On Windows it registers a hidden logon task. Keep this checkout and
its installed dependency available; do not install the watcher from a temporary
review worktree that will be deleted.

If another checkout owns an active watcher for the same remote, installation
refuses to take it over. Use that stable checkout to upgrade or uninstall first.
Configuration changes require reinstallation; the reviewed branch cannot silently
weaken the running review policy.

`install --no-start` installs the scheduler without starting it immediately;
it does not mean hooks-only or no background integration. For inspection without
mutation, use `install --dry-run`.

## Existing Git hooks

Do not replace an existing hook with the generated one. Preserve its checks and
add a call to a small `.mjs` adapter containing `import 'rove-sentinel/cli';`.
Invoke that adapter with `node`, the `pre-push` subcommand, the original hook
arguments, and the original stdin stream. If an earlier hook stage reads stdin,
buffer and replay it so both consumers receive every ref update.

The current installer supports `.githooks` as the configured hook directory.
Other `core.hooksPath` values are refused rather than silently overwritten.

## Upgrade or uninstall

Before upgrading, let reviews finish. From the stable checkout, install an
explicit newer release URL, inspect its release notes, and run `install` again.
The new version and policy digest invalidate incompatible old attestations.
Every other checkout must install the same pinned dependency.

```powershell
npx --no-install rove-sentinel uninstall --dry-run
npx --no-install rove-sentinel uninstall
```

Uninstall stops and removes the watcher integration and removes an unchanged
generated Sentinel hook. It preserves `core.hooksPath` and unrelated hooks.
Inspect `hookCleanup` in the result: `manual` means you must remove the Sentinel
call from your custom hook before the next push or dependency removal, otherwise
that hook can start the watcher again. Retained local review evidence is separate from
the package. See [troubleshooting](troubleshooting.md) for state and recovery.
