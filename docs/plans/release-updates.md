# Automatic engine updates

Implementation and qualification are complete. Release delivery is tracked in
[Sentinel PR #6](https://github.com/jayyanez/rove-sentinel/pull/6) and the
[v1.10.0 release](https://github.com/jayyanez/rove-sentinel/releases/tag/v1.10.0).
Rove's one-time launcher adoption is a separate consumer PR.

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

The final full suite passed 429 tests and package installation. Live Windows
acceptance passed with two real scheduled watchers, shared verified downloads,
independent activation, frozen-policy preservation and restoration after an
injected startup failure. It identified two lifecycle defects now covered by
regressions; the final suite includes those repairs. Independent review passed
after two advisory repairs, and required Windows CI passed on Node 22 and 24.
The implementation is ready for release delivery and separate consumer adoption.
The v1.9.0 release stays immutable.
