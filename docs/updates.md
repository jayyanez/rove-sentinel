# Automatic updates

[Installation](installation.md) · [Usage](usage.md) · [Multiple projects](multiple-projects.md)

After installation, the Windows watcher checks for stable Sentinel releases in
the background. It downloads a new engine into its own versioned directory and
activates it when reviews are idle. No approval command or consumer pull request
is required for each engine release. The project dependency remains a pinned
launcher; the running engine version is reported separately.

## What you see

Sentinel attempts a Windows desktop notification when a release is downloaded,
when it becomes active, or when activation needs attention. Windows notification
settings can suppress it. The notifier has no persistent window and exits after
showing its message. Review commands also print the retained update state.

```powershell
npx --no-install rove-sentinel updates
npx --no-install rove-sentinel status
npx --no-install rove-sentinel --version
```

A downloaded release can remain **waiting** while another review runs. **Active**
means the new watcher passed its health check and new commands select that engine.
Existing Claude Code and Codex sessions can continue; their next Sentinel command
uses the selected version. An already running Sentinel review retains its version
until it finishes. There is no need to restart Claude Code or Codex just for this.

`failed` means activation failed and the previous watcher was restored.
`recovery-required` means restoration could not be verified: review stays fenced
until the retained recovery information is inspected. Do not treat either as a
successful update. `download-failed` leaves the running engine unchanged.

## Control automatic updates

```powershell
npx --no-install rove-sentinel updates --disable
npx --no-install rove-sentinel updates --enable
npx --no-install rove-sentinel update
```

Updates are enabled by the Windows installation command. Disable them per
repository to retain the current engine. The optional `update` command retries
now; routine operation does not require it. It respects disabled updates.
`ROVE_SENTINEL_AUTO_UPDATE=0` disables installation for a process and its children.
Set it before installing or starting a watcher for an environment-wide opt-out.
`ROVE_SENTINEL_UPDATE_NOTIFICATIONS=0` silences update notifications and CLI notices.

The watcher normally checks daily; an already downloaded release waiting for idle
is retried after ten minutes. A release that failed activation is not retried
automatically until another release appears; an explicit `update` retries it.
Offline and rate-limit failures do not block reviews.

## What changes, and what stays pinned

The dependency URL and lockfile record the launcher installed in the project.
They are not rewritten by the updater. Each repository records its selected
engine, while all repositories under the same OS account share immutable engine
files. `--version` reports the selected engine, which may be newer than the
launcher dependency. CI hosts and other computers have their own installations;
installing the project lockfile alone does not reproduce a developer's managed
engine selection. Record the engine version and policy digest from a review when
reproducing its result. Disable automatic updates where a fixed engine is required.

Automatic upgrades preserve installed project configuration, custom charter, and
lessons. They do not import rules from a developer's working tree. A project using
the bundled charter receives the new release's bundled charter. Intentional
project-policy changes still require a deliberate `install` from a trusted stable
checkout. Engine changes invalidate incompatible old attestations.

The updater downloads only a published stable release from the official Sentinel
GitHub repository, verifies the archive against its SHA-256 asset, installs it
with npm lifecycle scripts disabled, and checks its engine protocol. This trusts
the release publisher and GitHub account security; a checksum from that same
release is an integrity check, not an independent signature.

## Isolation and recovery

Active reviews acquire a shared repository lease. Activation excludes new reviews,
waits for the watcher to acknowledge an idle pause, stops that watcher, installs
the new runtime using the frozen policy, verifies health, and publishes the new
selection. A failed activation attempts to restore the previous policy and
watcher. Runtime files are never replaced in place.

State is under Sentinel's OS-user state directory (shown by `status`). Per-project
files include `engine.json`, `update-settings.json`, `update-recovery.json` and, during activation,
`update-in-progress.json`. An interrupted transaction leaves its fence and backup;
do not delete them merely to unblock a push. Inspect the recorded PIDs, restore
the previous policy and runtime from the backup, verify watcher health, then remove
the transaction marker and its update pause. Report incomplete recovery with the
retained paths. Other projects remain independent.

The shared engine store retains at most five installed versions. References from
projects and live processes protect versions from collection; the previous managed
version remains available for rollback. If every slot is retained, downloading
pauses with an actionable error. Inactive projects may need deliberate state
retirement before more versions fit. A download interrupted by process termination
can leave `download.lock` and `staging`; inspect the recorded owner before clearing
these failed-download artifacts. Never remove a directory used by a live process.

## Discovery without installation

```powershell
npx --no-install rove-sentinel update-check --force --json
```

`update-check`, `status` and `doctor` query public GitHub metadata without sending
repository contents or credentials. Successful checks are cached for 24 hours;
failed checks back off for one hour. Metadata requests have a three-second timeout
and a 128 KiB response bound. `--no-update-check` or
`ROVE_SENTINEL_UPDATE_CHECK=0` disables these advisory lookups separately from
background installation. Review and pre-push commands do not fetch release metadata.

GitHub **Watch → Custom → Releases** is another optional, per-user notification
channel. Installing Sentinel does not change your account's subscriptions.

## Current support

Automatic watcher activation and native notifications target Windows. npm is
required to install managed runtimes even when the consuming project uses pnpm;
Node.js installations normally include npm. macOS and Linux have no automatic
activation in this release. npm registry and host policies still apply. Bootstrap
versions before 1.10.0 cannot update themselves: install the 1.10.0 launcher once
through the project's normal dependency workflow, then install its watcher.

That initial migration also applies to existing worktrees and other clones on
the machine: each needs the new launcher before it can follow managed engines.
Let v1.9.0 reviews finish before switching the shared watcher. A checkout still
running the old 1.9.0 package cannot use a newer installed policy; update its
dependency through the project's normal branch workflow before its next review.
