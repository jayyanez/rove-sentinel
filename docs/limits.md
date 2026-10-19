# What Sentinel accepts, and where it stops

**Engine version:** 1.14.0

Every release updates this page. A limit or a workaround written down under an
earlier version may no longer apply: Sentinel's limits come from the engine
that reviews, and engines update automatically.

## Ask the installed engine

In a project that uses Sentinel, run:

```powershell
npx --no-install rove-sentinel limits
npx --no-install rove-sentinel limits --json
```

It prints the limits of the engine active for that repository, generated
from the values it enforces, and the workarounds earlier versions needed that
this one does not. Engines before 1.13.0 do not have the command.

**For coding agents in consuming projects.** Do not carry a Sentinel limit
or workaround in project notes, agent instructions or memory without the
engine version it was observed with. Before restructuring code for Sentinel
(splitting files, shortening lines, splitting a branch), run `limits` and
follow what it reports; a workaround it lists as no longer needed is not
needed.
When a review still fails, read the report's own account of why
([troubleshooting](troubleshooting.md)) rather than a rule from memory.

## Limits of 1.14.0

| Area | Limit | What happens past it |
| --- | --- | --- |
| Change under review | Git's diff with 80 context lines a side: 8 MiB | The round fails closed on every push, because the diff is measured against the base: split the change into separately reviewed branches, or land part of it first |
| A changed file's size, a line's length | None | Shards are written in parts of 24 KB, longer lines cut across parts; a shard of up to 96 KB is in the prompt |
| Context and required reads in the prompt | 96 KB together | They are read from files in parts instead |
| Shards per round | 8 high risk (4 medium, 2 low) up to about 830 KB of patch; then one more per 104 KB, up to `maxShards` (16 by default, 8 to 128) | Past the cap shards grow and the report says they were reviewed more thinly. 8 reviewers run at a time: 16 shards add a second wave, a few minutes |
| Candidates per round | 50 after merging duplicates (4 per shard past 12 shards, at most 200; 8 per shard, 4 per hypothesis) | The round fails closed |
| Confidence floor | 50 | Not adjudicated; the report keeps up to 40 |
| Linters | shellcheck, actionlint, gitleaks, ruff when installed; project `lintCommands` from installed policy | A missing tool is a note in the report, not a pass |
| Documentation skip | Only `.md`, `.markdown`, `.rst`, `.adoc` outside the review policy | Everything else, `.txt` and `.mdx` included, is reviewed |
| One push | 16 refs to check, 1 still needing review; the hook waits 120 minutes | The push is refused |
| Pre-push input | Git's ref list for one push: 4 MiB | The push is refused |
| Repair rounds | 6 reviewed heads on one base; 2 blocking late discoveries | Eligible P2 findings become deferrable with a reason; P0/P1 always block |
| Rerun after a fail-closed round | Completed shards kept 24 hours for the exact head | Older ones are reviewed again |

The exact values are in `scripts/review-gate/constants.mjs`; the
[architecture](architecture.md) explains each stage.

## Workarounds that are no longer needed

| Workaround | Needed before | Why it is no longer needed |
| --- | --- | --- |
| Split a change whose review patch passes 4 MiB | 1.14.0 | The bound is 8 MiB, and a large change gets more shards instead of larger ones |
| Split a source file over about 40 KB before a review | 1.13.0 | A follow-up reviewer read each prior blocker's whole file; one over a tool output (~38 KB) failed the round closed. It now reads the code around the reported location |
| Keep changed lines under about 2 KB | 1.12.0 | Context is bounded by bytes, and a long line is cut across parts |
| Keep a follow-up delta small for the adjudicator | 1.13.0 | The patch is a lookup, and an adjudicator is assigned candidates, not a diff |
| Avoid shards of about 70 KB | 1.11.1 | Shards are written in parts that each fit one read |

## Limits that remain

These are real in 1.14.0; work within them rather than around them.

- The 8 MiB patch bound has no setting. Measure a long branch before it
  approaches the bound. In PowerShell:

  ```powershell
  git diff --unified=80 --output=review.patch "$(git merge-base origin/main HEAD)...HEAD"
  (Get-Item review.patch).Length
  ```

  In Git Bash:
  `git diff --unified=80 "$(git merge-base origin/main HEAD)...HEAD" | wc -c`.
- AI review can miss defects and report false ones; a PASS is not a
  guarantee. Reference discovery is a line lexer, not a parser.
- Windows is the qualified platform ([support](support.md)).
