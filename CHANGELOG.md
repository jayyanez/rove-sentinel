# Changelog

## 1.11.1 — changes without text own no shard

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
