# Automatic engine updates

Status: implementing in [Sentinel PR #6](https://github.com/jayyanez/rove-sentinel/pull/6).
Rove's one-time launcher adoption is tracked in its private PR #535.

## Outcome

Sentinel discovers and installs its own stable releases in the background. Each
release has immutable runtime files. Running agents and reviews keep their version;
new reviews use a replacement only after the repository watcher activates it
successfully. Different projects can activate independently and share downloads.

## Acceptance

- Validate stable release metadata, expected assets, SHA-256 and engine protocol.
- Preserve consumer dependency pins and installed project policy.
- Bound lookup, download, worker retries and runtime retention.
- Exclude activation while foreground reviews or watcher work are active.
- Verify the replacement and restore the previous runtime after startup failure.
- Retain a blocking fence and recovery record if restoration cannot be verified.
- Show pending, active and failed states in native notifications and the CLI.
- Support per-repository opt-out and document multi-project resource limits.
- Pass deterministic, package, live Windows lifecycle and independent review gates.

## Current evidence and next action

The final full suite passed 425 tests and package installation. Live Windows
acceptance passed with two real scheduled watchers, shared verified downloads,
independent activation, frozen-policy preservation and restoration after an
injected startup failure. It identified two lifecycle defects now covered by
regressions; the final suite includes those repairs. Complete independent review
and required CI, then publish v1.10.0 and adopt its launcher in Rove with normal
per-PR merge authorization. The v1.9.0 release stays immutable.
