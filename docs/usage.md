# Use Rove Sentinel

[Installation](installation.md) · [Configuration](configuration.md)

## Your first review

After installation, create a branch, make a small change, run your project's
tests, and commit it. Sentinel reviews committed history; unstaged and staged
changes that are not committed are not the review target.

```powershell
git fetch origin
git switch -c feature/example
# Make your change and run your project's tests.
git add path/to/changed-file
git commit -m "Describe the change"
npx --no-install rove-sentinel gate --base origin/main --head HEAD --author human
```

Use `--author codex` or `--author claude` when that agent implemented the change.
Without an explicit author, Sentinel infers it from supported branch prefixes
and otherwise treats it as human-authored. Both providers remain required, but
the selected risk and author determine which provider performs each stage.

The result identifies the exact base and head, the policy, and a retained report.
A successful process exits with code 0; a failed or unsuccessful review exits
nonzero. Fix verified findings, commit the repairs, and run the same command
again. Compatible ancestor reviews support focused follow-up review.

## Review before pushing

```powershell
npx --no-install rove-sentinel gate --base origin/main --head HEAD --detach
git push -u origin HEAD
```

The detached command returns immediately with a PID and a log path under
`output/`. **That return is not a PASS.** Read the log and its final
`[review-gate] exit 0` marker before pushing. The pre-push hook checks the exact
ref, base, policy digest, and versions; a changed commit needs a compatible
attestation. Missing evidence queues a review and waits within a bounded timeout.
Commit the repair, not just the working file.

Ordinary prose-only diffs receive a documented skip attestation without model
calls. Changes to review policy or agent instructions still require review.

## Understand and resolve findings

P0 and P1 findings always block. Verified P2 findings normally block. Bounded
follow-up rules can make eligible P2 findings advisory. P3 findings are advisory,
but verified advisories still need a fix or an explicit recorded deferral before
pushing. Never interpret "advisory" as permission to forget a finding.

When the report offers a deferral, copy its generated command. It includes the
report ID, finding identity, and target commit. Supply a concrete reason; P0/P1
cannot be deferred. A typical command has this shape:

```powershell
npx --no-install rove-sentinel defer --report REPORT_ID --finding FINDING_ID --reason "Explain the accepted limitation and follow-up"
```

Use the actual IDs and any base/head arguments printed by your report. A changed
head or incompatible report must be reviewed again; a deferral cannot manufacture
a review of a different commit.

## GitHub pull requests

The installed watcher polls ready, non-draft PRs on github.com. By default it
reviews only same-repository PRs authored by the repository owner. Configure an
explicit `trustedAuthors` list for a team or organization. Fork PRs and PRs with
missing provenance are excluded. Review external contributions deliberately in
a suitable isolated environment; see [security boundaries](security.md).

For eligible PRs it publishes an exact-head status comment using your `gh`
account. It does not merge PRs or create a GitHub required status check. The
machine, watcher, network, and the selected authenticated CLI(s) must remain available.

## Useful commands

| Command | Purpose |
| --- | --- |
| `doctor` | Check installed tools and authentication |
| `status` | Inspect policy versions, watcher health, state paths and timing |
| `update-check` | Check for a newer stable release without installing it |
| `updates` | Inspect automatic engine activation; `--enable` or `--disable` controls it |
| `update` | Retry the automatic updater now; normally no manual command is needed |
| `gate --dry-run --base origin/main --head HEAD` | Inspect routing without model review |
| `gate --json --base origin/main --head HEAD` | Emit a structured result |
| `watch --once --no-github` | Process the local queue without PR discovery |
| `pause --reason "Maintenance"` | Pause new review work |
| `resume` | Resume ordinary paused work |
| `recover --reason "Investigated the stale watcher state"` | Recover stale locks and claims; refuses a healthy watcher and does not clear a pause |
| `ledger --pr 123` | Draft an optional comparison ledger from external review comments |
| `help` | List commands and flags |

The `ledger` command does not invoke CodeRabbit or Greptile. The `design-evidence`
command validates the optional Rove compatibility format; it does not capture
screenshots or assess visual quality.
