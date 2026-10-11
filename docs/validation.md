# Standalone validation record

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
