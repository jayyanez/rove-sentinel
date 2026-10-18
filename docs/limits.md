# What Sentinel accepts, and where it stops

**Engine version:** 1.13.0

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
follow it. If the engine does not list a limit, the limit does not apply.
When a review still fails, read the report's own account of why
([troubleshooting](troubleshooting.md)) rather than a rule from memory.

## Limits of 1.13.0

| Area | Limit | What happens past it |
| --- | --- | --- |
| Change under review | Git's diff with 80 context lines a side: 4 MiB | The round fails closed; split the change into several pushes |
| A changed file's size, a line's length | None | Shards are written in parts of 24 KB, longer lines cut across parts; a shard of up to 96 KB is in the prompt |
| Context and required reads in the prompt | 96 KB together | They are read from files in parts instead |
| Shards per round | 8 high risk, 4 medium, 2 low, about 500 changed lines each | Shards grow instead; a shard's reviewer gets 5 to 12 minutes by size |
| Candidates per round | 50 after merging duplicates (8 per shard, 4 per hypothesis) | The round fails closed |
| Confidence floor | 50 | Not adjudicated; the report keeps up to 40 |
| Documentation skip | Only `.md`, `.markdown`, `.rst`, `.adoc` outside the review policy | Everything else, `.txt` and `.mdx` included, is reviewed |
| One push | 16 refs to check, 1 still needing review; the hook waits 120 minutes | The push is refused |
| Repair rounds | 6 reviewed heads on one base; 2 blocking late discoveries | Eligible P2 findings become deferrable with a reason; P0/P1 always block |
| Rerun after a fail-closed round | Completed shards kept 24 hours for the exact head | Older ones are reviewed again |
| Reuse after a rebase | Code, script and test shards with identical hunks, 7 days | Reviewed again when anything they name, or that names them, changed |

The exact values are in `scripts/review-gate/constants.mjs`; the
[architecture](architecture.md) explains each stage.

## Workarounds that are no longer needed

| Workaround | Needed before | Why it is no longer needed |
| --- | --- | --- |
| Split a source file over about 40 KB before a review | 1.13.0 | A follow-up reviewer read each prior blocker's whole file; one over a tool output (~38 KB) failed the round closed. It now reads the code around the reported location |
| Keep changed lines under about 2 KB | 1.12.0 | Context is bounded by bytes, and a long line is cut across parts |
| Keep a follow-up delta small for the adjudicator | 1.13.0 | The patch is a lookup, and an adjudicator is assigned candidates, not a diff |
| Avoid shards of about 70 KB | 1.11.1 | Shards are written in parts that each fit one read |
| Expect every hunk reviewed again after a rebase | 1.13.0 | Unchanged shards with unchanged dependencies reuse their review |

## Limits that remain

These are real in 1.13.0; work within them rather than around them.

- The 4 MiB patch bound has no setting. Measure a long branch with
  `git diff --unified=80 $(git merge-base origin/main HEAD)...HEAD | wc -c`
  and split before it approaches the bound.
- AI review can miss defects and report false ones; a PASS is not a
  guarantee. Reference discovery is a line lexer, not a parser.
- Windows is the qualified platform ([support](support.md)).
