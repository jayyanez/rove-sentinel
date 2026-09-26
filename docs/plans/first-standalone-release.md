# Plan: first standalone release

**Delivery status:** Implementing in [Sentinel #1](https://github.com/jayyanez/rove-sentinel/pull/1).
Consumer migration is tracked in Rove's private repository; its source and evidence
remain private. No standalone release has been published yet.

**Owner:** @jayyanez, with implementation assisted by Codex.

## Problem and intended user

Rove's working review system is coupled to its repository layout, project rules,
installation paths, and development workflow. Developers of other projects
cannot install it as an independent tool.

The first release will let a developer on Windows run Rove Sentinel against
their own Git repository, using their own authenticated Claude Code and Codex
CLIs. Rove will then consume a released version of this same tool.

## Established baseline

The public repository contains the project introduction, Apache-2.0 license,
origin document, and roadmap. The operational engine remains inside Rove.

The original engine already includes committed-diff review, independent
adjudication, sharded coverage, follow-up reviews, finding dispositions,
commit-bound attestations, Git hooks, a local watcher, and GitHub comments.
Its existing regression tests are a migration starting point, not evidence
that the standalone package has been qualified.

## Release decisions

- Both Codex CLI and Claude Code must be installed and authenticated. Their
  default review configuration is enabled and required.
- Preserve the initial subscription-backed authentication contract: ChatGPT
  for Codex and a Claude subscription for Claude Code.
- Users authenticate through each provider's own tool and use their own plans.
- Windows is the first supported platform. Preserve portable code and existing
  macOS adapters, but do not claim live macOS or Linux support before testing.
- Distribute the project's original code under Apache-2.0. Do not redistribute
  provider binaries or private application code as part of the package.
- Rove keeps its application-specific rules and becomes a consumer of an exact
  released version, without copying the reusable engine back into its tree.
- Documentation, code, tests, commit messages, and GitHub artifacts are English.

## Non-goals

The first release does not add other agents, an API-only configuration, a
hosted multi-user service, a credential proxy, GitLab or GitHub Enterprise
integration, or a new website. Additional agents are future evaluations.

It does not promise defect-free code, substitute for deterministic tests, or
present local review records as tamper-proof server enforcement.

## Ordered work

### 1. Export and provenance

- [x] Export only the engine, necessary helpers, and approved tests from the
  original implementation into a clean source tree.
- [x] Replace project-specific examples and private fixtures with synthetic data.
- [x] Verify provenance and preserve applicable notices.
- [x] Scan the exact public export and any exported history for secrets and
  private source, reports, screenshots, logs, and personal data.

### 2. Package and project boundaries

- [x] Add a Node package manifest, explicit supported runtime, CLI entry point,
  lockfile, and plain Node test configuration.
- [x] Resolve executable and resource paths from the installed package.
- [x] Separate generic review behavior from project-specific prompts, risk
  rules, lessons, evidence validators, and lint configuration.
- [x] Define a versioned, validated configuration format and trusted policy
  installation/update flow.
- [x] Bind behavior-affecting configuration and provider profiles into review
  identity; a proposed PR must not approve its own weaker policy.
- [x] Preserve original regression coverage and add a clean-repository test
  that has no Rove directories or documents.

### 3. Providers and validation trust

- [x] Add clear prerequisite diagnostics for both CLIs, authentication methods,
  supported versions, model access, Git, and optional GitHub integration.
- [x] Preserve bounded calls, structured results, fresh review contexts,
  independent adjudication, billing protections, and honest failure reporting.
- [x] Keep provider adapters separate for future expansion without introducing
  additional provider support now.
- [x] Require explicit trust for PRs that can trigger executable validation, or
  run such validation in isolation without host credentials.
- [x] Make executable validation opt-in. The inherited Clippy target and timeout
  remain fixed in this release; arbitrary crate selection and configurable
  timeout/warm-up are deferred and documented in the support matrix.
- [x] Document data sent to model providers, retained locally, and published to
  GitHub; do not describe remote model inference as offline operation.

### 4. Windows integration

- [x] Install and remove hooks without silently replacing an existing hook setup.
- [x] Install a hidden watcher with a stable package path and clean lifecycle.
- [x] Validate scheduler task start, pause/resume, replacement and uninstall
  on Windows with both providers. Process recovery has regression coverage.
  A real logoff/logon cycle remains untested and is explicitly excluded from
  the live acceptance claim; do not interrupt a user session to simulate it.
- [x] Handle old state, policy versions, and watcher migration deliberately;
  prevent duplicate reviewers and incompatible attestation reuse.
- [x] Preserve the subprocess cleanup, hook stdin, multiple-ref and temporary
  resource regression suite. Live package installation used the Windows host
  documented in the validation record; other host/path combinations are not
  universally qualified.

### 5. Release and Rove adoption

- [x] Audit the locked dependency graph and generate license notices.
- [ ] Inspect the exact package contents before publication.
- [ ] Publish a versioned prerelease with working installation instructions,
  limitations, and verified platform/tool versions.
- [x] Track adoption in a dedicated Rove implementation PR, linked back to this
  public PR. Its private URL is retained in Rove; no private code is exported.
- [ ] Pin Rove to the release, preserve its project checks, and validate a real
  review and push using the external package.
- [ ] Remove the embedded reusable engine only after parity is established;
  retain a documented rollback path.

## Acceptance criteria

1. A clean Windows machine can follow the README, install the package, verify
   both provider logins, and review a synthetic Git repository with no Rove files.
2. A review cannot authorize another head, base, repository, or policy. Missing
   required review coverage and required adjudication cannot become a PASS.
3. Follow-up reviews, findings, permitted deferrals, hook enforcement, and
   recovery preserve their tested contracts.
4. An untrusted public PR cannot cause host-side execution of its build scripts
   or access host credentials through an executable validation lane.
5. Installation, scheduler start, replacement and uninstall are verified on
   Windows. The task uses the inherited hidden-console path. A real login
   cycle and every possible host configuration are not part of the observed
   acceptance claim.
6. The release package contains only approved source and assets, with an audited
   dependency inventory and correct licensing.
7. Rove consumes that exact version successfully; its application-specific
   verification and worktree checks remain in force.

## Dependencies, risks, and evidence

Implementation needs an approved source export from Rove, access to a Windows
host, both authenticated provider tools, and provider usage capacity. No extra
agent or website deployment is required for the first release.

Primary risks are changing exact-commit enforcement while extracting policy,
accidentally exporting private material, executing untrusted repository code,
changing billing behavior, and leaving duplicate or stale watchers installed.

Deterministic tests should use synthetic repositories and mocked provider
boundaries where appropriate. Live provider and scheduler acceptance must be
recorded separately; unit tests do not establish those behaviors.

macOS and Linux acceptance will be tracked separately when work on those
platforms is authorized and real test hosts are available.

## Next action

Complete hosted Windows CI, publish the reviewed release archive, and switch
Rove from its tested local candidate to that exact published asset.
Keep the owning PR in draft while implementation or required verification is
pending. Update this plan and the PR body as acceptance criteria are completed.
