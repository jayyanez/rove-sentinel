# Troubleshooting

Start with `rove-sentinel doctor`, then `rove-sentinel status`. Keep the error,
engine version, OS, and exact base/head in a bug report; redact credentials,
private remote URLs, and private source excerpts.

| Symptom | What to check |
| --- | --- |
| A tool cannot launch | Open a fresh terminal; check each CLI's version and PATH |
| Authentication refused | Sign in through both provider CLIs; API-only authentication is insufficient |
| Policy missing or version mismatch | Reinstall from the trusted stable checkout after updating the dependency |
| Another checkout owns the watcher | Operate from that checkout; avoid competing watchers for the same remote |
| Push waits for review | Inspect watcher health, its current activity and the detached review log |
| Process cleanup failure pauses work | Investigate remaining processes, then use `recover` with a reason |
| GUI evidence requested unexpectedly | Inspect the installed `guiEvidence` configuration; generic projects use `none` |
| Clippy timeout | Check the lane note and cold build cost; do not treat it as a passing Rust check |
| No GitHub PR comment | Check draft state, author allowlist, same-repository head, `gh` permissions, and watcher health |
| Hook no longer runs | Inspect `git config --get core.hooksPath` and the committed hook adapter |

On Windows, per-repository records live under
`%LOCALAPPDATA%\Rove\shared-review-gate\<repository-hash>` for migration
compatibility. `status` reports the actual paths. Reports and context may contain
source code; do not upload that directory wholesale to a public issue.

Detached foreground logs are written under the repository's `output/` directory.
Add `output/` to your `.gitignore`. A detached process launch is incomplete until
its log ends with an exit marker. A crashed or interrupted review is not a PASS.

Local hooks can be bypassed by someone controlling their machine. Emergency
bypass variables are retained for compatibility and are audited by exact SHA
and reason; they are not a normal troubleshooting remedy. Use independent GitHub
branch protection for server-side policy. Sentinel does not configure it for you.
