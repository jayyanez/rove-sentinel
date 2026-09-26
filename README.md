# Rove Sentinel

**Independent AI code review, before you push.**

Rove Sentinel brings fresh Claude Code and Codex reviews into a local Git
workflow. It reviews a specific committed change, checks candidate findings
in a separate review context, and records the result against the exact commit
and review policy.

**Project status:** the public project is being established. The working
implementation currently lives inside Rove and is being prepared for extraction.
This repository does not yet contain an installable standalone release.

## Born in Rove

Rove Sentinel is already used in the development of **Rove**, an upcoming
desktop application built around a Mosaic Workspace. Its original,
repository-integrated review workflow has been used across **hundreds of Rove
pull requests**. This project gives that system an independent home so other
repositories can use it too.

Rove has not been publicly released. Its planned website is
`https://11kites.com/rove`; **the website is not live yet**.

See [Origin and real-world use](docs/origin.md) for the scope of the usage claim
and the relationship between the two projects.

## What the existing implementation provides

- Review of an exact Git diff, identified by repository, merge base, head
  commit, policy digest, and engine version.
- Fresh Claude Code and Codex contexts, with independent adjudication of
  candidate findings.
- Bounded review of large changes through diff shards, reference maps, and
  relevant history.
- Follow-up reviews that focus on repairs and recheck earlier blocking findings.
- Explicit handling of findings: fix, dismiss with evidence, or record an
  allowed deferral with a reason.
- A local pre-push hook, review watcher, and GitHub pull-request status comments.
- Bounded subprocesses, timeouts, retained reports, and recovery operations.

These capabilities describe the system operating inside Rove. Their standalone
packaging and public-repository defaults still need validation. AI review
complements tests and human judgment; it does not prove correctness or replace
branch protection.

## Requirements for the first release

The default configuration will require **both**:

1. **OpenAI Codex CLI**, installed separately and authenticated with ChatGPT.
2. **Anthropic Claude Code**, installed separately and authenticated with a
   Claude subscription.

Both tools must be available on the same machine. The Claude Code + Codex
configuration will be enabled by default and required for the first release.
Each user supplies their own accounts; usage remains subject to their provider
plans, model availability, and limits. Rove Sentinel does not include provider
subscriptions, collect provider login credentials, or redistribute their tools.

Node.js and Git will also be required. The GitHub integration requires GitHub
CLI (`gh`) authenticated for the target repository. Exact supported tool
versions and installation instructions will accompany the first release.

The current engine selects reviewers by change risk and author family; requiring
both tools does not mean every individual review invokes both providers.

GitHub Copilot, OpenCode, Muse, Grok Build, and other agents may be evaluated
later. They are **not currently supported** or promised integrations.

## Platform direction

| Platform | Initial release scope |
| --- | --- |
| Windows | First supported platform, after standalone validation |
| macOS | Existing platform-specific code; live standalone validation pending |
| Linux | Portable core; platform integration and validation pending |

The goal is cross-platform operation. A Windows-first release will not imply
that macOS or Linux has been qualified.

## Development status

See the [roadmap](ROADMAP.md). Extraction must preserve Rove's working review
behavior while separating project policy from the reusable engine. Automatic
review of untrusted public pull requests needs an explicit execution trust
boundary before release.

No package has been published by this project yet. There is no installation
command to run at this stage.

## License

This project's original material is licensed under [Apache-2.0](LICENSE).
Third-party tools and services retain their own licenses and terms. This license
does not license the Rove application or grant access to Claude or OpenAI services.

Rove Sentinel is an independent project and is not affiliated with or endorsed
by Anthropic, OpenAI, GitHub, or the providers of possible future integrations.
