# Standalone validation record

## 1.19.0 a push gate that leaves the repository as it is — 2026-11-11

Deterministic tests cover the local hook's text and its recognition for any launcher path
(spaces, quotes, `$`, backslashes, CRLF), and that the project hook, an edited hook or another
hook is never taken for it; a real `git push` running the hook with the remote, the ref
updates and the checkout, and leaving no file in the repository; the hook's place in Git's own
hooks folder, shared by a linked worktree; the refusals under a set `core.hooksPath` and over
another hook; a launcher inside the reviewed repository (in any letter case on Windows) or in
the managed engines refused; the policy read from a file outside the repository, with its
lessons beside it, the repository's `.rove-sentinel.json` ignored and a missing file refused;
the installation record; the install transaction writing the hook and the record without
`core.hooksPath`, and taking both back, or restoring an earlier hook, when the watcher does
not start; `status`; `uninstall` removing only its own hook; and a detached gate's default log
in the state folder, with the checkout left clean. After the gate's review they also cover
every worktree and the Git directory as the repository, for the launcher and for a
configuration file, charter or lessons; another clone of the same remote neither replacing nor
removing the installation, nor reported as holding it; and a hook written or changed meanwhile
never overwritten, deleted or lost by an install, a rollback (an earlier hook is put back even
when the replacement could not be created, or was cut short) or an uninstall, since a hook is
created whole or not at all; a Git directory without hard links refused before anything
changes, and probed without creating a hooks folder; and worktree paths that hold a newline.
After CodeRabbit's review they cover Node run by its absolute path while a planted `node`
comes first on `PATH`, a Node inside the repository refused, only the exact hook written
replaced or removed, and a hook without its executable bit not counted outside Windows.
1,021 tests passed on Windows. The package smoke installs the archive outside a
consumer repository, writes the local hook with the packaged module, and pushes through it to
the packaged launcher.

Live on Windows Server 2025, with a throwaway repository whose remote is a local bare
repository, the packed archive installed with `npm install` in a folder of its own, and `{
"providers": "claude" }` in a configuration file outside the repository: `doctor --config`
selected Claude Code only, `install --local --dry-run` probed the same, then `install --local`
registered and started the watcher (`watcher-options.json` `github: false`), wrote
`.git/hooks/pre-push` and left `core.hooksPath` unset. A `git push` of a code change ran the
hook, the watcher reviewed it with Claude Code only and passed it, and the push completed. A
plain `install` was refused, naming the local hook; `install --local` without `--config` kept
the recorded file and `providers: claude`; `install --preserve-policy` run by the engine's own
CLI, as an engine update does, kept the installation local and the hook byte for byte;
`uninstall` removed the task, the hook and the record. `git status --porcelain --ignored
--untracked-files=all` stayed empty throughout. Not yet live: a global npm installation,
macOS, and an automatic update to a newer engine (none newer exists).

## 1.18.0 review accounts — 2026-11-06

Deterministic tests cover the accounts file and its validation; that no file leaves reviews
unchanged; the author's account kept out while another is usable, and used last, on the record;
holds and rotation per account; the next account before a provider is dropped, under every
requirement; the review target pinned across restarts; each reviewer's environment carrying
only its account's folder; the refusal of overriding credential variables; probes that settle
before a cleanup failure is raised; the accounts file carried by every watcher start and
rollback; and labels, never folders, in the evidence. 982 tests passed on Windows, and the
package smoke passed. Each change went through the review gate.

Live: each account's sign-in was read through the CLIs' own status commands with its folder.
Not yet live: no review has run under a second account of either CLI, and
`doctor --test-models` probes models with the inherited login only.

## 1.17.0 a review that goes on when a provider cannot — 2026-11-06

Deterministic tests cover the classification of usage-limit errors, including a completed
review that mentions a limit; the reading of reset times; provider holds, their expiry,
their clearing and their precedence; `auto` selection skipping a held provider; explicit
requirements refusing; the one restart after a usage limit or a provider failure that
survived its retry, for Claude and Codex; a second failure failing closed; the round veto
that keeps a local error, a cleanup failure, the launch fence or a failed deterministic
lane from restarting; tolerated scout and hypothesis failures; and the evidence the report
and attestation carry. 932 tests passed on Windows. Each change went through the review
gate.

Not yet live: no provider CLI out of its allowance has been observed, so the usage-limit
wordings are assumed (see the [plan](plans/provider-usage-limit-fallback.md)); the generic
fallback does not depend on them. The watcher path has no test of its own; it runs the
same gate.

## 1.16.1 a watcher that comes back, and says when it cannot — 2026-11-02

Deterministic tests cover what a LaunchAgent carries: the shell's `PATH` without the
checkout, however it is spelled or linked, any `node_modules`, relative or unusable entries or
a missing folder, in the plist's XML and bounded, with launchd's own folders kept and no
credential. They also cover the count of failed polls across a real `runWatcher`, and
`watcher.state` `failing`, `watcherHealthy` and `watcherRunning` in `status` and `doctor`, after one
failure, after two, after `--no-github` and after `install`, which a failed install restores;
an automatic update reads `watcherRunning`.

Live on macOS 27 on Apple silicon, Node 26, with a throwaway repository whose remote does not
exist, in a real LaunchAgent. The previous engine recorded `Could not start gh: spawn gh ENOENT`
and `status` said `watcherHealthy: true`, `running`. This engine's plist carried the shell's
tool folders and no `node_modules`; `gh` started under launchd, and its two polls failed on the
missing repository. Both `status` and `doctor` then warned, with `failing` and
`watcherHealthy: false`. A poll that succeeds under launchd has not run live, nor has this on
Windows or through an automatic update.

Deterministic tests also cover a lock left by a restart, with each test of the rule, starters
held at each step, and eight real processes racing; a review checkout beside an owner that
cannot be signalled; a torn result beside a claim; and the Windows task's trigger and settings,
its wrapper's environment and line length, the refusal over an administrator's task, and the
start log.

Live on Windows 11 under a limited token: `install` from nothing and again over its own task,
`uninstall`, the task's own-user trigger and settings, and an empty start log on a healthy
start. Before that change's last two commits, the task's logon trigger fired after a real
restart, and the refusal over an elevated task gave steps that worked.

The suite passed on Windows Server 2025, Node 24.18: 871 tests. `pnpm verify:package` passed,
reporting 1.16.1. `scripts/runtime-smoke.mjs` passed on this release with synthetic 1.16.2 and
1.16.3 engines: a busy project waited while a second activated the shared runtime, two projects
reused one download, pinned launchers selected the new runtime without editing their
dependencies, a working-tree policy was kept out of activation, and the real scheduler restored
the previous watcher after an injected failure. No fixture task remained, and the real
watchers' tasks were unchanged.

A clean restart ran through the lock rule on Windows on 2026-11-02, with the build of #27 as a
separate test watcher and no `recover` at any point. The last heartbeat was at 01:10:22.9Z and
the boot at 01:10:43Z. The lock passed from one process to another with a new token, a
`restart-lock-replaced` event was recorded, and the watcher came back healthy. That build came
before the later changes in this release, so the restart has not run on this release's own head.

A power cut, a shutdown with Windows Fast Startup, macOS and Linux have not run through the
rule, and neither has an older engine's `stop` or `recover` as a real process. No update from
1.16.0 to this release has been exercised.

## 1.16.0 generic paths, and a watcher you can see — 2026-11-01

Deterministic tests cover risk ratings and shard lenses for a repository that sets
nothing and for one that lists its paths; the GUI evidence check with and without
`guiEvidenceLayout`, including that the settings documented for leaving `rove` behind
classify the same files as `rove`; Clippy's crate discovery, its shared bound and its
placement of a workspace member's messages; `watcher.state` in each state, a corrupt
lock, a scheduler that cannot be read or started, and `uninstall`; `doctor` warning
before a check fails; a stop and `recover` beside an owner that cannot be signalled; and the
engine install's environment and flags.

Live: `cargo clippy` 0.1.94 through the lane on a synthetic workspace placed both
warnings on their real files. A local listener recorded each `CONNECT` on Windows
(Node 24.18, npm 12.0.1) and macOS (Node 26.13, npm 11.20): npm honoured `HTTPS_PROXY`,
and Node's `fetch` did only with `NODE_USE_ENV_PROXY=1`. Node releases before 22.21 were
not run. npm 12.0.1 reproduced `EALLOWSCRIPTS` with `npm_config_allow_scripts` set, and
an install with the new flags and no such variable succeeded.

The suite passed on macOS: 763 tests passed and 1 was skipped, a WinGet test that runs
only on Windows. Each change went through the review gate.

`scripts/runtime-smoke.mjs` passed on Windows on this release before the last change to how
a stop reads a process check, which it was not run again after, with synthetic
1.16.1 and 1.16.2 engines: a busy project waited while a second activated the shared
runtime, two projects reused one download, pinned launchers selected the new runtime
without editing their dependencies, a working-tree policy was kept out of activation, and
the real scheduler restored the previous watcher after an injected failure. No fixture
task or process remained, and the real watchers were not touched.

No project has yet run this engine's new ratings on real changes, and no update from
1.15.0 to this release has been exercised.

## 1.15.0 several computers, and macOS — 2026-10-31

Deterministic tests cover the watcher's GitHub choice: `--no-github` stops
polling, from a scheduler's start or a hook's, and a synchronization under way;
the default polls; an engine update keeps the choice; a failed install restores
it; an install killed midway, or whose process id was reused after 15 minutes,
leaves it as it was. One limit is recorded: within those 15 minutes, an unrelated
process that takes a killed installer's id keeps its choice alive until install
runs again.

Live on macOS 27 on an M4 Max, Node 26: the suite passed, 589 tests; a real project's install registered its LaunchAgent and the watcher answered; a full gate with
Claude Code and Codex reviewed real changes, with its linters from Homebrew; and
two branches went through the hook to GitHub, one of them pushed by an agent that
another computer had started. Engine updates on macOS were not exercised, and
Intel Macs were not tested. The same tree's Windows checks are the pull request's.

## 1.14.0 shards for large changes — 2026-10-19

Deterministic tests cover the shard count by size (unchanged up to about
830 KB), the per-project cap and its validation, the larger candidate bound
and the thin-review note, including a gate run over a 1.3 MB change.

One side-by-side live run reviewed the same real change, a consumer project's large change (3.6 MB review patch, 233 files), as a full high-risk round with both
providers and that project's installed policy, in isolated state: 1.13.0 (8
shards) took 7.6 minutes and verified 7 P2 and 2 P3 findings; 1.14.0 (16
shards, two waves) took 8.4 minutes and verified 16 P2 and 7 P3. One run
each: it shows the time cost is small and the yield higher on this change,
not a recall measurement; the findings were not triaged against the code.

## 1.13.0 recall and reference-map speed — 2026-10-18

Deterministic tests cover the documentation skip (plain-text and MDX files are
reviewed), the new high-risk paths, the kept below-floor candidates and their
ledger label, the quoted and bounded commit messages in the context, test
families in shards (including size packing), the lens of every kind a shard
holds, declaration extraction for the added languages, the batched blob reads
and the order-independent rendering of parallel sweeps. Each bug fix has a
regression that fails on the commit before it.

The reference map of this repository's 1.11.1–1.12.0 range (28 files) was
built by both engines from the same objects: 6.4–7.7 s with 1.12.0 and
0.9–1.0 s with 1.13.0, byte-identical output. A single local measurement,
not a benchmark.

The candidate engine reviewed its own branch live (Claude Opus 5.5 and
GPT-6.1 Sol at high, the installed policy, an isolated state root). The first
round was a full high-risk review (six shards, three hypotheses, eight
candidates) that took 7.5 minutes, of which the reference map took 1 second;
the installed 1.12.0 watcher's recorded average for that stage on this
repository is 7 seconds. It verified three P2 and four P3 defects in the
change itself; five follow-up rounds fixed them and the further split C
signature spellings each round found, and the sixth round passed. The report
kept the two candidates under the confidence floor. The new language patterns
were exercised only by deterministic fixtures, not on a live non-JavaScript
repository, and no round has yet run with the released 1.13.0 package.

The second wave (material in the prompt on standard input, streamed
adjudication, per-role settings, prior blockers read
around their location) ran live in six more follow-up rounds of the same
branch; they found and fixed seven defects in it, and the last round passed.
Per-role settings ran only in deterministic tests. Reusing shard reviews after
a rebase was built, reviewed by the installed gate twice, and removed: each
round showed another dependency a textual test could not see (a call through
a re-export alias, a transitive import), and a reuse that can miss a changed
dependency weakens the review's coverage.

The linter lanes were checked against the real tools on Windows (shellcheck
0.11.0, actionlint 1.7.12, gitleaks 8.30.1, ruff 0.17.1): each found its
defect on an added line in a synthetic file, and gitleaks kept the token out
of the report. A `tsc` project command ran on a consumer's real head (107
changed files) in a detached checkout with the trusted `node_modules` linked:
it reported a type error added for the check, the link was removed, and the
trusted `node_modules` was intact; all lanes took 16 seconds, beside the model
review. No gate round has yet run with a project command in installed policy.

One side-by-side run reviewed the same historical change (1.11.1, 17 files,
630 changed lines, high risk, full round) with 1.12.0 and with 1.13.0, both
with both providers and the installed policy: 5.8 minutes against 3.0. The
reference map took 6 s against 1 s, hypotheses started 75 s in instead of 93
and took 29 s instead of 95, and adjudication began at 118 s instead of 188
and took 63 s instead of 157. Both runs verified the oversized-line defect
that 1.12.0 later fixed; 1.12.0 also verified two defects 1.13.0 did not
report (an unescaped continuation path and part paths in the argument
vector, which standard input removes). One run each is a timing
observation, not a recall measurement.

## 1.12.0 shard parts and reruns — 2026-10-10

Deterministic tests cover the context bound (the bounded patch applied to the
base gives the head's tree), the part-by-part retry, kept shard reviews and
the failure message. The gate-level regression uses a synthetic repository and
a controlled provider that reads every part in one command behind an output
limit; it is not live acceptance. It fails on 1.11.2 with the reported error.

One live Codex shard role (GPT-6.1 Sol, high) ran with the candidate engine,
outside a gate, on the consumer head that had failed closed three times: the
shard holding the reported file (five files, 76.9 KB in four parts) completed
on its first attempt in 94 seconds. That is one run: it shows the reworded
instruction can be followed, not how often it is. The part-by-part retry and
the reuse of kept shard reviews have not run against a live provider, and no
full gate round ran with 1.12.0.

## 1.11 model and subscription qualification — 2026-09-29

Default model access passed at high and xhigh with Claude Code 2.1.284 (Opus
5.5) and a separate official Codex 0.159.0 installation (GPT-6.1 Sol) using the
maintainer's existing subscriptions. Codex 0.154.0 rejected GPT-6.1 Sol with
ChatGPT sign-in; the version guard has deterministic coverage.

Real low-risk synthetic committed changes ran through the full pipeline with
`providers: "claude"` and `providers: "codex"` separately. Each produced a
candidate, adjudicated it in a fresh session of the selected provider, and
blocked the introduced discount-calculation defect. Reports recorded the
model, high effort, role and selected single-provider mode. Temporary contexts
and review checkouts were cleaned up; no persistent fixture watcher was created.

The first Codex trial used an incomplete standalone client distribution. The
model reported that the missing tool host prevented context reads, but its empty
candidate list initially passed. This exposed a coverage gap: the final adapter
requires an explicit completeness declaration and rejects incomplete reviews.
Regression tests cover missing and false declarations. The final trial used
the official matching CLI and helper executables and completed the review.

Deterministic tests also cover authentication, required providers, frozen custom
profiles, client versions, one escalation, failed/repeated escalation, and cached
single-provider provenance. Escalation mechanics use controlled responses;
live probes establish access at both levels, not a natural escalation rate or
a review-quality benchmark. macOS/Linux remain unqualified.

The incumbent published engine reviews the final committed change before push.

## Original standalone qualification

Date: September 25, 2026. This records observed acceptance, not a guarantee that
all defects have been found.

## Windows host

Node.js 24.18.0, Git 2.55.0.windows.3, Claude Code 2.1.283 and Codex CLI 0.154.0.
Both provider CLIs were authenticated through their required subscription paths.
No provider credentials or private review transcripts are included here.

## Release-update acceptance

The 1.10.0 candidate passes 429 deterministic tests, including stable release and
asset validation, cache/offline behavior, SHA-256 rejection, immutable runtime
selection, active-review exclusion, rollback and recovery fencing. Multi-project
fixtures verify independent activation with a shared runtime store. These lifecycle
tests simulate subprocesses; they do not establish live Windows activation.

Packaged installation passed. The Windows runtime smoke test created two local
consumer repositories and real scheduled watchers, installed synthetic next-version
archives through checksum-verified npm, held an active review lease in one project,
and verified independent activation of the other using the shared download. It then
released the lease and verified the first project's activation. Both pinned
launchers selected the new engine without changing manifests or lockfiles, and an
unapproved working-tree charter was excluded. An injected replacement startup
failure exercised restoration of the real previous scheduler/watcher. Both fixture
watchers were uninstalled successfully. No paid reviews or GitHub publication ran.

Live testing found and fixed scheduled-task state-directory propagation and a pause
heartbeat that was immediately overwritten during idle sleep. Regression tests
cover both. Native notification delivery still depends on Windows settings; the
retained CLI state is the fallback. The Windows notification API accepted the
synthetic notification test; visual delivery under every OS notification setting
is not claimed. The v1.9.0 acceptance below is historical.

## Original v1.9.0 acceptance

| Check | Observed result |
| --- | --- |
| Extracted regression suite plus standalone tests | 392 tests passed across 23 files |
| Packed package in an isolated consumer workspace | Installed without Rove code or documents |
| Version, help, initialization and default policy | Passed from the installed archive |
| Windows scheduled watcher installation | Scheduler installed; healthy compatible heartbeat |
| Deliberately broken subtraction fixture | Claude proposed the defect; Codex confirmed P2; review failed |
| Corrected subtraction fixture | Follow-up review passed for the new head |
| Hook on the reviewed head | Accepted with no bypass |
| Different unreviewed head while watcher paused | Refused; old PASS was not reused |
| Watcher reinstall | Completed successfully |
| Watcher uninstall | Scheduler removed; generated hook removed; shared hook configuration preserved |
| Retained safety pause after stopping an in-flight GitHub CLI call | No recorded process or direct child remained; healthy watcher resumed after inspection |
| Existing-hook preservation | Covered by deterministic regression tests |
| Hosted Windows CI, Node 22 and 24 | Tests, notices and archive installation passed for final extraction head `bcd81c0` |
| Published v1.9.0 archive | Downloaded from GitHub Releases; SHA-256 matched the published checksum |
| macOS and Linux live operation | Not qualified |
| Windows logoff/logon cycle | Not exercised; scheduled task was started through Task Scheduler |

The fixture had a deliberately simple arithmetic defect. It proves the installed
provider and adjudication path ran; it is not a review-quality benchmark.
Recovery and process-tree edge cases are exercised by the regression suite;
not every OS failure was induced on a live host.

A post-merge CI run on Node 22 exposed an intermittent test failure: a 250 ms
budget could expire before the child Node process produced its first output.
The follow-up test gives startup five seconds and keeps the child alive for
30 seconds, preserving the real timeout and captured-output assertion. It does
not change runtime timeouts or rewrite the published v1.9.0 archive.

During shutdown acceptance, a GitHub CLI process exited during the termination
check and the watcher retained a safety pause. Reinstallation preserved it.
Inspection found no matching process or direct child. Stale-state recovery
correctly refused to remove the healthy replacement watcher's lock; `resume`
cleared the inspected pause. A failed termination proof is never treated as
permission to continue without investigation.

Independent review covered the complete committed extraction and a follow-up.
Two repository-identity defects were fixed with regressions that failed before
the fixes. Markdown lint passes. CI results are retained in
[the workflow history](https://github.com/jayyanez/rove-sentinel/actions/workflows/verify.yml).

Rove passed full verification with the published archive after removing the
embedded engine: 5,647 tests passed, one test was skipped, and Svelte reported
zero errors plus one pre-existing warning. Its adoption passed independent
review and CodeRabbit review before the authorized merge.

The canonical Windows checkout now uses the pinned public release. Installation
replaced its old idle watcher; the old process exited, the scheduler resolves the
installed package CLI, and status reports gate 1.9.0 / charter 1.8.0, compatible
policy, a healthy watcher and no pause. All 26 consumer/design integration tests
passed again from that canonical checkout. This qualifies the observed Windows
migration; it does not establish macOS/Linux support or universal review quality.
