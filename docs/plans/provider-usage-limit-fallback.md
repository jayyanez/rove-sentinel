# A provider's usage limit, and an explicit fallback

Status: implemented and verified with the deterministic suite; not yet
reviewed, released or exercised against a live CLI that is out of its
allowance. The wordings below that were not seen from a live CLI are marked
as assumed.

With `providers: "auto"`, Sentinel selects every subscription-authenticated
provider it finds at the start of a review. Detection checks only the CLI's
version and sign-in, so a provider whose subscription has used up its
allowance still counts as available and is selected. A branch an agent of one
provider wrote routes its cross-model work to the other. When that provider
then refuses with its usage limit, the round fails closed, and so does every
later review, until the allowance resets, which can be days away. The push is
blocked the whole time, although the other provider could have reviewed it.
The same holds the other way round.

The review contract stands: a selected provider is never dropped silently
after a model, quota or process failure; a review fails closed; evidence is
bound to the selected provider set; no API billing; no new provider. What
changes is that `auto` may leave a provider out explicitly, and say so.

## Intended behavior

1. **Typed detection.** A provider run that FAILED and left no answer is read
   for a usage-limit signature, and if one is found it raises a
   `ProviderUsageLimitError` with the provider, the reset time (epoch
   milliseconds, or null) and a short sanitized message. Only the CLI's own
   error output is read: for Claude Code, the `result` of an `is_error` JSON
   envelope and its standard error; for Codex, lines that begin `ERROR:`
   (after an optional bracketed timestamp) and JSON error events. A timeout,
   an output overflow or a launch failure is not read. A completed review is
   never read, so a diff or a summary quoting these phrases cannot trigger
   it, and structured output salvaged from a non-zero exit is a completed
   review. A usage limit is not retried.
2. **A durable record.** The state folder of the repository keeps
   `provider-usage-limits.json`: per provider `since`, `resetAt` (or null),
   `retryAfter` and the message, written atomically, at most one record per
   provider and a message of at most 300 characters. `retryAfter` is the
   reported reset, or, when none could be read, one hour later
   (`LIMITS.usageLimitReprobeMs`), when the provider is tried again. A reset
   more than eight days away (`LIMITS.usageLimitMaxHoldMs`) is held only that
   long. A record expires by itself; a provider that completes work in a
   round has its record removed. A corrupt record holds nothing back.
3. **Selection.** Under `auto`, a provider with a live record is unavailable
   (`codex usage limit reached; retry after <time>`), without a probe. If none
   remains, the review fails and names each provider's retry time. Under
   `both`, `claude` or `codex` there is no fallback: a live record for a
   required provider refuses the review at once, naming the provider and its
   retry time. `gate --force` ignores the records and tries every provider
   again; a limit it meets is recorded again. `install` and `doctor`'s
   provider probe do not read the records, so neither is refused by them.
4. **Mid-review.** Every provider call of a round goes through one guard.
   Once a provider reports its limit, no further provider work starts in that
   round (work already running finishes), the adjudication stream stops, and
   the round fails closed with its own report. The scout, a hypothesis or a
   lens reviewer reaching the limit fails the round too, although their other
   failures do not: the round can no longer be what it was planned as. The
   limit is recorded under every requirement. Under `auto`, the round's shard
   checkpoint is removed, and `runGate` starts the review again ONCE, from
   scratch, under the review lease it already holds, with the remaining
   providers; the restart reads no checkpoint either, as `--force` does. The
   restart plans as any single-provider review does (`reviewPlan`'s
   `sameFamilyPlan`). It does not restart after a process-tree cleanup
   failure, with the launch fence up, or when no selected provider remains; a
   second limit fails closed. Each attempt cleans up its own review checkout
   and context bundle before the next one starts; the cleanup latch is reset
   only by an attempt that starts with it clear.
5. **Nothing silent.** Progress says
   `codex reported its usage limit; no further provider work starts in this round`
   and then
   `codex usage limit reached (retry after <time>); restarting this review with claude only.`
   The failed round's report stays. The restart's report, attestation,
   GitHub comment and text result carry
   `providerFallback: { dropped, reason: 'usage-limit', resetAt, retryAfter, message, restarted: true }`
   besides `providerSelection` and the `single-provider` label. A review that
   left a provider out at the start because of its record carries the same
   with `restarted: false`. `status` and `doctor` show the live records as
   `providerUsageLimits`; `doctor` also prints them.
6. **The watcher** calls the same `runGate`, so the restart, the records and
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
of each shard's assignment, its provider included. After a usage limit under
`auto`, the restart plans with fewer providers, and a kept review of the
remaining provider would match its new assignment and be reused. That would be
sound evidence of that provider, but it would mix a discarded round into the
fallback. The simplest safe choice is taken: under `auto`, a round that met a
usage limit keeps nothing, and the restart reads nothing. Under an explicit
requirement the checkpoint is kept as for any failed round (24 hours), so a
rerun after the reset reviews only the shards that did not complete.

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
   without a zone, a dated reset, a past reset, an unknown zone, the hold bound.
3. The record: written, read, expired, the latest reset kept, cleared by a
   provider that worked, corrupt read as empty.
4. Selection: `auto` leaves a recorded provider out without probing it, and
   names every reset when none remains; `both` and a single explicit provider
   are refused with the reset; `--force` tries again and a success clears.
5. Mid-review: a usage limit under `auto` restarts once with the other
   provider, reviews every shard afresh, and records `providerFallback` in the
   report, the attestation, the comment and the text result; a second limit
   fails closed; all providers limited does not restart; an explicit
   requirement fails closed without falling back; every review checkout is
   removed.
6. `pnpm verify` passes. Live acceptance, with a CLI that is really out of its
   allowance, is still owed: it should confirm each wording, or correct the
   table above.

Sources: the code paths that run and parse each CLI (`buildClaudeArgs`,
`buildCodexArgs`, `parseClaudeOutput`, `runProcess`), and the plan this extends,
[current models and a single subscription](provider-profiles-and-single-subscription.md).
