# Changelog

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
