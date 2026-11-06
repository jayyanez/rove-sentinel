# Models, reasoning effort, and subscriptions

From Sentinel 1.11, one authenticated native provider CLI is sufficient. The
default `auto` mode selects all subscription-authenticated providers available
at the start of a new review. A selected provider that fails during that review
is never silently dropped; under `auto`, one that fails after its retry, or
reports its subscription's usage limit, is dropped explicitly, once, as
[below](#provider-failures-usage-limits-and-fallback).
API keys do not satisfy subscription authentication.

## Defaults and customization

By default all roles use the same project-selected model and initial effort
per provider; a project can set them per role (see below).
The defaults are GPT-6.1 Sol (`gpt-6.1-sol`) and Claude Opus 5.5
(`claude-opus-5-5`), both at `high`, with a ceiling of `xhigh`.

Add these optional fields to your project's `.rove-sentinel.json`:

```json
{
  "schemaVersion": 1,
  "providers": "auto",
  "models": {
    "codex": { "model": "gpt-6.1-sol", "effort": "high", "maxEffort": "xhigh" },
    "claude": { "model": "claude-opus-5-5", "effort": "high", "maxEffort": "xhigh" }
  }
}
```

You can omit `models` to follow the defaults in each new engine release. When
you specify a provider's settings, installation resolves omitted fields and
freezes that profile; engine updates preserve the custom configuration.

| Setting | Choices and behavior |
| --- | --- |
| `providers` | `auto` (default), `both`, `claude`, or `codex` |
| `model` | A native CLI model identifier or supported alias available to your account |
| `effort` | Initial reasoning effort; `high` by default |
| `maxEffort` | Highest allowed second-pass effort; `xhigh` by default (`high` for Claude 4.6), or the initial effort if that is higher |

Claude accepts `low`, `medium`, `high`, `xhigh`, and `max`, depending on the
model. Codex can also accept `none` and `minimal` on models supporting them.
Sentinel rejects malformed identifiers, unknown settings, effort ceilings below
the initial effort, and known incompatible choices. Other model capabilities
and account access must be checked by the native CLI. A syntactically accepted
identifier is not a promise that the provider grants your account access.

For example, to use only Codex with an available GPT-6 Sol model:

```json
{
  "schemaVersion": 1,
  "providers": "codex",
  "models": {
    "codex": { "model": "gpt-6-sol", "effort": "medium", "maxEffort": "high" }
  }
}
```

### Per-role settings

From 1.13, a provider's `roles` can give one review role its own `model`,
`effort` or `maxEffort`. The roles are `scout`, `hypothesis`, `shard`,
`reviewer` (the whole-diff lens reviewer used when no shard exists) and
`coordinator` (adjudication). A role you leave out uses the provider's
settings, and an omitted field of a named role comes from the provider. For
example, to scout and test hypotheses at medium effort while shards and
adjudication stay at high:

```json
{
  "schemaVersion": 1,
  "models": {
    "claude": { "effort": "high", "roles": { "scout": { "effort": "medium" }, "hypothesis": { "effort": "medium" } } },
    "codex": { "effort": "high", "roles": { "scout": { "effort": "medium" }, "hypothesis": { "effort": "medium" } } }
  }
}
```

Role settings are part of the installed policy and its digest, appear under
`roles` in `status`, reports and attestations, and are checked by
`doctor --test-models`, which probes every distinct model and effort a role
can request. The defaults have no role settings: every role uses the
provider's settings, as before. A lower effort is faster and finds less; the
engine does not pick it for you.

To prevent escalation, set `maxEffort` equal to `effort`. Exact versioned model
identifiers make selection reproducible. Aliases such as `opus` may change at
the provider; use them only if you intend to follow that alias. Models offered
by the OpenAI API are not necessarily available with ChatGPT CLI sign-in.

## Check and apply a change

1. Edit and review the configuration on a branch. Its proposed settings cannot
   approve their own change: the branch is reviewed with the installed policy.
2. Run `rove-sentinel doctor --project-config` to check the desired provider
   requirements and report resolved model settings without making a model call.
3. Optionally run `rove-sentinel doctor --project-config --test-models`. This
   makes small real calls at the initial and ceiling efforts for each selected
   provider and consumes your own subscription allowance. It does not enable
   API billing. A failure names the unavailable model or CLI error.
4. After accepting the change, run `rove-sentinel install` from your trusted
   stable checkout. Existing active reviews must finish before replacement.
5. `rove-sentinel status` displays installed requirements and profiles. Plain
   `doctor` and `doctor --test-models` use installed policy.

The exact installed configuration is included in the policy digest. Different
models, efforts or required providers cannot reuse a PASS issued under the old
configuration. Reports and attestations record selected providers and actual
requested model/effort passes. In `auto`, a completed single-provider review
remains valid for its exact commit and policy if another provider subsequently
becomes available; use `gate --force` for a fresh selection. Choose `both` if
the presence of both authenticated providers is a requirement.

## Escalation and review independence

A provider returns `effort_request: null` when it can complete its assignment.
If it needs materially harder reasoning, it can return a concrete reason of at
most 500 characters. Sentinel discards the provisional output and starts the
same assignment in a fresh process at `maxEffort` once. Tool, candidate and
concurrency limits are unchanged. Each pass retains the role's bounded timeout;
one stage attempt can therefore spend up to twice that timeout. The existing
single technical retry remains bounded; for a shard of several parts whose
reviewer reported its review incomplete, that retry is one fresh reviewer per
part. A failed or still-incomplete final pass cannot approve the review.

Every provider must explicitly return `review_complete`. It is `false` when a
required read was blocked, failed or came back truncated — the assigned diff
(every part), a required read the review context lists, or in a follow-up round
the code that settles a prior blocker assigned to the reviewer, which is read
around its location (by line range in a large file, never whole) — or when no
tool host was available. Any other truncated read is not incompleteness. A spent verification budget or a failing verification command is not
incompleteness. An empty finding list cannot substitute for completing the
assigned review. The error of an incomplete review keeps the reviewer's own
account. A follow-up reviewer omits an assigned prior blocker only when it
verified the fix; one it could not settle is reported again, because the gate
reads an omitted blocker as fixed.

Single-provider mode preserves the risk-based role counts, shard coverage,
scouting, separate verification and fresh adjudication contexts, cleanup fences
and convergence rules. Its report says `single-provider` because separate
contexts do not provide cross-model diversity. Having both providers available
keeps Sentinel's existing author/risk routing; some low-risk or author-specific
plans still use only one provider.

## Provider failures, usage limits and fallback

Under `auto`, a review falls back to the other provider when one provider's
work fails the round, whatever the cause: a shard or lens reviewer, or the
adjudicator, that still fails after its one retry, through an error, a
timeout, malformed output or a review it still reports incomplete. The same
holds for Claude and Codex. A provider that reports its subscription's usage
limit is not retried, since it would refuse again: the review falls back at
once. Sentinel recognizes a usage limit from the CLI's own error output, only
when a provider run failed and left no answer, and reads the reset time it
reports; a review that completed is never read for it, whatever its text
quotes.

The round that failed ends with its own report, and its evidence, kept shard
reviews included, is discarded. The review then restarts once, from scratch,
with the providers that remain. If none remains, or the restart fails as
well, the review fails closed. The provider it fell back from is held out of
later `auto` reviews: until the reset its CLI reported for a usage limit (an
hour when none could be read, at most eight days), and for an hour after a
failure. A hold expires by itself, and a provider that completes work in a
review has its hold removed. A failure hold never leaves a review without a
provider: when every provider is held, those held for a failure are tried.

| Requirement | A provider is held | A provider's work fails the round |
| --- | --- | --- |
| `auto` | Left out of the review; if every provider is held for its usage limit, the review fails and names each retry time | The review restarts once without it, and holds it. A second failure fails closed |
| `both`, `claude`, `codex` | A usage limit refuses the review, naming the provider and its retry time; a failure hold is not read | The round fails closed. Nothing falls back, and only a usage limit is held |

A review never falls back over a safety stop: a provider process tree whose
cleanup could not be verified (the watcher pauses on it), the launch fence of
a stopping watcher, a failed deterministic lane, or an error that is not a
provider's, such as Git's, the gate's own, or a local error before the
provider was launched (an artifact that could not be written), even when a
usage limit happened in the same round. A scout or a hypothesis reviewer
that fails is tolerated as before, and only its usage limit fails the round.

The fallback is never silent. Progress says, for example, `codex failed twice
(…); restarting this review with claude only.` or `codex usage limit reached
(retry after …); restarting this review with claude only.` The report, the
attestation, the GitHub comment and the text result carry `providerFallback`
(`dropped`, `reason` (`"usage-limit"` or `"provider-failure"`), `resetAt`,
`retryAfter`, `message` and `restarted`) besides the `single-provider` label.
A review that left a provider out from the start because of its hold says the
same with `restarted: false`. `status` and `doctor` list the live holds, of
both kinds, under `providerHolds`.

A fallback PASS is an ordinary `auto` single-provider PASS for its exact
commit and policy; the policy digest does not change. If a project needs both
providers on every review, it sets `both`, which never falls back.

`gate --force` ignores the holds and tries every provider again, for example
after an allowance was raised. Which provider messages are recognized as a
usage limit, and which of them were not yet seen from a live CLI, is in the
[plan](plans/provider-usage-limit-fallback.md).

## Accounts

You may have several accounts (subscriptions) of the same CLI. Claude Code
chooses its account by the folder in `CLAUDE_CONFIG_DIR` (default
`~/.claude`), and Codex by the folder in `CODEX_HOME` (default `~/.codex`).
Declare the accounts Sentinel may review with in a per-user accounts file,
each with a label of your own:

```json
{
  "schemaVersion": 1,
  "accounts": {
    "claude": [
      { "label": "personal", "configDir": "<absolute path of a CLAUDE_CONFIG_DIR>" },
      { "label": "team", "configDir": "<absolute path of another one>" }
    ],
    "codex": [
      { "label": "main", "home": "<absolute path of a CODEX_HOME>" }
    ]
  }
}
```

The file is machine-local and never part of a repository or its policy
digest. Sentinel reads it from `--accounts <file>` (`gate`, `status`,
`doctor`, `install`), else the file `ROVE_SENTINEL_ACCOUNTS` names, else
`accounts.json` beside its per-repository state:
`%LOCALAPPDATA%\Rove\shared-review-gate\` on Windows,
`~/Library/Application Support/Rove/shared-review-gate/` on macOS. The
watcher reads the one of its own environment for each review; `install`
gives the watcher it installs or starts the file named by `--accounts` or
`ROVE_SENTINEL_ACCOUNTS`, and the default needs nothing. Unknown keys,
an unknown provider, more than 8 accounts of a provider, a label other than
1 to 32 letters, digits, `.`, `_` or `-`, a label used twice for one provider,
a relative folder and one folder under two labels are refused.

With no file, or no account declared for a provider, that provider reviews
under the login Sentinel inherits, exactly as before. With accounts:

- **Which account reviews.** Routing still prefers the provider the author
  did not write with. Within a provider, Sentinel never uses the author's own
  account while another is signed in and not held. The author's account is
  the `CLAUDE_CONFIG_DIR` or `CODEX_HOME` of the shell that ran `gate` or the
  push (its CLI's default folder when unset); the hook passes it to the watcher.
  Among the eligible accounts the one with no hold and used least recently
  goes first. Neither CLI documents a way to read how much allowance is left,
  so Sentinel rotates instead of guessing; the
  [plan](plans/review-accounts.md#research) has the research.
- **The author's own account, last.** When no other account of that
  provider is usable, the review uses the author's own, and the progress, the
  report, the attestation, the comment and the text result say so.
- **Holds and restarts per account.** An account that reports its usage limit,
  or whose work fails the round after its retry, is held as a provider would
  be, and the review restarts from scratch with the provider's next account,
  under any requirement: `both`, `claude` and `codex` never change provider,
  but they may change account. Only when none of its accounts remains is the
  provider dropped, under `auto` only, as above. A review restarts at most
  once per account that fails, plus once for the provider.
- **Each reviewer process** gets only its account's variable set; no other
  authentication variable changes, and no credential is read. A credential
  variable that would override the account folder (`CLAUDE_CODE_OAUTH_TOKEN`
  or `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` for Claude, `CODEX_ACCESS_TOKEN` or
  `CODEX_API_KEY` for Codex) refuses a review that would use that provider's
  accounts, naming the variable: unset it where Sentinel runs. Without
  accounts these variables change nothing.
- **Restarts review the same commits.** A restart, for an account or a
  provider, reviews the base, head and branch the first round resolved, even
  if `HEAD` has moved since.
- **Evidence by label.** Reports, attestations, comments and text results
  carry `accounts` (the label per provider, and `authorOwn` for the author's
  provider: `true`, `false`, or `null` when the review's requester is not
  known, as for a pull request found on GitHub) and `accountFallbacks`; each
  provider execution names its `account`. Folders never appear.
- `status` lists each account by label, signed in or not, with its hold and
  last review; `doctor` and `install` probe every configured account, those
  of a provider the requirement leaves out included, list them under
  `accounts`, and `doctor` prints the holds. `gate --force`
  ignores account holds as it does provider holds. `doctor --test-models`
  still calls the models under the inherited login only.

## Client compatibility

GPT-6.1 Sol was qualified on Windows with Codex CLI 0.159.0. The older 0.154.0
client rejected that identifier with ChatGPT authentication. Sentinel requires
0.159.0 or later when this model is selected; it does not replace an old client
or silently choose another model. Claude Opus 5.5 needs Claude Code 2.1.280 or
later; Sonnet 5.5 needs 2.1.284. This does not guarantee account access. Default
Opus 5.5 was qualified with Claude Code 2.1.284 at both effort levels.

Read the providers' current documentation for their model lists and controls:
[OpenAI model selection](https://learn.chatgpt.com/docs/models),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and
[Claude Code model configuration](https://code.claude.com/docs/en/model-config).
Use the native CLIs' model pickers to inspect models offered to your account.

`gate --dry-run` plans the configured routing without probing authentication or
starting provider processes. Its provider selection is unverified; use `doctor`
to check the actual installed tools and subscriptions.
