# Current models and a single subscription

Status: implementation pending.

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
- Expose provider availability, selected models and effort in doctor/status,
  reports and onboarding documentation. Do not enable API billing.

## Acceptance and remaining work

1. Validate official model identifiers and native CLI flags and minimum versions.
2. Add regression coverage for Claude-only, Codex-only, both, neither, explicit
   provider requirements, subscription authentication, immutable installed
   policy, evidence reuse and bounded effort escalation.
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

Next action: implement the provider-selection and effort contracts on this PR.
