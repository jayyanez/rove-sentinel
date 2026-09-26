# Multiple projects and concurrent agents

[Architecture](architecture.md) · [Automatic updates](updates.md)

Sentinel separates a **runtime**, a **repository watcher**, and an individual
**review**. They are not the same process or unit of ownership.

| Situation | What Sentinel shares | What stays separate |
| --- | --- | --- |
| Several agents or PRs in Rove | One repository watcher, request queue, installed policy and retained state | Exact branch/base/head review identities and findings |
| Several worktrees of one repository | The same repository state and watcher, identified by normalized remote URL | Working files and committed review targets |
| Rove and a different project | Verified runtime files under the same OS account | Watcher, queue, policy, trusted authors, pauses, reports and selected engine |
| Another computer or OS account | The published release artifacts | Local state, processes, provider authentication and engine selection |

## What happens when agents work at the same time

A pre-push request without an existing valid attestation enters the repository's
shared queue. Its watcher processes requests serially; it does not create a watcher
per agent or per PR. Automatic GitHub discovery yields to local queued requests.
A single review may still run several Claude Code and Codex subprocesses in
parallel for its review stages.

An explicit foreground `gate` command runs its own review rather than entering
that watcher queue. Multiple foreground reviews can therefore coexist with the
watcher. The runtime updater accounts for their active review leases before
activating an engine. Provider processes belong to those reviews; they are not
additional persistent watchers.

Repository identity normalizes credentials, Git transport and GitHub path case.
SSH and HTTPS clones of the same GitHub repository share state. Only one healthy
watcher may own that identity: install it from a stable canonical checkout.
Different remotes are different repositories, even if their file trees look alike.

## Updates across projects

Downloads are shared under the OS account, so two projects can reuse the same
verified engine directory. Activation is per repository. A busy project can retain
an older version while an idle project moves ahead. The launcher selects the
repository's active engine, and each attestation includes the actual engine and
policy identity. A project can disable updates without disabling another project.

The runtime store protects versions referenced by projects and running processes.
It never overwrites the old runtime to update another one. The storage cap can
postpone further downloads when all retained versions are still referenced.

## Current limits

There is no single machine-wide review scheduler or provider quota manager.
Separate repositories and explicit foreground reviews can consume provider capacity
at the same time. The per-review concurrency limits do not constitute a global
machine cap. Subscription rate limits, CPU and memory remain shared host resources.
Pause a project's watcher when necessary; an automatic runtime update does not
increase review concurrency or launch paid reviews as an installation test.

The shared runtime is a distribution cache, not a multi-user service. It does not
share authentication between OS accounts, mix project policy, or publish one
project's source or results to another project.
