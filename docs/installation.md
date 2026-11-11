# Install Rove Sentinel

[Back to the overview](../README.md) · [Your first review](usage.md)

These instructions pin the
[v1.19.0 release](https://github.com/jayyanez/rove-sentinel/releases/tag/v1.19.0)
as an exact dependency. Confirm its archive is listed before installing.
To work on Sentinel itself, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## What you need

Use Windows for the first supported release. Install Node.js 22 or later,
Git, GitHub CLI (`gh`), and at least one of **Claude Code** or **Codex CLI**
separately. Selected AI tools must be on PATH and authenticated: Claude Code through a Claude
subscription, Codex through ChatGPT. An API key alone does not satisfy this
release's installation checks. Your accounts need access to the configured
models; usage consumes your own provider allowances.

On Windows, use native `claude.exe` and `codex.exe` launchers. The qualified
adapter launches executables directly without a command shell; installations
that expose only `.cmd` or `.ps1` wrappers are not supported by this release.
Run `Get-Command claude,codex` in PowerShell and check that the installed providers resolve to
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
npm install --save-dev --save-exact --allow-remote=root https://github.com/jayyanez/rove-sentinel/releases/download/v1.19.0/rove-sentinel-1.19.0.tgz
```

From npm 12, npm refuses a dependency given as a URL (`EALLOWREMOTE`)
unless `allow-remote` permits it. `root` permits your project's own
dependencies and nothing deeper. Add `allow-remote=root` to the project's
`.npmrc` so that later `npm install` and `npm ci` runs accept the pin too.
Releases before npm 12 install the URL without it.

Or with pnpm:

```powershell
pnpm add --save-dev --save-exact https://github.com/jayyanez/rove-sentinel/releases/download/v1.19.0/rove-sentinel-1.19.0.tgz
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

`doctor` checks available CLI versions, configured subscription requirements, Git,
and GitHub authentication. `init` creates `.rove-sentinel.json`,
`.githooks/pre-push`, and `.githooks/sentinel.mjs`. It preserves existing files;
an incompatible pre-push hook requires deliberate integration.

Inspect and commit these files. Start with the default configuration: the
built-in review charter, no visual evidence rules, and no automatic Cargo builds.
See [configuration](configuration.md) before enabling project integrations, and
[models](models.md) to choose providers, model identifiers and reasoning effort.
The 1.11 model defaults require Codex 0.159.0+ and/or Claude Code 2.1.280+.

## 3. Install from a trusted, stable checkout

```powershell
npx --no-install rove-sentinel install --dry-run
npx --no-install rove-sentinel install
npx --no-install rove-sentinel status
```

Installation sets this repository's `core.hooksPath` to `.githooks`, saves an
immutable snapshot of the selected review policy, and starts a repository-specific
watcher. On Windows it registers a hidden task for your own logon, which needs no
administrator: install from your ordinary shell, because a task registered from an
elevated one stays an administrator's, and automatic updates cannot replace it. Its
wrapper keeps the `PATH` and tool settings of the shell you install from: run
`install` again after moving Git or a provider CLI. On macOS it registers a
LaunchAgent, which keeps the same `PATH`, without this checkout or any
`node_modules`, and the same settings, because launchd gives an agent only the
system's folders: install from a shell that finds `gh` and the provider CLIs. Keep this
checkout and its installed dependency available; do not install the watcher from
a temporary review worktree that will be deleted.

In `status`, check that the watcher and policy are compatible, the scheduler is
installed, `watcher.state` is `running`, and `paused` is `null`. A healthy heartbeat
alone does not mean reviews are enabled. An earlier safety pause survives reinstall; investigate its reason
and follow [recovery guidance](troubleshooting.md) before resuming.

If another checkout owns an active watcher for the same remote, installation
refuses to take it over. Use that stable checkout to upgrade or uninstall first.
Configuration changes require reinstallation; the reviewed branch cannot silently
weaken the running review policy.

`install --no-start` installs the scheduler without starting it immediately;
it does not mean hooks-only or no background integration. For inspection without
mutation, use `install --dry-run`.

## Install without changing the repository

The steps above add Sentinel to the project: its dependency, configuration and
hook are committed, and the whole team uses the same release and policy. When you
want the push gate for yourself in a repository where you may not, or should not,
add files, install it locally instead. Nothing goes into the repository's files:
no `package.json`, lockfile, `.npmrc`, `.rove-sentinel.json` or `.githooks/`.

1. Install Sentinel outside the repository, globally:

   ```powershell
   npm install --global --allow-remote=root https://github.com/jayyanez/rove-sentinel/releases/download/v1.19.0/rove-sentinel-1.19.0.tgz
   ```

   or with `npm install` in a folder of its own, and run its
   `node_modules\rove-sentinel\scripts\review-gate\launcher.mjs` with `node`
   wherever these steps say `rove-sentinel`.
2. If the project needs settings, write them to a file outside the repository,
   for example `{ "providers": "claude" }` to review with Claude Code only. It
   takes the [configuration](configuration.md) fields; a `charter` or `lessons`
   path is relative to that file's folder. Without a file, the defaults apply.
   A local installation never reads the repository's `.rove-sentinel.json`, and
   refuses a configuration file, charter or lessons inside the repository, where
   a branch could change them.
3. Check, preview and install, from your ordinary shell:

   ```powershell
   rove-sentinel doctor --repo C:\src\project --config C:\sentinel\project.json
   rove-sentinel install --local --repo C:\src\project --config C:\sentinel\project.json --dry-run
   rove-sentinel install --local --repo C:\src\project --config C:\sentinel\project.json
   rove-sentinel status --repo C:\src\project
   ```

`install --local` writes the pre-push hook into Git's own hooks folder
(`.git\hooks\pre-push`, which Git never commits and every worktree of the clone
shares). The hook calls the Sentinel you ran by its full path, so it needs no
`node_modules` in the project; Sentinel refuses to call one inside the repository
it reviews or any of its worktrees, which all run that hook. Git runs that
folder's hooks only while `core.hooksPath` is unset, so `install --local` refuses
when it is set (by a hook manager such as Husky, or by an earlier project
installation), and when another pre-push hook is already there, and preserves
both. It also refuses a Git directory on a file system without hard links (FAT,
some network shares), which it needs to change the hook safely. A local
installation does not share the pre-push hook: in such a repository,
use the project installation, which [integrates](#existing-git-hooks) with an
existing hook.

The installed policy, queue, reports and watcher are where they always are,
outside the repository. `status` shows `installation.mode` as `local`, with the
hook, the configuration file and the launcher. Inside the clone, Sentinel leaves
only what Git keeps for itself: the hook and, while a review runs, a temporary
worktree registered in the Git directory.

A local installation's watcher leaves pull requests alone: it posts no comment
and reviews only your pushes. Add `--github` to let it review pull requests as a
project installation does. On Windows, automatic engine updates are on as
usual and keep the installation local; `rove-sentinel updates --disable --repo
C:\src\project` keeps the engine you installed. To move to a newer launcher,
install the newer release globally as in step 1; the hook keeps calling it. Run `install --local` again to change the configuration: without
`--config` it reads the same file again, never the defaults. `uninstall` stops
the watcher and removes the hook it wrote; a hook you edited is left for you.
To move to a project installation, `uninstall` first. Every clone of one remote
shares Sentinel's state, so a local installation belongs to the clone it was made
from: another clone of the same remote can neither replace nor remove it while
that clone's hook is there.

## Linter tools

Sentinel's linter lanes use shellcheck, actionlint, gitleaks and ruff when
they are installed. After installing Sentinel, run
`npx --no-install rove-sentinel tools --install`: it lists what this machine
lacks and installs it with winget after you confirm. The first review on a
machine without them, when you run `gate` yourself without `--json`, prints the same
advice
(the hook and the watcher do not print it; `doctor` always does).

## Existing Git hooks

Do not replace an existing hook with the generated one. Preserve its checks and
add a call to a small `.mjs` adapter containing `import 'rove-sentinel/cli';`.
Invoke that adapter with `node`, the `pre-push` subcommand, the original hook
arguments, and the original stdin stream. If an earlier hook stage reads stdin,
buffer and replay it so both consumers receive every ref update.

The current installer supports `.githooks` as the configured hook directory.
Other `core.hooksPath` values are refused rather than silently overwritten.

## Upgrade or uninstall

Windows installations enable [automatic engine updates](updates.md). Sentinel
downloads isolated runtimes and activates them after reviews finish. The project
dependency remains the pinned launcher; it does not require a dependency PR for
every engine release. Inspect `updates` and `status` to see the actual runtime.
Use `updates --disable` to retain a fixed engine. Versions before 1.10.0 need a
one-time launcher upgrade through the project's normal dependency workflow.

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
