# Standalone validation record

## 1.21.2 three watcher fixes — 2026-11-27

`process.test.ts`'s output-limit test gives its child up to 30 seconds of its own, so it no
longer races the child's exit. It failed only under load before: a live run of 600 children that
overflow and exit at once, 160 at a time on Windows with Node 24, called 17 orphaned; with the
child kept running, 0 of 400 at 8 and 32 at a time (at 160 at a time taskkill itself fails for
lack of system resources, far above the provider bound of 8). Deterministic tests, each failing
without its fix: `github.test.ts` reaches every pull request and reports the publish error with
the events folder replaced by a file, and republishes a stored failing outcome with its public
summary; `daemon.test.ts` keeps the GitHub failure record when the events folder breaks during
the poll, keeps a successful poll a success and a failed one a GitHub error (saying when it
retries) when the failure record can be neither written nor removed, counts a poll that rejects
without a reason as a failure, counts every failure in every order of success, failure and an
unreadable record (the pure streak step), counts a failure whose record could not be written in
the next record written, starts a new streak after a success, reads no streak from a missing or
malformed record (corrupt text included) and an unknown one from a record it cannot read (the
watcher's use of the streak across two polls of one run is not covered by a test);
`gate.test.ts` names lanes by status in the public summary, keeps a failing lane's local folder
out of a real `runGate` round's comment, keeps a cleanup failure's folders local, and publishes
no summary not written for the comment except a skipped change's; `settleDeferrals.test.ts`
gives a settled round the same public summary. 1,174 tests passed in 42 files on Windows on the
development host, and the package smoke passed (`rove-sentinel@1.21.2`).

## 1.21.1 a rerun of an unchanged head settles from the round that reviewed it — 2026-11-27

Deterministic tests in `scripts/review-gate/__tests__/settleDeferrals.test.ts` (17 new tests)
cover: a follow-up head that failed on a persisting P2, deferred, and rerun with no provider
available settling with no reviewer or adjudicator call while the injected reviewer would have
named a new defect, the deferral applied, the deterministic lanes run once, the round,
follow-up base, repair-round and late-discovery counts unchanged, the head's lineage record
replaced (one record, the same reviewed-head count), an attestation the pre-push disposition
check accepts, and the next head counting the settled head once; a rerun with a P1 left
blocking giving the same FAIL without a review, settling again from the settled report while
naming the round that reviewed, `--dry-run` naming the round it would settle from, and a new
`--intent` or `--force` reviewing afresh with the same classification; a lane hit still present
enforced again, a lane with hits that stops part-way sending the head to a fresh review that
enforces what that run reported without running the lanes again, through a restart after a
provider's usage limit too, with the lanes' own time in the report, and run again by a restart
under another installed policy than they ran under (a lane result is handed only to a run of
its exact identity), and a hit its lane no longer reports dropped; the intent the
reviewers read kept through a settlement that states none, the same intent settling and another
one reviewed; a deferred late-discovery blocker keeping its spent
round in the report and the lineage record, through a settlement and a forced fresh rerun; a
deferral removed while the lanes run sending the head to a fresh review that reads the records
anew; a round with a finding waiting for native evidence reviewed again, and
`defer` saying so; which reports can settle (status, each of the six identity fields, branch,
author, risk, a different stated intent (none stated settles), round, follow-up base, native evidence, malformed findings, a
deferral no longer recorded, a deferral following a renamed file); when a run may settle at all
(`--force`, provider and account restarts, a skipped change, the head's own record); which
recorded deferrals still have a renamed path to follow (the fresh round's rule, a record's
existing file ignoring its former paths); and how a recorded deferral applies to
settled findings (never to P0/P1, not to a dismissal, every lane hit dropped for the fresh
ones). The settling tests fail on 1.21.0's sources (the reviewer runs again on the
unchanged head). `scripts/review-gate/__tests__/github.test.ts` adds three: an ERROR comment
for a result with accounts, an account fallback, the author's own account and every error form
that names an account, a folder or a CLI's output names none of them; a completed review's
summary is still published; and the watcher's own catch path, reviewing once per error with
each of those errors thrown by the review, publishes none of them and keeps each in the head's
local outcome record (both fail when the summary is published). Two account tests assert
the comment's silence. 1,160 tests passed in 42 files on Windows on the development host, and the package smoke
passed (`rove-sentinel@1.21.1`).

## 1.21.0 deeper context, cross-file integration review, and faster verification — 2026-11-22

Deterministic tests in `scripts/review-gate/__tests__/reviewIntelligence.test.ts` (40 new tests)
and the updated existing test suites cover:

- **Bidirectional and enclosing-aware reference map:** `findEnclosingSymbol` for brace-delimited
  and Python/Ruby indent-scoped edits inside existing bodies (ignoring balanced one-line siblings
  and comment-only edits); tiered symbol extraction prioritizing production functions, classes,
  and types over local helpers and test-only symbols; upstream callee/type resolution from local
  relative imports and bounded fallback `git grep` sharing a single 8-way Git concurrency pool;
  surgical per-shard reference-map slices (`sliceReferenceMapForShard`) and compact PR structural
  digests (`buildPrStructuralDigest`).
- **Coupling-aware sharding:** `partitionShards` clustering changed files connected by local
  imports or shared changed symbols into the same shard while preserving test-family attachment
  and deterministic ordering when no couplings exist.
- **Cross-file scout, grouped integration review, and dual-pass coverage:** `scoutPrompt`
  inlining the PR structural digest and focusing on cross-file/symmetry/intent-gap hypotheses
  while keeping the `You own no part of the patch` completeness contract; `groupHypotheses`
  consolidating hypotheses into up to 2 grouped integration passes; `runGate` executing grouped
  integration reviewers and an independent cross-model second-opinion reviewer on small low-risk
  and small high-risk changes when both providers are active; low-risk dual-provider routing.
- **Adjudication and follow-up convergence:** lowered `candidateConfidenceFloor` (40); proximity
  and token-similarity corroboration (`areCandidatesRelated`); file-grouped tail adjudication
  batches; cross-batch duplicate consolidation for overlapping verified findings on the same
  file/region (honoring only `Duplicate of <surviving verified id>` dismissals so real defects
  cannot be dropped); pre-extracted ±25-line head excerpts and diff hunks
  (`buildCandidateEvidence`, hardened against path traversal, symlinks, drive-relative paths, and
  binary/oversized files); evidence-backed dismissal and latent-defect rules in prompts and
  charter; structured `prior_blocker_verdicts` (`fixed`, `still_present`, `unverified`) with
  path canonicalization and mechanical re-synthesis via `reconcilePriorBlockerVerdicts` when a
  prior blocker is `still_present`, `unverified`, or missing a verdict.
- **Policy, PR intent, and deterministic lanes:** optional `pathRules` (1–32 rules, omitted from
  normalized config when unset) and `matchingPathRules`
  injection into matching shards; optional `p3Mode: "informational"` keeping P3 advisories
  visible without requiring deferral; `selectReviewLessons` scoring symbol keywords and
  `Tags:` / `Paths:` metadata; quoted, bounded untrusted `prIntent` via `gate --intent` and
  `readPullRequestBody` (included in `shardAssignmentDigest`); omitting exact placeholder
  `open-bug-briefs.md` and `bug-lessons.md` from both `Required reads` and inline prompt material;
  built-in `oxlint` (fixed text-only config) and `hadolint` lanes; Ruff surfacing newly introduced
  hard syntax/undefined-name errors and Oxlint surfacing environment-independent hard
  syntax/correctness errors on any line of a changed file (mapped against base);
  `lintCommands[].scope: "changed-files"`; package contract, limits parity, and public-repository
  hygiene checks.

All 41 test files (1,140 deterministic tests, 0 failures, 0 skipped, including 40 new tests in
`reviewIntelligence.test.ts`) and `pnpm verify:package` (`rove-sentinel@1.21.0` isolated
consumer smoke test) passed on Windows.

Live on a Windows host against authenticated Claude Code (`claude-opus-5-5`) and Codex
(`gpt-6.2-sol`) CLIs using an isolated temporary repository with three seeded defects (an
untouched caller dereferencing a newly nullable return value, a latent `parseTimeoutMs("") -> NaN`
defect exposed by removing a caller guard, and an incomplete claimed fix described in commit
messages and `prIntent`):

- Full high-risk round: 3/3 seeded defects verified as P2, 0 false positives, 0 schema errors;
  cross-batch consolidation collapsed 9 overlapping verified findings across 4 adjudication
  batches down to the exact 3 unique defects (`reference-map 0s · shards 29s · scout 25s ·
  cross-model-second-opinion 34s · hypotheses 39s · adjudication 1.1m · consolidation 48s`).
- Follow-up rounds with 2 defects fixed and 1 left unfixed, exercised on both Claude (sim #1,
  81 s) and Codex (sim #2, 84 s): both CLIs accepted `followupReviewerSchemaForBlockers`
  (`prior_blocker_verdicts`) cleanly, closed the 2 fixed blockers, and kept the unfixed blocker
  enforced as `[persisting]`.

Live incumbent-engine self-review (`rove-sentinel@1.20.3`, `pnpm review:gate -- --base origin/main
--head HEAD`, Claude + Codex):

- Round 1 (`44e8bbb`, full high-risk round): identified and fixed P2/P3 defects across pre-push
  validation of `p3Mode: "informational"`, low-risk agent shard routing, cross-batch consolidation
  priority and persisting-blocker preservation, cache-stagger cleanup-fence enforcement, zero-shard
  lens follow-up blocker verdicts and non-empty verdict evidence, exact placeholder detection in
  `context.mjs`, lazy per-PR body fetching in `github.mjs`, Ruff `invalid-syntax` and baseline-diffed
  off-hunk hard-error filtering plus Windows path casing and untouched-line attribution in
  `toolLanes.mjs`, reference-map edge cases (same-named imports, unchanged callers, sibling scopes,
  commented imports, Go/C declarations, Git-quoted paths, shared co-change commits, and digest byte
  caps), Windows `tools` guidance, CLI `--intent` parsing, contract test coverage, and release notes.
- Round 2 (`a2cbb80`, follow-up round, 4 shards, 1.5 m): `PASS` with 0 P0/P1/P2 blockers,
  0 undisposed advisories, and 0 markdownlint/gitleaks hits. Three follow-up P3 polish items
  were fixed in `26674f3`, which also passed (`PASS`, 53 s).
- CodeRabbit + PR-watcher full-review fixes: added fixed static `--config` +
  `--disable-nested-config` for text-only Oxlint (keeping head and baseline rules identical),
  preserved backward compatibility for existing `lintCommands` named `oxlint`/`hadolint`, enforced
  cross-batch relatedness in duplicate consolidation, rejected duplicate/conflicting
  `prior_blocker_verdicts`, preserved duplicate textual sections per path and fitting coupling
  clusters across shard boundaries, cached per-file declaration indexes in `refmap.mjs` and
  advanced fallback lexing through hunk context, added hunk-mapped base line matching plus a
  shared lane deadline and explicit baseline-coverage notes in `toolLanes.mjs`, and added the
  grouped integration candidate cap to `limits.mjs`.

## 1.20.3 `repair` lists every Windows process and updates when the bootstrap runs it — 2026-11-22

Deterministic tests cover: the Windows listing read one line a process, a name and command
line holding `→ • ✓ ×` decoded from base64; a damaged line keeping its process, marked
unreadable, with an unknown parent PID or start time (one beyond what a Date holds) and an
empty command line, as is a line without its end marker, one with an empty parent PID, and
one whose text is not UTF-8, while a leading U+FEFF is kept; other PowerShell output
ignored, and a listing without its end line, with another count, or with a process line
without a PID failing; a safety pause kept, in a dry run and a repair, while an unreadable
process is listed, and a dry run with `--stop-orphans` not promising to resume then, unless
that process is one it stops, nor past a leftover without a start time, which a repair with
`--stop-orphans` keeps counting after stopping its parent; the repository's own command run
without any `npm_` variable of the environment, such as the `npm_config_package` and
`npm_config_yes` that `npx --package` leaves, and with the rest kept: `--version` on Windows
and macOS, `update` on Windows (its result mocked); a repair that stops before it can
report, from the CLI and from the launcher, giving a blocked `repair` step (as text, a
`blocked: repair:` line; as JSON, the report's first step) whose next command is the
bootstrap in the checkout `--repo` named (unless a later `--no-repo` cancels it), with the
options as the CLI reads them (the last of `--stop-orphans` and `--no-stop-orphans` wins),
and exiting 1; the same repair run by the bootstrap printing no `Next:` line and saying to
stop and report; the bootstrap downloading 1.20.3 or later. On Windows, a test starts a
process whose command line holds `→ • ↑ ↓ § ¶ ✓ ✘ ×` and 5,000 more characters and finds it
whole in the listing. The 9 new or changed tests fail on 1.20.2's sources.
1,095 tests passed and 5 were skipped (linters not installed there) on Windows 11 on Arm,
run there because the development host was loaded. The package smoke passed.

Live on a Windows development host: 1.20.2's listing failed there with `Bad control character
in string literal in JSON`, and the new one listed every process. Inside `npx --yes
--package <archive>`, the repository's own `npx --no-install rove-sentinel --version` failed
with `npx canceled due to missing packages and no YES option` in the inherited environment
and printed the version without its `npm_` variables. The packed 1.20.3 archive, run as the
bootstrap runs it, gave a dry run of `repair` in a consumer project that listed its
processes and read the engine the project selects.

Not run live: a repair that activates an update from the bootstrap line (it needs the
published 1.20.3 release, which the line downloads).

## 1.20.2 `repair` and the pauses it cannot attribute — 2026-11-22

Deterministic tests cover: an unreadable pause record answered with the conditional `resume`
line and never a plain `Run:` one, and kept; the corrupt-record error of a push or the
watcher ending with the repair command, never `resume`; pauses with no kind, as engines
before 1.20.1 wrote every pause, never lifted, whether their reason only opens like the
updater's or a safety pause's or is one of those engines' sentences in full; a kindless
safety sentence still checked for leftover processes, which are listed and stopped with
`--stop-orphans`, after which the pause stays with the conditional `resume` line, and a dry
run that says so; a kindless updater's reason left alone while an activation runs and
kept, with the conditional line, once none does; the rollback of an interrupted activation
removing no pause, a person's or a kindless one included, and the pause step then lifting
one recorded as the update's; the bootstrap downloading 1.20.2 or later, its checksum test
following the version it names. The 9 changed or new tests fail on 1.20.1's sources.
1,088 tests passed and 5 were skipped (linters not installed there) on Windows 11 on Arm,
run there because the development host was loaded; on the loaded host the same suite timed
out in 12 tests unrelated to this change. The package smoke passed.

Not run live: no pause left by an engine before 1.20.1 was reproduced outside the tests,
and the bootstrap line cannot download 1.20.2 until that release is published.

## 1.20.1 updates that cannot proceed say so, and `repair` fixes them — 2026-11-19

Deterministic tests cover a full engine store removing copies kept only for a rollback,
oldest by version rather than by name, before refusing a new release, and none when the
download fails or the verified runtime cannot be put in place; active, pending and running
versions never removed, and the refusal naming them; a project record whose checkout is gone
keeping only its active version; reservations written and taken back only while the store's
lock is held, and a store left over its cap trimmed on the next install.

Store locks: a live owner's lock waited for, with an error ending in the repair command; a
dead owner's lock and its staging removed and logged; a lock never given an owner removed
only after ten minutes; a reused PID told from the owner by its start time, and an earlier
engine's lock judged by its PID alone; a lock another start put in place after the verdict
never removed; a dead remover's takeover marker cleared and a live one respected.

Holds and lines: `updates` listing a safety pause, a stopped watcher, a live watcher of
another engine or policy, a dead submitter's queue lock, an interrupted activation's pause
and fence (a reused PID included, where the system reports start times) and every
unreadable record, without lifting anything; every such line ending with
`Run: npx --no-install rove-sentinel repair`, once; no hold for a running watcher or a live
activation's own pause; the long-pause, failed-download and disabled-updates lines.

`repair`: review directories read from quoted, spaced and `--flag=` command lines; a
process counted as this repository's only when its review directory's owner names this
repository and runs no review, or it descends from the provider a safety pause recorded and
started before it, never one of another repository, and one naming a directory without an
owner record listed but never counted or stopped; children stopped first, only while a PID
keeps its listed start time, and counted only when `taskkill` succeeds (on macOS and Linux, when the signal is sent); a pause is lifted only after a fresh listing finds none left; a safety pause (and one from an earlier engine) resumed
when no such process remains, kept with the processes listed and `--stop-orphans` named
while they do, and resumed after that command stops them; a person's pause never lifted, even one whose reason
reads like Sentinel's; one repair at a time per repository; an
update's leftover pause lifted; a watcher whose lock owner is dead or a reused PID
recovered and started; a hung watcher stopped only with `--stop-orphans`; a watcher that
cannot start named with its command, and a repository without a watcher left alone; a
watcher of another engine restarted only while no review runs; a dead submitter's queue
lock, a stale store lock, an old takeover marker and an unreadable watcher lock handled; an
interrupted activation rolled back, and only its fence removed when the journal beside it is
an earlier update's; a running one waited for; unreadable update settings and the running
processes that fill a store named; a waiting or failed update
retried and a full store's holders named; a dry run changing nothing. `recover` and
`resume` start the watcher, through the installed scheduled task or by naming install, and
a failing scheduler is reported rather than thrown.
The launcher runs `repair` on the newest engine at hand and never one older than the
active one; a repair on a newer engine judges the watcher against the selected engine and
updates through the repository's command; a full store gives one slot; the bootstrap line,
run through PowerShell and pointed at a local server with its npx run replaced by a marker,
refuses an archive whose SHA-256 does not match or is not listed and reaches the marker for one
that does, passes `--stop-orphans` and `--json` on after `--` (as it does `--dry-run`, not tested) and
refuses `--force`; a repair on a newer engine than the selected one prints the Next lines that
run repair as that line with options (by hand, the same line served a packed 1.20.1 archive and ran its launcher through
npx; it was not run on macOS); and the runbook carries the line
exactly. The 61 new tests fail on 1.20.0. 1,090 tests passed on Windows, and the package smoke passed.

Not run live: the fix was not installed on a host with consumer projects, and no full store,
paused watcher or orphaned provider was reproduced outside the tests. `repair` ran once in
dry-run mode against a real installation, where it reported a watcher of another engine
running from another checkout. The failures it addresses were read from one host's state.

## 1.20.0 GPT-6.2 Sol by default — 2026-11-18

Deterministic tests cover GPT-6.2 Sol as every Codex role's default; Codex 0.159.0 and
0.169.9 refused for it, naming 0.170.0, and 0.170.0 and later accepted; a project pinning
GPT-6.1 Sol keeping its 0.159.0 floor, and a role that names GPT-6.2 Sol under such a pin
needing 0.170.0; `none` and `minimal` refused for GPT-6.2 Sol, `low` to `max` accepted; and
the client floor in `limits`. 1,029 tests passed on Windows, and the package smoke passed.

Live on Windows Server 2025 with the maintainer's ChatGPT login: Codex CLI 0.159.0 rejected
`gpt-6.2-sol` (`model_not_found`, "not supported when using Codex with a ChatGPT account");
Codex CLI 0.170.0 accepted it, and its model catalog lists `low`, `medium`, `high`, `xhigh`,
`max` and `ultra` for it, as for GPT-6.1 Sol. `doctor --test-models` with a Codex-only
configuration, run from this branch's source, passed GPT-6.2 Sol at `high` and `xhigh` on
0.170.0. Not tested: Codex 0.160 to 0.169, and a full review under the new default, which
runs once this engine is installed.

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
1,024 tests passed on Windows. The package smoke installs the archive outside a
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
