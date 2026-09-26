# Rove Sentinel, CodeRabbit, and Greptile

All three address the same practical need: help developers find defects before
merging changes. Context-aware review, repository rules, and feedback on changes
are shared ideas across code-review tools. Sentinel's implementation grew from
Rove's local development workflow; it does not claim feature parity or equivalent
defect detection with either commercial product.

This comparison describes published capabilities checked on September 25, 2026.
Products change. It is not a benchmark, ranking, or pricing comparison.

| Area | Rove Sentinel | CodeRabbit | Greptile |
| --- | --- | --- | --- |
| Primary workflow | Local committed-diff gate, Git hook, optional local PR watcher | PR review plus CLI and IDE workflows | Repository-aware PR review and agent integrations |
| Review context | Bounded diff, history, heuristic reference map and installed project policy | Context-aware review, guidelines, learned feedback and multi-repository knowledge | Codebase graph, parallel agents and team-specific context |
| Project customization | Versioned charter, lessons and a small installed configuration | Repository and path-based instructions and custom checks | Plain-English rules and learning from team comments |
| Review follow-up | Commit-bound records, blocker rechecks and explicit finding deferrals | Review management and fix workflows | Agent integrations for resolving review feedback |
| Where it runs | Your machine with your authenticated Claude Code and Codex CLIs | Service integrations plus local developer tools | Service integrations; enterprise self-hosting is advertised |
| Additional product surfaces | No IDE extension, dashboard or hosted service | Planning, triage and security surfaces | Runtime-validation beta and additional security/agent surfaces |

The CodeRabbit column is based on its
[official documentation](https://docs.coderabbit.ai/), which also documents
GitHub, GitLab, Azure DevOps, and Bitbucket integrations. The Greptile column is
based on its [official product overview](https://www.greptile.com/), including
its graph-based context and deployment options. These are the vendors' stated
capabilities, not independently measured outcomes.

## What distinguishes Sentinel's current scope

Sentinel makes the review decision part of a local push workflow. Its result is
bound to a specific commit, base and policy snapshot; subsequent edits cannot
reuse a stale PASS. Candidate generation and adjudication are separate stages.
Repeated repair reviews have bounded rules, and accepted limitations require a
recorded reason. The orchestration code is available under Apache-2.0 so
developers can inspect and improve these mechanics.

This design also has tradeoffs. The user's machine and credentials must remain
available. Reviews consume their existing AI plan allowances. The current
GitHub integration is a status comment, not an authoritative required check.
There is no persistent codebase graph, automatic learning from all team comments,
multi-repository analysis, autofix service, or runtime sandbox comparable to a
dedicated execution platform. See [support and limitations](support.md).

We welcome contributions that make these choices clearer, safer, and more
useful. Claims about review quality should come from a reproducible evaluation
with false positives, misses, cost, and latency reported together.
