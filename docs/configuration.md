# Configuration

Configuration is optional. Defaults work without any Rove source or documents.
Create `.rove-sentinel.json` at your repository root with `rove-sentinel init`.

```json
{
  "schemaVersion": 1,
  "charter": null,
  "lessons": null,
  "guiEvidence": "none",
  "clippy": false,
  "trustedAuthors": []
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `charter` | Repository-relative Markdown policy; `null` uses the bundled charter |
| `lessons` | Repository-relative project lessons; `null` supplies no project lessons |
| `guiEvidence` | `none` by default; `rove` enables the Rove visual-evidence contract |
| `clippy` | Opt into executing Cargo Clippy for changed Rust files under `src-tauri` |
| `trustedAuthors` | GitHub logins allowed for automatic same-repository PR review; empty means the repository owner |
| `providers` | `auto` (default), `both`, `claude`, or `codex`; installed authentication requirements |
| `models` | Optional per-provider `model`, `effort`, `maxEffort` and per-role `roles`; see [models](models.md) |
| `lintLanes` | Turn a built-in linter lane off: `{ "ruff": false }`; all four are on by default |
| `lintCommands` | Project lint commands to run in the review checkout; see below |

Paths use forward slashes and cannot be absolute or contain `..`. Unknown keys
and invalid values are refused. A custom charter replaces the bundled prose;
it cannot override executable blocking rules. Custom charter and lessons files
are high-risk review inputs, even though they are Markdown.

Run `install` from your trusted stable checkout after approving configuration
or policy changes. Review uses the installed snapshot, including configuration,
not the version proposed by the branch being reviewed. Its digest is part of
each attestation. Commit configuration and policy alongside the project.

## Optional Rove compatibility

Rove selects its own charter and lessons, enables `guiEvidence: "rove"`, and
can enable the existing Clippy lane. The GUI validator expects the Rove
`docs/design/reviews/<branch-slug>/` format, actual PNG evidence, review documents,
and `docs/design/control-registry.md` rows for new `data-control` identifiers.
It validates evidence structure; it does not take screenshots or replace a human
visual review. Generic users do not need these directories.

Clippy currently targets `src-tauri/Cargo.toml`, uses a shared target cache,
and has an eight-minute bound. It can execute build scripts and access the
host environment. Enable it only for code you trust to build locally. Large
cold native dependency builds can time out repeatedly; a timeout is a visible
lane note, not proof that Rust passed. Arbitrary crate paths are not
configurable in this release; other project checkers can run as
`lintCommands`.

## Linter lanes

Sentinel runs shellcheck, actionlint, gitleaks and ruff on the changed files
whenever they are installed on the host. The first `gate` you run on a
machine that lacks some of them says which (not under `--json`; the hook and the
watcher do not),
and `doctor` and `tools` always do. Sentinel
installs them when you ask (winget on Windows, Homebrew on macOS; elsewhere it
links each tool's instructions):

```powershell
npx --no-install rove-sentinel tools            # what is missing and how to get it
npx --no-install rove-sentinel tools --install  # asks, then installs
npx --no-install rove-sentinel tools --install --yes  # for an agent or a script
```

The winget equivalent is
`winget install koalaman.shellcheck rhysd.actionlint Gitleaks.Gitleaks astral-sh.ruff`.
A running watcher finds tools winget or Homebrew just installed without a
restart.

They read the project's own configuration where the tool supports it
(`.shellcheckrc`, `.github/actionlint.yaml`, ruff's `pyproject.toml`), except
gitleaks, which always uses its built-in rules. Only hits on lines the change
added are reported.

Project commands run your own checker in the review checkout:

```json
{
  "lintCommands": [
    { "name": "tsc", "run": ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false"], "format": "tsc", "nodeModules": true },
    { "name": "eslint", "run": ["node", "node_modules/eslint/bin/eslint.js", "-f", "unix", "{files}"], "format": "unix", "files": "\\.(?:ts|tsx|js)$", "nodeModules": true }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Lane name in reports: lower-case letters, digits and dashes |
| `run` | Program and arguments, without a shell; `node` is Sentinel's Node.js. On Windows run a package's script with `node`, not its `.cmd` shim |
| `format` | `unix` (`path:line:col: message`, an ESLint-style `[Error/rule]` tag sets the severity) or `tsc` |
| `files` | Optional regular expression: the command runs only when a changed file matches, and `{files}` in `run` becomes those files |
| `scope` | `added-lines` (default) or `all`, for a checker that is clean on the base and should report every hit |
| `timeoutMinutes` | 1 to 15; 5 by default |
| `nodeModules` | Link the trusted checkout's `node_modules` into the review checkout while the command runs |

Project commands execute your toolchain and the configuration in the reviewed
branch (an ESLint config is code), so they come only from installed policy and
the watcher runs them only for trusted authors. The `node_modules` link is a
junction removed before the lanes return; removing a review checkout never
follows it.

## Provider choices and fixed execution limits

At least one of Claude Code or Codex is required. Projects can choose providers,
models and efforts through the installed configuration; [models](models.md)
explains validation, live access probes and the defaults. Concurrency, timeouts,
and convergence budgets remain versioned in `scripts/review-gate/constants.mjs`.
Arbitrary provider plugins are not public extension points yet. Do not set API keys to work
around an unsupported account: normal subscription runs scrub inherited API
credentials, and installed watchers explicitly discard the billing override.

The default base is `origin/main`. Use `gate --base <ref>` for an explicit
foreground target. The pre-push workflow currently assumes the remote's `main`
branch for new branches; projects with a different primary branch need an
adapter change before adopting the hook.
