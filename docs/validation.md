# Standalone validation record

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
