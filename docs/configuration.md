# Configuration

Configuration is optional. The defaults work for any repository.
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
| `guiEvidence` | `none` by default; `required` makes a GUI change commit its visual evidence. `rove` is the earlier spelling of `required` and keeps working |
| `guiEvidenceLayout` | Optional paths of the GUI evidence check; see below |
| `highRiskPaths` | Optional files or folders whose changes get a high-risk review; see below |
| `scriptPaths` | Optional files or folders reviewed through the scripts lens; see below |
| `clippy` | Opt into executing Cargo Clippy for changed Rust files |
| `clippyCrates` | Optional folders of the crates Clippy runs in, `.` for the repository root; without it they are found by their `Cargo.toml` |
| `trustedAuthors` | GitHub logins allowed for automatic same-repository PR review; empty means the repository owner |
| `providers` | `auto` (default), `both`, `claude`, or `codex`; installed authentication requirements |
| `models` | Optional per-provider `model`, `effort`, `maxEffort` and per-role `roles`; see [models](models.md) |
| `maxShards` | Most shards one round of a large change may have, 8 to 128; 16 by default. Each 8 more add a wave of reviewers (a few minutes) and read less per reviewer |
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

## Adopting a new setting

A key newer than a repository's pinned launcher breaks that repository's `install`, and a
fresh checkout has no engine that accepts it. So the key and the pin that knows it land in
one change:

1. If the project relies on behaviour the new release changes, run `updates --disable` in it
   before its watcher activates that release. This holds the repository's selected engine,
   which keeps its behaviour, so there is no gap. It is per repository: the shared engine
   store is only a cache.
2. In one pull request, add the keys and move the pin to the release.
3. After it merges, run `updates --enable`, then `update`, then `install` from your trusted
   checkout.

Without step 1, an automatic update applies the release's defaults from its activation until
step 3.

## GUI evidence

With `guiEvidence: "required"`, a change to the GUI cannot be pushed without its
evidence: PNG files and a `REVIEW.md` in `docs/design/reviews/<branch-slug>/`, committed
in the change. A GUI file is a `.svelte`, `.vue`, `.tsx`, `.jsx`, `.css`, `.scss`,
`.sass`, `.less` or `.html` file; tests, stories and documents do not count. The check validates
the evidence's structure; it does not take screenshots or replace a human visual review.
Leave `guiEvidence` at `none` and none of this applies.

`guiEvidenceLayout` changes any of that, field by field:

| Field | Meaning |
| --- | --- |
| `guiFiles` | Regular expressions on repository paths, replacing the file types above |
| `testFiles` | A regular expression for the files that are neither GUI nor control sources even if another pattern matches them; by default documents, test and story files, and `tests/`, `__tests__/`, `e2e/` and `cypress/` folders. To count a document, such as a rendered `.mdx` page, set both: a `guiFiles` pattern that matches it, and a narrower `testFiles` that does not, because the default leaves out every document |
| `reviewsFolder` | The folder holding one evidence folder per branch |
| `captureCommand` | The command the refusal tells the author to run |
| `controlSources` | A regular expression for the source files that name controls in a `data-control` attribute. Controls are checked only when it is set: each needs a literal id and a row in the registry, a table row of seven cells with the backticked id first, and a new or moved one must change its row |
| `controlRegistry` | The registry's file; `docs/design/control-registry.md` by default |
| `sharedPrimitives` | A regular expression for shared components that may forward `{dataControl}` instead of a literal id |

A configuration that says `rove`, the earlier spelling of `required`, keeps working
and starts from the layout of a SvelteKit application instead, unchanged since that
spelling was the only one. To say the same with `required`, set:

```json
{
  "guiEvidence": "required",
  "guiEvidenceLayout": {
    "guiFiles": ["\\.[sS][vV][eE][lL][tT][eE]$", "\\.[cC][sS][sS]$", "^src/lib/theme/", "^src/lib/components/.+\\.ts$", "^src/routes/.+\\.(?:svelte|ts)$", "^src/app\\.html$"],
    "testFiles": "(?:^|/)__tests__/|\\.test\\.[cm]?[jt]s$|\\.(?:md|mdx|markdown|rst|txt|adoc)$",
    "controlSources": "^src/lib/components/.+\\.svelte$",
    "sharedPrimitives": "^src/lib/components/shared/",
    "captureCommand": "pnpm design:capture"
  }
}
```

Reinstalling is not needed to keep `rove`. Moving to `required` is a policy change,
reviewed and installed as any other, and follows [adopting a new setting](#adopting-a-new-setting).

## How a change is reviewed

Risk decides how many reviewers and shards a change gets. A change is high risk when it
touches the charter or lessons, agent instructions (`AGENTS.md`, `CLAUDE.md`, and
`.agents`, `.claude` or `.grok` skills), Sentinel's own hook, configuration and files,
CI definitions, migrations, `package.json` or `pnpm-lock.yaml`, a tool's configuration file
(`*.config.*`, `*.conf.*`, but for prose), or a path naming permissions or capabilities. No other
folder name raises it. List your project's sensitive paths:

```json
{ "highRiskPaths": ["native", "docs/engineering-process.md"], "scriptPaths": ["native/launcher"] }
```

An entry is a file, or a folder and all under it, from the repository root. A document
listed in `highRiskPaths` no longer takes the documentation skip.

`scriptPaths` takes a file or folder to the scripts lens, which looks for platform and
flag gating, instead of the code lens, and so do `scripts/`, `.githooks/` and `.github/`.
Tests, documents and text manifests there keep their own lens. It changes what a reviewer
looks for, not how much is reviewed.

## Clippy

With `clippy: true`, each crate that holds a changed Rust file gets a `cargo clippy`
in its own folder. A file belongs to every folder with a `Cargo.toml` on the way to it,
so a crate nested in another runs with the outer one, which usually builds it. A
`Cargo.toml` at the repository root counts only when no folder below it has one. A
Rust file with no `Cargo.toml` above it is not linted. To decide instead, list the
crates:

```json
{ "clippy": true, "clippyCrates": ["desktop", "crates/core"] }
```

A changed Rust file then belongs to the deepest listed folder that holds it, and a
file outside them all is not linted. `.` is the repository root. `clippyCrates` does
nothing without `clippy: true`.

A change reaches at most eight crates, in alphabetical order, and the lane's note names
any it left out. They run one after another, share a target cache and one eight-minute
bound. Clippy can execute build scripts and access the host environment. Enable it only
for code you trust to build locally. Large cold native dependency builds can time out
repeatedly; a timeout is a visible lane note, not proof that Rust passed. Other project
checkers can run as `lintCommands`.

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
