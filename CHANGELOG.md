# Changelog

## 1.12.0 — a diff that touches a file of very long lines can be reviewed

A branch that edited six lines of a file of 300-character lines failed closed
on three runs in a row (boxkite, 2026-10-10): 80 context lines either side of
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
  reviews are removed when the round ends in a report.
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
