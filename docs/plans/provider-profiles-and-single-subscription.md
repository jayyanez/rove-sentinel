# Current models and a single subscription

Status: implemented and verified locally; merge, release and activation pending.
The PR records the current exact-head incumbent-engine review and CI results.

Sentinel 1.10.0 pins Codex to GPT-5.6 Sol and uses Claude's moving Sonnet and
Opus aliases at different effort levels. Live installation requires both
subscriptions, including when a review routes all its work to one provider.

## Intended behavior

- Pin every Codex review role to `gpt-6.1-sol` and every Claude role to
  `claude-opus-5-5`, with `high` effort by default.
- Allow a reviewer to request one fresh `xhigh` pass with a concrete reason.
  Discard its provisional answer, retain the escalation reason and actual
  effort in evidence, and fail closed if the deeper pass fails.
- Accept one authenticated native CLI. Default to automatic provider
  selection; support explicit `both`, `claude`, and `codex` requirements in
  trusted installed configuration.
- Prefer existing cross-provider routing when both are available. With one
  provider, preserve shard coverage, role counts, fresh adjudication contexts,
  cleanup fences and convergence rules. Label the reduced model diversity.
- Bind completed evidence to the selected provider set. A run cannot silently
  drop a selected provider after a model, quota or process failure.
  Required providers and profiles are part of installed policy identity; `auto`
  accepts completed single-provider evidence for its exact commit and policy.
- Let projects override the model, initial effort and maximum effort per
  provider in trusted configuration. Reject invalid shapes and effort ordering;
  provide an explicit live model-access check through doctor. Subscription
  access must be verified by the native CLI, never inferred from an API catalog.
- Expose provider availability, selected models and effort in doctor/status,
  reports and onboarding documentation. Do not enable API billing.

## Acceptance and remaining work

1. Validate official model identifiers and native CLI flags and minimum versions.
2. Add regression coverage for Claude-only, Codex-only, both, neither, explicit
   provider requirements, subscription authentication, immutable installed
   policy, custom model profiles, evidence reuse and bounded effort escalation.
3. Run the deterministic suite and isolated-consumer package verification.
4. Qualify both pinned models at high and xhigh on the Windows host and exercise
   each single-provider workflow with synthetic source.
5. Review the exact committed diff with the incumbent published engine and pass
   required CI before merge or release.

No Rove source change is required to implement this Sentinel capability. Rove's
current watcher and active agents remain on the published engine until a new
release is ready for ordinary idle activation. Existing projects can opt into
`both` if they need to require model diversity.

Sources: [OpenAI model controls](https://learn.chatgpt.com/docs/models),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and
[Claude Code model configuration](https://code.claude.com/docs/en/model-config).

Native model probes passed for Opus 5.5 at high/xhigh with Claude Code 2.1.284,
and GPT-6.1 Sol at high/xhigh with a separate Codex 0.159.0 executable. Codex
0.154.0 rejected GPT-6.1 Sol with ChatGPT sign-in; early client-version checks now
refuse that combination. The machine's original CLI and Rove watcher are intact.

All 465 deterministic tests pass, as does isolated-consumer package installation.
Claude-only and Codex-only native synthetic pipelines both detected and freshly
adjudicated the introduced defect. An incomplete client trial exposed the empty
findings/blocked-read gap; explicit completeness checks now reject that case.

The first incumbent review found an omitted charter update, a legacy-Claude
default-ceiling error, a stale usage claim and misleading uninstalled status.
The charter and usage now match single-provider support; model and status repairs
have regressions that failed before and passed after the fixes. Model-access
output also uses the existing bounded structured-output reader.

Next action: pass the final incumbent-engine review, push, and inspect required CI.
Release publication and Rove activation are separate delivery steps. The current
Rove watcher remains on 1.10; its old Codex client needs updating before the new
default can be activated. Installation checks refuse that old-client combination.
