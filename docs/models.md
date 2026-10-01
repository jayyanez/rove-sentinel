# Models, reasoning effort, and subscriptions

From Sentinel 1.11, one authenticated native provider CLI is sufficient. The
default `auto` mode selects all subscription-authenticated providers available
at the start of a new review. A selected provider that fails during that review
is never silently dropped. API keys do not satisfy subscription authentication.

## Defaults and customization

All roles use the same project-selected model and initial effort per provider.
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
single technical retry remains bounded. A failed or still-incomplete final
pass cannot approve the review.

Every provider must explicitly return `review_complete`. It is `false` when a
required read was blocked, failed or came back truncated — the assigned diff
(every part), a required read the review context lists, or in a follow-up round
the file of a prior blocker assigned to the reviewer — or when no tool host was
available. A spent verification budget or a failing verification command is not
incompleteness. An empty finding list cannot substitute for completing the
assigned review. The error of an incomplete review keeps the reviewer's own
account.

Single-provider mode preserves the risk-based role counts, shard coverage,
scouting, separate verification and fresh adjudication contexts, cleanup fences
and convergence rules. Its report says `single-provider` because separate
contexts do not provide cross-model diversity. Having both providers available
keeps Sentinel's existing author/risk routing; some low-risk or author-specific
plans still use only one provider.

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
