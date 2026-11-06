# Provider fallback under `auto`: failures and usage limits

Status: implemented and verified with the deterministic suite; not yet
reviewed, released or exercised against a live CLI that is out of its
allowance or failing. The usage-limit wordings below that were not seen from
a live CLI are marked as assumed.

With `providers: "auto"`, Sentinel selects every subscription-authenticated
provider it finds at the start of a review. Detection checks only the CLI's
version and sign-in, so a provider whose subscription has used up its
allowance still counts as available and is selected. A branch an agent of one
provider wrote routes its cross-model work to the other. When that provider
then refuses with its usage limit, the round fails closed, and so does every
later review, until the allowance resets, which can be days away. The push is
blocked the whole time, although the other provider could have reviewed it.
The same holds the other way round, and for any provider that keeps failing:
a timeout, an outage, malformed output or a review it reports incomplete
fails every round it is given work in.

The first version of this plan fell back only on a usage limit. The owner
then decided that under `auto` a provider that fails, whatever the cause, and
still fails after its existing single technical retry, is dropped and the
review falls back to the other provider, symmetrically for Claude and Codex.
Usage limits keep their faster path: no retry, since the subscription would
refuse again, and the reset time is read.

## Why this keeps the review contract

The contract says a selected provider is never dropped silently after a
model, quota or process failure, a review fails closed, evidence is bound to
the selected provider set, and there is no API billing and no new provider.
The fallback keeps each of these:

- **Explicit, never silent.** The failed round fails closed with its own
  report. The progress output names the provider and why, and the restarted
  review's report, attestation, GitHub comment and text result carry
  `providerFallback` with the dropped provider, the reason and the retry time,
  beside the `single-provider` label.
- **Recorded.** The dropped provider's hold is written to the state folder,
  and `status` and `doctor` show it.
- **`auto` only.** `auto` already means "the subscription-authenticated
  providers available for this review" and already accepts single-provider
  evidence. `both`, `claude` and `codex` never fall back.
- **Once.** The review restarts once, from scratch, discarding every piece of
  evidence of the failed round. A second failure fails closed. No evidence of
  two provider sets is ever combined: the restart's evidence is bound to its
  own selected provider set.
- **Never over a safety stop.** A process-tree cleanup failure, the launch
  fence, a failed deterministic lane, and an error that is not a provider's
  (Git, the gate itself, a local error before the provider was launched) fail
  closed as before, even when a usage limit happened in the same round: only
  the stops that fail a round for its providers alone may fall back.

## Intended behavior

1. **What triggers the restart.** Under `auto`, a round that fails closed
   because provider work failed after its retry was spent: a shard reviewer,
   a lens reviewer when none completed, or the adjudicator, through any error,
   a timeout, malformed output, or a review still incomplete after its retry.
   Each failure is attributed to the provider that ran it, and only a
   failure the runner marked as the provider's counts: one raised by its
   process once launched, or by its output (malformed, incomplete, an
   adjudication batch that does not account for each of its candidates
   exactly once, which is checked inside the batch's retried task). A local
   error before the launch, such as an artifact or a schema that could not be
   written, a process that could not be started, or one a stopping watcher
   ended, is the host's: it fails closed without a fallback or a hold. The
   fallback follows only a spent retry, recorded explicitly. The rule is
   one: a round may fall back only when EVERY failure that fails it is a
   provider's (a usage limit, work a usage limit stopped, or a marked failure
   after its retry). One unmarked failure among them, or any safety stop, and
   the round fails closed without a restart; a usage limit it met is still
   held, but no failure is. The failures weighed are every failed shard,
   every lens reviewer when none completed, and every adjudication batch
   already sent, drained before the round stops (a batch skipped because the
   round had stopped is not a failure). The authority, deny by default, is
   a round veto set at the one place every provider call passes, the guard
   around each seam, retries included: any call of a stage that can fail the
   round (a shard, a lens reviewer, the adjudicator) that throws anything but
   the provider's marked failure or its usage limit, on any attempt, vetoes
   the fallback, however a later attempt or a skip replaced that error. The
   guard's own halt and the skip of a stopped round's batch never call the
   seam, so they neither set nor clear it. A scout or a
   hypothesis reviewer that fails is tolerated as before and triggers
   nothing. A usage limit, in any role, is the exception: it is not retried,
   no further provider work starts in the round, and the round fails at once.
2. **Typed usage-limit detection.** A provider run that FAILED and left no
   answer is read for a usage-limit signature, and if one is found it raises a
   `ProviderUsageLimitError` with the provider, the reset time (epoch
   milliseconds, or null) and a short sanitized message. Only the CLI's own
   error output is read: for Claude Code, the `result` of an `is_error` JSON
   envelope and its standard error; for Codex, lines that begin `ERROR:`
   (after an optional bracketed timestamp) and JSON error events. A timeout,
   an output overflow or a launch failure is not read. A completed review is
   never read, so a diff or a summary quoting these phrases cannot trigger
   it, and structured output salvaged from a non-zero exit is a completed
   review when it carries `review_complete`; anything else salvaged, such as
   a Codex error event that parses as JSON, is read for a usage limit first.
3. **Holds.** The state folder of the repository keeps `provider-holds.json`:
   per provider `reason` (`usage-limit` or `provider-failure`), `since`,
   `resetAt` (or null), `retryAfter` and the message, written atomically, at
   most one hold per provider and a message of at most 300 characters.
   - A usage limit is held until the reported reset, or, when none could be
     read, for one hour (`LIMITS.providerHoldReprobeMs`); a reset more than
     eight days away (`LIMITS.providerHoldMaxMs`) is held only that long. It
     is recorded under every requirement, so `status` can show it.
   - A failure is held for one hour, and only when the review actually falls
     back without that provider: a provider whose failure could not be
     fallen back from (no other provider, an explicit requirement) is not
     held, so a passing outage never refuses later reviews.
   - A usage limit outranks a failure of the same provider, the hold already
     on disk included: a failure never replaces a usage limit and its reset.
     A hold expires by
     itself; a provider that completes work in a round has its hold removed.
     A corrupt file holds nothing back.
4. **Selection.** Under `auto`, a held provider is unavailable, without a
   probe. A failure hold applies only while another provider is free: when
   every provider is held, those held for a failure are probed and used, so a
   failure hold never leaves a review without a provider. If every provider
   is held for its usage limit, the review fails and names each retry time.
   Under `both`, `claude` or `codex` there is no fallback: a usage-limit hold
   on a required provider refuses the review at once, naming the provider and
   its retry time; a failure hold is not read. `gate --force` ignores the
   holds and tries every provider again. `install` and `doctor`'s provider
   probe do not read the holds.
5. **The restart.** `runGate` starts the review again ONCE, from scratch,
   under the review lease it already holds, with the remaining providers. The
   failed round's shard checkpoint is removed and the restart reads none, as
   `--force` does. The restart keeps out only the providers dropped from the
   failed round and, without `--force`, the holds still live once that round
   cleared the providers that worked. It plans as any single-provider review
   does (`reviewPlan`'s `sameFamilyPlan`). It does not restart after a
   process-tree cleanup failure (whose code stays on the error, so the
   watcher still pauses), with the launch fence up, for an error no provider
   failure was attributed to, or when no selected provider remains; a second
   failure fails closed. Each attempt cleans up its own review checkout and
   context bundle before the next one starts; the cleanup latch is reset only
   by an attempt that starts with it clear.
6. **Nothing silent.** Progress says, for a failure,
   `codex failed twice (<short reason>); restarting this review with claude only.`
   and for a usage limit
   `codex reported its usage limit; no further provider work starts in this round`
   then
   `codex usage limit reached (retry after <time>); restarting this review with claude only.`
   The failed round's report stays. The restart's report, attestation,
   GitHub comment and text result carry
   `providerFallback: { dropped, reason, resetAt, retryAfter, message, restarted: true }`
   with `reason` `usage-limit` or `provider-failure`, besides
   `providerSelection` and the `single-provider` label. The GitHub comment
   names the provider, the reason and the retry time, never the message. A
   review that left a provider out at the start because of its hold carries
   the same with `restarted: false`. `status` and `doctor` show the live
   holds of both kinds as `providerHolds`; `doctor` also prints them.
7. **The watcher** calls the same `runGate`, so the restart, the holds and
   the evidence are the same there; the restart happens inside the queued
   request the hook waits for.

### Evidence and policy identity

A fallback PASS is an ordinary `auto` single-provider PASS for its exact
commit and installed policy, as `auto` already accepts. The policy digest does
not change; `providers` stays `auto`. A project that needs both providers sets
`both`, which never falls back. The attestation records which provider was
left out and why; no field of it is required by the pre-push check.

### Checkpoints

A round that fails closed keeps its completed shard reviews, keyed by a digest
of each shard's assignment, its provider included. After a fallback under
`auto`, the restart plans with fewer providers, and a kept review of the
remaining provider would match its new assignment and be reused. That would be
sound evidence of that provider, but it would mix a discarded round into the
fallback. The simplest safe choice is taken: a round the review falls back
from keeps nothing, and the restart reads nothing. A round that met a usage
limit under `auto` keeps nothing either. Any other failed round keeps its
checkpoint as before (24 hours), so a rerun reviews only the shards that did
not complete.

## Wordings matched

Sentinel runs `claude -p --output-format json` and `codex exec` without
`--json`, with `--output-last-message`. A Claude Code failure arrives as a
non-zero exit with a JSON envelope on standard output (`is_error: true`,
`result` the message), or as such an envelope with exit 0; a Codex failure as a
non-zero exit with its error on standard error. That is what the code reads.
The phrases below are taken from the providers' messages as reported by users
and the maintainer; none was captured from a live out-of-allowance CLI in this
change.

| Provider | Message | Matched by | Reset read | Verified |
| --- | --- | --- | --- | --- |
| Claude Code | `Claude AI usage limit reached\|<epoch>` | `usage limit reached` | epoch seconds or milliseconds | assumed |
| Claude Code | `You've hit your weekly limit · resets 1am (America/Los_Angeles)` | `hit your … limit` | next 1am in that zone | assumed |
| Claude Code | `5-hour limit reached ∙ resets 3pm` | `5-hour limit reached` | next 3pm, local time | assumed |
| Claude Code | `… resets Nov 9 at 10am (America/Los_Angeles)` | as above | that date and time | assumed |
| Claude Code | `You're out of extra usage` | `out of extra usage` | as written | assumed |
| Codex | `You've hit your usage limit. Upgrade to Pro (…) or try again in 2 days 3 hours 5 minutes.` | `hit your usage limit` | now plus the duration | assumed |
| Codex | `… or try again at 3:05 PM.` | as above | next 3:05 PM, local time | assumed |
| Codex | an error event with `usage_limit_reached` and `resets_in_seconds` or `resets_at` | `usage_limit_reached` | the field | assumed |

Not matched, on purpose: rate limits (`rate_limit_error`, HTTP 429, "rate
limit"), which are transient and keep their one retry. A reset that cannot be
read (another date format, an unknown zone) is null, and the provider is
tried again after an hour. A clock time without a zone is read in the
machine's local time, which is the zone the CLI on the same machine prints.

A false positive is bounded: under `auto` the provider is left out for at most
its retry window and the review restarts with the other one; under an explicit
requirement the round was failing anyway.

## Acceptance

1. Classification: each wording above, positive; a rate limit, a diff line, an
   indented transcript line, a timeout and a completed review quoting the
   phrases, negative.
2. Reset parsing: epoch, duration, provider field, clock time with and
   without a zone, a dated reset in its named zone, a past reset, an unknown
   zone, the hold bound.
3. Holds: written, read, expired, the latest reset kept, a usage limit over a
   failure, cleared by a provider that worked, corrupt read as empty; a
   failure hold yields when no other provider is free.
4. Selection: `auto` leaves a held provider out without probing it, and
   names every reset when every provider is usage-limited; `both` and a
   single explicit provider are refused by a usage limit; `--force` tries
   again and a success clears.
5. Mid-review, under `auto`: a Codex shard failing twice falls back to
   Claude, and a Claude shard to Codex, with `reason: 'provider-failure'`; a
   coordinator failing twice falls back; a usage limit falls back without a
   retry; the restart reviews every shard afresh and records
   `providerFallback` in the report, the attestation, the comment and the
   text result; a failure on the restart fails closed; the next `auto`
   review skips the held provider until a success clears it.
6. No fallback: a process-tree cleanup failure (its code kept), an explicit
   requirement, a tolerated scout failure, a failed deterministic lane, and a
   Git error before any provider work. Every review checkout is removed.
7. `pnpm verify` passes. Live acceptance is still owed: a CLI that is really
   out of its allowance should confirm each wording, or correct the table
   above, and a real provider failure should be seen to fall back.

Sources: the code paths that run and parse each CLI (`buildClaudeArgs`,
`buildCodexArgs`, `parseClaudeOutput`, `runProcess`), and the plan this extends,
[current models and a single subscription](provider-profiles-and-single-subscription.md).
