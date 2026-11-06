# Changelog

## Unreleased

- **Review accounts: several logins of one CLI.** A user with several Claude Code
  (`CLAUDE_CONFIG_DIR`) or Codex (`CODEX_HOME`) accounts declares them, each with a label,
  in a per-user accounts file (`--accounts`, `ROVE_SENTINEL_ACCOUNTS`, or `accounts.json`
  beside the state folders), never in the repository or the policy digest. Within a
  provider, a review never uses the author's own account (the `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` of the shell that asked for it, carried to the watcher as a digest) while
  another is usable, prefers an account with no hold, and rotates by last use; neither CLI
  documents a way to read the allowance left. Holds are kept per account: an account that
  fails or reports its usage limit is held, and the review restarts from scratch with the
  provider's next account, under any requirement, before the provider is dropped under
  `auto`. When no other account is usable the author's own is used, and the evidence says
  so. Reports, attestations, comments and text results carry `accounts` and
  `accountFallbacks` by label; `status` and `doctor` list each account's sign-in and hold,
  and `install` checks them too and gives the scheduled watcher a named accounts file. A
  credential variable that overrides an account folder (`CLAUDE_CODE_OAUTH_TOKEN`,
  `CODEX_ACCESS_TOKEN`, …) refuses such a review. Every restart, an account's or the
  provider fallback's, reviews the commits the first round resolved, even if `HEAD` moved.
  With no accounts file, reviews are unchanged. See the
  [plan](docs/plans/review-accounts.md).

## 1.17.0 — a review that goes on when a provider cannot

Under `auto`, a provider that fails, or that has used up its subscription's allowance, no
longer blocks every push until it recovers: the review restarts once, explicitly and on the
record, with the other provider. Explicit `both`, `claude` and `codex` requirements are
unchanged. Nothing needs doing by hand.

- **Under `auto`, a review falls back to the other provider when one fails.** A round
  that fails because a provider's work failed after its one retry (a shard or lens
  reviewer, or the adjudicator; an error, a timeout, malformed output or a review still
  incomplete), for Claude and Codex alike, restarts once from scratch without that
  provider, the way a usage limit does (below). The provider is held out of `auto` reviews
  for an hour, or until it completes work, under `providerHolds` in `status` and `doctor`
  (a usage limit is a hold too, with `reason: "usage-limit"`).
  `providerFallback.reason` is `"provider-failure"`. A process-tree cleanup failure, the
  launch fence, a failed deterministic lane and an error that is not a provider's never
  fall back; a tolerated scout or hypothesis failure stays tolerated; `both`, `claude` and
  `codex` never fall back.
- **A provider out of its usage allowance no longer blocks every push under `auto`.**
  Sentinel checked only a CLI's version and sign-in, so a provider that had used up its
  subscription's allowance was still selected, and every review failed closed until it
  reset, days later. A provider run that fails with its usage limit now raises a typed
  error, read from the CLI's own error output only, never from a completed review. The
  limit, its reset time and the message are recorded in the state folder (an hour when no
  reset can be read, at most eight days). Under `auto`, a provider with a live record is
  left out of new reviews, and a review that meets a limit fails its round closed,
  discards its evidence and checkpoint, and restarts once, from scratch, with the other
  provider. The progress output, the report, the attestation and the GitHub comment record
  `providerFallback` beside the `single-provider` label. A second limit fails closed, and
  `both`, `claude` and `codex` never fall back: they fail naming the provider and its retry
  time. `status` and `doctor` show the records; `gate --force` tries every provider again.
  A fallback PASS is an ordinary `auto` single-provider PASS; the policy digest is
  unchanged. The provider wordings matched were not yet seen from a live CLI out of its
  allowance; see the [plan](docs/plans/provider-usage-limit-fallback.md).

## 1.16.1 — a watcher that comes back, and says when it cannot

A watcher could stop for good after a restart, fail to install without an administrator, or
go on failing while it looked healthy. It now replaces a dead lock after a restart, installs
from a limited token, finds what the installing shell found, and reports failing polls.

**Two cases need one step by hand.** A macOS watcher installed by an earlier engine has no
`PATH`, and macOS has no automatic updates, so run `install` once from a shell that finds
`gh`. A Windows task registered from an elevated shell stays an administrator's: where the
watcher runs limited, delete it once as an administrator and run `install` from the limited
shell. `watcherHealthy` is now false for a watcher whose polls keep failing, so a consumer that
reads `status` for a live process should read `watcherRunning`.

- **A macOS watcher finds what the installing shell found.** launchd gives an agent only the
  system's folders, so a watcher in GitHub mode failed every poll with
  `Could not start gh: spawn gh ENOENT`. The LaunchAgent now carries the shell's `PATH`, without
  the checkout or any `node_modules`, however they are spelled or linked, adds those of launchd's
  own folders it lacks, and says where the tools keep their settings. **A watcher installed by an earlier engine
  has no `PATH`: run `install` once from a shell that finds `gh`,** and again after moving a tool.
- **A watcher that never reviews no longer looks healthy.** It goes on after a failed GitHub
  poll with a fresh heartbeat, and only an event recorded the failure. Two failed polls in a
  row now make `watcher.state` `failing` in `status` and `doctor`, with the reason, since when and
  what to do, and `watcherHealthy` false, until a poll succeeds or `install` runs. A new
  `watcherRunning` keeps the old meaning, a live and compatible watcher: an automatic update reads
  it, because a new engine may be the fix.
- **The Windows watcher needs no administrator.** Its logon task now names its own user.
  `schtasks /SC ONLOGON` means any user's logon, so `install` failed with `Access is denied`
  from an administrator's limited token, and an automatic update, which installs from the
  watcher's limited token, could not replace the task. **A task registered from an elevated
  shell, by this engine or an earlier one, stays an administrator's,** and a limited shell
  may neither replace nor delete it. Where the watcher runs limited, delete that task once
  as an administrator and run `install` from the limited shell, or automatic updates keep
  failing as they did. The limited shell is told how.
- **A scheduled watcher finds what the installing shell found.** A task starts with the
  stored environment, so a watcher whose Git or provider CLI is on `PATH` only through a
  profile or an activation script stopped at once. `watch.cmd` now uses the shell's `PATH`,
  without the checkout or any `node_modules`, in place of the stored one, and where the tools keep their
  settings (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`,
  `CLAUDE_CODE_GIT_BASH_PATH`). Run `install` again after moving a tool.
- **A watcher that stops at once says why.** One that could not start Git had nowhere to
  write the reason, and `install` reported only a missing heartbeat. Its wrapper now keeps
  what it printed in `watcher-start.log`, which `install` and `status` quote.
- **A laptop keeps its watcher.** The task no longer refuses to start on battery or stops
  when the power goes, and has no time limit.
- **A running review keeps its checkout.** Cleaning up stale review checkouts read `EPERM`
  as a dead process, so the checkout of a review run by another user or elevation could be
  removed.
- **A torn result no longer stops recovery.** A power cut can tear a result file, and a claim
  beside it made every start and every `recover` fail. The request now returns to the queue
  and is reviewed again, and a broken file is never read as a verdict.
- **A restart no longer stops a watcher.** A restart left the lock of a dead process, and every
  later start refused until someone ran `recover` and `install`. A starter now replaces a lock
  only when the machine booted after that lock's last heartbeat and its process is gone
  (`ESRCH`). Anything else keeps the refusal: a logoff, a crash or a kill in the same boot
  unless the clock later moved past that heartbeat, a torn heartbeat, a reused process id, or a
  boot time that cannot be read. By its documentation, a Windows shut down with Fast Startup
  does not count as a boot; that has not been measured. A new
  `takeover.lock` lets one process at a time replace or remove a lock it did not write, and
  `stop` and `recover` honour it. If its holder dies, a later takeover refuses until a person deletes that
  file. A clean restart on Windows has run through this. A power cut, Fast Startup, macOS and
  Linux have not.

## 1.16.0 — any project's paths, and a watcher you can see

The review knew the folders of the project it came from, and a watcher could stop
without anyone being told. Sentinel now reads what a project needs from configuration
any project can set, and says when its watcher is not running.

**This release changes how changes are rated for a project that sets nothing.** An
automatic update applies it by itself, so a project that relied on the old built-in paths
should run `updates --disable` before its watcher activates this release, and then follow
[adopting a new setting](docs/configuration.md#adopting-a-new-setting).

- **A stop no longer takes a live watcher for dead.** `EPERM` means a process exists and may
  not be signalled, such as a watcher of another user or elevation. It read as gone, so a stop
  could remove its lock and heartbeat, and `recover` could overrule a healthy one. A process
  id reused by such a process now refuses a stop too. `recover` stays a person's decision: it
  still clears an owner with a stale heartbeat, because a reused id looks the same.
- **A stopped watcher shows.** A scheduler's task can report success while its watcher
  refused to start, for example after a restart left a dead process's lock. `status` and
  `doctor` now report `watcher.state` and why it is stopped, and warn on stderr. `doctor`
  warns before any other check can fail, and reports a scheduler it cannot read apart.
- **An engine installs without your npm configuration.** `npm_config_*` settings, which
  npm 12 can refuse in project-scoped installs, and the user and global `.npmrc` no longer
  reach the install, which uses the public registry. `--ignore-scripts` and the checksum
  stay. A proxy set in `.npmrc` must move to `HTTPS_PROXY`,
  and the release download needs `NODE_USE_ENV_PROXY=1` beside it, on Node 22.21 or later.
  The upgrade to this release still runs the previous engine's install; see
  [troubleshooting](docs/troubleshooting.md) if it fails with `EALLOWSCRIPTS`.
- **Clippy finds your crates.** The lane runs for each crate that holds a changed
  Rust file, found by its `Cargo.toml` or listed in the new `clippyCrates`, no longer
  for one folder name only. Messages from a crate in a workspace now land on the
  right file. A repository that used the lane keeps its result for the same crate,
  and a change to Rust elsewhere is now linted too.
- **`guiEvidence: "required"`** names what the mode does. `rove`, its earlier
  spelling, keeps working, and an installed policy keeps its digest.
- **The review knows no project's folders.** `src-tauri/`, `sidecar/` and three
  documents are no longer high risk by name, and their scripts folders no longer get the
  scripts lens: a project lists its own in the new `highRiskPaths` and `scriptPaths`.
  Any agent skill and any `*.config.*` or `*.conf.*` file but prose is now high risk.
  **A project that relied on those names must list them to keep its review depth,** in the
  same change that moves its pin to this release: an older pin refuses the keys.
- **`guiEvidenceLayout`** sets the GUI evidence check's folders and patterns.
  `required` alone now recognizes GUI files by type and checks no controls; `rove`
  keeps its layout.

## 1.15.0 — several computers on one repository, and macOS

A watcher reviews every eligible pull request it finds, so two computers on one
repository reviewed each one twice and paid twice.

- **`install --no-github`.** A second computer keeps its hook, its local queue
  and its attestations, and its watcher leaves pull requests alone. An engine
  update keeps the choice, and an install killed midway leaves it as it was.
- **macOS, on Apple silicon.** The suite, the LaunchAgent, the watcher, a full
  review with Claude Code and Codex, and a push through the hook all ran on a
  real project ([validation record](docs/validation.md)).

## 1.14.0 — a large change gets more reviewers, not thinner ones

A round had at most 8 shard reviewers whatever the size of the change, so on
a 4 MiB change each reviewer was given about 500 KB to cover, and reviewers
of big shards finished almost as fast as small ones (2 minutes at 400 changed
lines, 5 at 7,000 on a consumer project): they skimmed. The 4 MiB bound then refused
anything larger.

- **More shards past one wave.** Up to about 830 KB of patch a high-risk
  round keeps its 8 shards. A larger change gets one more shard per 104 KB, up
  to the project's `maxShards` (16 by default; 8 keeps the old behavior, at
  most 128). Reviewers still run 8 at a time, so 16 shards take a second wave.
  Past the cap shards grow, and the report and progress say they were
  reviewed more thinly.
- **Measured on a real 3.6 MB change** (a consumer project's large change, full
  high-risk round, both providers, one run each): 1.13.0 with 8 shards took
  7.6 minutes and verified 7 P2 and 2 P3 findings; 1.14.0 with 16 shards took
  8.4 minutes and verified 16 P2 and 7 P3.
- **The review patch may be 8 MiB** (4 MiB before).
- A round of more than 12 shards may adjudicate four candidates per shard, at
  most 200.
- A shard of up to 128 KB travels in the reviewer's prompt (96 KB before).

## 1.13.0 — fewer unreviewed changes, more context per reviewer, faster reviews

A critical review of the engine against what external reviewers keep catching
found a skip that let build inputs through unreviewed, reviewers that never saw
a module and its test together, a reference map that was empty for most
languages, and twelve to fifteen seconds of serial Git work before any
reviewer started.

- **Plain-text files and MDX are reviewed.** The documentation skip took every
  `.txt` and `.mdx` file for prose, so a change to `CMakeLists.txt`,
  `requirements.txt` or an MDX page (which carries JSX) was pushed with a skip
  attestation and no model call. Only Markdown, reStructuredText and AsciiDoc
  are prose now. Their reviewer applies the documentation lens, except to
  `CMakeLists.txt` and dependency `.txt` manifests, which get the
  configuration lens.
- **CI workflows and database migrations are high risk.**
  `.github/workflows/`, `.gitlab-ci.yml` and `migrations/` directories join
  the high-risk paths: they run with repository secrets or change persisted
  data.
- **A test shares its code file's shard.** Shards were filled by file kind,
  so a module and its test went to different reviewers and nobody checked the
  test against the changed branch. A test is now placed right after the
  changed file of the same name it tests (`a.test.ts`, `test_a.py`,
  `a_test.go`, `ATest.java`; the closest directory wins) when the shard bounds
  allow, and the reviewer applies the lens of every kind of file its shard
  holds.
- **The reference map covers more languages.** Declarations are extracted from
  Python, Ruby, PHP, Java, Kotlin, Scala, C#, Swift and C/C++ as well as
  JavaScript/TypeScript, Svelte, Rust and Go, including return-typed C, C++,
  Java and C# functions without a modifier, and C/C++ definitions whose return
  type has a line of its own at column 0 (GNU and BSD styles; an indented line
  is never read as one). The lexer drops `#` comments and
  multi-line triple-quoted strings (honouring escapes where the language does)
  where those languages have them. It is still a line lexer, not a parser.
- **Reviewers see the change's stated intent.** The review context quotes the
  messages of the commits between base and head (newest first, at most 4 KB).
  The history export carried subjects only, mixed with unrelated repository
  history, although the incomplete-claimed-fix rule reads intent from them.
  The messages are untrusted evidence, never instructions.
- **Held-back candidates are kept.** A candidate under the confidence floor
  still does not reach adjudication, but the report now keeps up to 40 of them,
  and `ledger` labels an external finding in such a file `below-floor`. A miss
  can be told apart as "seen and held back" or "never seen".
- **The reference map is ready sooner.** It reads changed blobs with two
  `git cat-file --batch` processes instead of one per blob, sweeps symbols and
  co-change history with up to eight Git processes at once, and is built from
  the repository's objects while the review checkout is created. On this
  repository's 1.11.1–1.12.0 range (28 files) it took 0.9 s instead of 6.4–7.7
  s and produced a byte-identical map. Budgets are still applied in symbol
  order, so the map does not depend on which sweep finished first.
- Prompts and the review context no longer assume Rove's UI: the async lens
  names generic interleavings, and the scout spends its interleaving slot only
  when the diff creates a pending window.
- **Linters run beside the model review, as CodeRabbit's do.** shellcheck,
  actionlint, gitleaks and ruff run on the changed files whenever they are
  installed, with no model call, and report hits on added lines: an
  error-level hit (a shellcheck error, a workflow error, a probable secret
  outside test paths, a Python syntax error or undefined name) blocks as P2, a
  warning is a P3 advisory. gitleaks scans a copy of the changed files so the
  branch's own configuration cannot switch it off, and never records the
  secret. Projects can add their own checkers (`tsc`, `eslint`, any tool with
  `path:line:col` or tsc output) as `lintCommands` in installed policy, with
  the trusted checkout's `node_modules` linked in; `lintLanes` turns a
  built-in lane off, and `doctor` lists which tools the host has. A missing
  tool is a note in the report, never a pass. The first `gate` run on a
  machine that lacks some of them says which and how to get them, and
  `rove-sentinel tools --install` installs them with winget or Homebrew after
  asking (`--yes` for an agent).
- **The review material travels in the prompt.** Every reviewer used to spend
  its first turns reading the context, the charter, the lessons, the briefs
  and its shard, one call each, and a long tool output could come back with
  its middle elided. The context and its required reads are now in every
  prompt when together they fit 96 KB, and a shard's hunks (or an
  adjudication batch's candidates) when they fit 96 KB, between markers
  carrying a per-review nonce. Prompts reach Claude Code and Codex on standard
  input. Larger material is read from files in parts, as before.
- **Adjudication starts while reviewers run.** A batch of five candidates goes
  to a fresh adjudicator as soon as completed reviews supply it; the rest goes
  in batches of at most three when the last reviewer settles. The floor, the
  identity merge and the 50-candidate bound are unchanged; a candidate already
  sent is not replaced by a later duplicate. A shard whose reviewer reports an
  incomplete review is handed over part by part at once, not after the wave.
- **A large file no longer has to be split for a follow-up round.** The file
  of each prior blocker assigned to a follow-up reviewer was a required read,
  whole: a file over one tool output (~38 KB for Codex) came back truncated
  and failed every follow-up round closed until the file was split. The
  reviewer now reads the code that settles the blocker, around its location
  and by line range in a large file. Any other truncated read is not
  incompleteness, and an adjudicator is told it is assigned candidates, not a
  diff. With shard parts (1.12.0) and inlined material, a changed file over
  ~40 KB or a line over ~2 KB is no longer a reason to split a change.
- **`rove-sentinel limits` says what this engine accepts.** Consuming projects
  kept Sentinel workarounds in their notes long after an engine made them
  unnecessary (splitting every file over 40 KB, for one). The command prints
  the active engine's limits, generated from the values it enforces, and the
  workarounds earlier versions needed that it does not (`--json` for
  agents). The new [limits guide](docs/limits.md) is updated by every release;
  a test ties its version line and its list of retired workarounds to the
  engine.
- **Model and effort per role.** A provider's `roles` can give the scout,
  hypotheses, shards, the lens reviewer or the adjudicator their own model,
  effort or ceiling. The defaults set no roles, so nothing changes unless a
  project opts in; `doctor --test-models` probes every combination a role can
  request.

Shards, prompts and the policy digest change with the version, so existing
attestations and kept shard reviews do not carry over.

## 1.12.0 — a diff that touches a file of very long lines can be reviewed

A branch that edited six lines of a file of 300-character lines failed closed
on three runs in a row (a consumer project, 2026-10-10): 80 context lines either side of
each edit made that file's section well over 100 KB, Codex read the shard's
parts in one command, the tool showed that output with its middle elided, and
the reviewer rightly reported "the combined tool response was truncated". The
retry repeated the same instruction.

- The shard prompt and the review context say that each part is read with a
  tool call of its own, never two files in one command, and why. Codex on
  Windows is told the same for `Get-Content`. This is an instruction; the next
  point is the mechanism.
- A shard of several parts whose reviewer reports its review incomplete is not
  given the same instruction again. Its one retry hands the shard over **one
  part per reviewer**: each is a fresh reviewer given a single file, so it
  cannot lose a part by reading several together. Every part must complete for
  the shard to count, and a part reviewer is not retried, so no hunk gets more
  than the two attempts the charter allows. The parts' candidates are merged
  under the shard's role and the report marks the shard `part-by-part`. Any
  other failure, and an incomplete shard of one part, gets the ordinary retry.
  A part reviewer sees one part of the shard, not the shard's other files.
- Review-patch context is bounded by bytes as well as lines: up to 80 lines
  either side of a change, but no more than 4 KB of them, and never fewer than
  3. Code averaging up to about 50 bytes a line keeps all 80; a file of
  300-character lines keeps 13. Hunks whose context no longer meets are split
  and renumbered, so the patch still applies and every added and removed line
  is kept; a hunk whose start moved loses Git's function heading. There is no
  cap on a file's whole section: a file with many separate edits still grows
  with them.
- A single line longer than one part (24 KB) is cut between characters across
  parts that say so. It used to keep a part of its own, which could be larger
  than any read.
- A rerun after a fail-closed round is cheap: the shard reviews that completed
  are kept for the exact repository, base, head, policy and versions for 24
  hours, and the rerun reviews only the shards that did not complete. A kept
  review is reused only for the same assignment (hunks, provider, round, prior
  blockers) and is validated like a fresh answer. Candidates are adjudicated
  afresh, the scout runs again, `--force` keeps nothing, and the report marks
  each reused shard with when it was reviewed and by which model passes. Kept
  reviews are removed when the round ends in a report, and when the candidate
  set exceeds its bound (reusing them would fail every rerun the same way).
  The 24 hours are each review's own: a failed rerun does not renew them.
- The fail-closed message says what a rerun costs and what to do when the same
  shard fails again, names each failed shard's size, largest file and number
  of consecutive failed runs, and describes each failure once.

Fail-closed is unchanged: a reviewer that could not read its assignment whole
still never counts, whichever way the parts were handed over.

## 1.11.2 — required reads that fit, and a precise completeness contract

Codex reviewers on large branches still reported reviews incomplete after
1.11.1, and the reasons they gave (now kept in the error, see below) were
specific: "context output was truncated", "verification reads failed within
the eight-call budget", "PowerShell restricted method invocation and rg was
unavailable".

- The review context is small at any size: the changed-file lists move to a
  `changed-files.md` lookup. It now separates **required reads** (charter,
  selected lessons, open briefs — each written in parts of at most 24 KB that
  each fit one read) from **lookups** (the reference map, the file lists, the
  Git history, the full patch), which reviewers search instead of reading
  whole. A 560 KB reference map was a "required" read before.
- The completeness contract says what incomplete means: a required read (the
  assigned diff, a required context file, or in a follow-up round the file of
  an assigned prior blocker) that was blocked, failed or came back truncated,
  or no tool host. Running out of the verification budget, or a verification
  command that fails, does not make a review incomplete. Every pass gets the
  same contract, the ceiling pass included, and call budgets count only the
  calls after the required reads.
- A follow-up reviewer omits an assigned prior blocker only when it verified
  the fix. One it could not settle (a failed command, a spent budget) is
  reported again, because the gate reads an omitted blocker as fixed. The
  gate sends a re-reported blocker to adjudication whatever confidence or
  priority its reviewer gave it: the 50 floor dropped it, and on a follow-up
  a P3 label skipped adjudication and left it a non-blocking advisory. This
  is an instruction, not a mechanical check: a reviewer that omits a blocker
  it never examined still reads as fixed.
- The scout owns no part of the patch: shard reviewers cover every hunk. It
  reads a patch of at most 24 KB whole and otherwise picks files through a new
  patch index in `changed-files.md` (each file's line range in the patch),
  reading at most 400 lines per call; a range it chose that comes back
  truncated never makes it incomplete.
  An 8-call scout told to read a 590 KB patch reported "truncated required
  reads and partial patch coverage" on every large branch. The context also
  states the patch's size.
- A line longer than one read is cut between characters, so no required-read
  part exceeds 24 KB.
- Codex on Windows is told its sandbox shell: PowerShell, possibly in
  constrained language mode, possibly without rg — read with `Get-Content`,
  search with `Select-String` or `git grep -n`, no .NET method calls.
- An incomplete-review error keeps the reviewer's own account (bounded, one
  line), so the failure can be diagnosed from the report.

## 1.11.1 — every shard fully readable

- A shard larger than one read is written in parts of at most 24 KB, each
  read whole, and the prompt names every part. Codex shows at most ~10k tokens
  of one command's output and elides the middle of a larger one: a ~70 KB
  shard "read once" was never fully seen, and since 1.11.0 Codex honestly
  declared `review_complete: false` on such shards, failing large branches
  closed (rove #584 three rounds, #573 five).
- A shard reviewer's time limit grows with its shard: 5 minutes for one part,
  one more minute per further 12 KB, up to 12 minutes. Reading every part of a
  ~70 KB shard took Codex past the old fixed 5 minutes.
- On Windows, `taskkill` gets 30 seconds (was the 2-second exit grace) to end a
  timed-out provider tree before the cleanup fence gives up. Under load a
  timed-out Codex scout outlasted 2 seconds and the fence closed the gate over
  a lane whose failure is otherwise not fatal.
- A changed file with no textual hunk (binary content, a rename or copy
  without a content change, a mode change, an empty file created or deleted)
  no longer fills a review shard. Since 1.11.0 a reviewer must declare
  `review_complete`, and a shard owning ~25 unreadable binaries was reported
  incomplete on almost every run, so branches that move or add assets failed
  closed without findings.
- Such files stay in the full patch and are listed, with their reason and old
  path, in the review context every reviewer reads, so references to a moved or
  deleted path are still checked. Reports record them as `metadataOnlyFiles`.
  Shard coverage of every textual hunk is unchanged.
- A follow-up round whose repair only renames a prior blocker's file gives that
  blocker its re-verification shard, built from the branch's text of the new
  path, instead of treating the rename as covered.

## 1.11.0 — configurable current models and one subscription

- Default all Codex roles to GPT-6.1 Sol and all Claude roles to Opus 5.5, both
  at high effort with bounded model-requested escalation to xhigh.
- Support Claude-only, Codex-only, automatic, or explicitly required dual-provider
  operation while preserving role counts, coverage and fresh adjudication.
- Freeze custom models, initial effort and effort ceilings in installed project
  policy. Expose profiles, provider selection and actual passes in evidence.
- Add explicit model-access probes and early client compatibility diagnostics.
- Refuse incomplete provider reviews rather than accepting empty findings after
  blocked reads or an unavailable tool host.

## 1.10.0 — automatic engine updates

- Add bounded, cached `update-check` and advisory notices in status/doctor, with
  explicit opt-out and nonblocking offline behavior.
- Add a pinned launcher and shared immutable runtime store. Windows watchers
  install stable releases automatically, verify SHA-256 and engine compatibility,
  wait for idle reviews, verify activation and restore the prior engine on failure.
- Preserve installed project policy and consumer lockfiles. Different repositories
  activate independently while sharing verified runtime files.
- Add native and CLI update notices, per-repository opt-out, retained recovery
  records, and documentation for multiple agents and projects.

## 1.9.0 — first standalone release

The version continues the original Rove engine's 1.8.x lineage. Earlier
standalone releases do not exist.

- Extract the complete committed-diff review pipeline and regression suite.
- Package a CLI with installation, diagnostics, initialization, review, findings,
  watcher, hook and recovery commands.
- Separate installed project policy from reusable review behavior and bind
  configuration into attestation identity.
- Preserve Claude Code and Codex subscription requirements and bounded review
  stages, follow-up decisions, process cleanup and retained reports.
- Make Rove visual evidence and project Clippy execution opt-in.
- Restrict automatic PR review to allowed authors with same-repository heads.
- Preserve existing hooks during onboarding and uninstall.
- Resolve watcher and charter paths from the installed package.
- Preserve case-sensitive repository identities outside GitHub and normalize
  SCP-style remotes with non-default SSH usernames.
- Add installation, usage, contribution, architecture, trust, comparison and
  limitations documentation, plus reproducible dependency notices.

Windows is the qualified platform, using native provider executables. macOS
and Linux remain unqualified. See [support](docs/support.md) and
[validation](docs/validation.md) for precise limits and evidence.
