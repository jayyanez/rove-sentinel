# Rove Sentinel

**A second look at your code, before you push.**

Rove Sentinel reviews a committed Git change using your own **Claude Code and/or
Codex** accounts. It checks candidate findings in fresh review contexts, records
the result against the exact commit and project policy, and helps your Git hook
decide whether that change is ready to push.

**Windows-first.** Start with the [installation guide](docs/installation.md).
[GitHub Releases](https://github.com/jayyanez/rove-sentinel/releases) is the
source of truth for published versions and downloadable archives.
See the [validation record](docs/validation.md) for what was tested.

## Start here

| You want to… | Read this |
| --- | --- |
| Install Sentinel in your project | [Installation guide](docs/installation.md) |
| Run your first review and handle findings | [Usage guide](docs/usage.md) |
| Understand automatic updates | [Update guide](docs/updates.md) |
| Use Sentinel across agents and projects | [Multiple projects](docs/multiple-projects.md) |
| Understand requirements and limitations | [Support matrix](docs/support.md) |
| Choose models, effort and subscriptions | [Models guide](docs/models.md) |
| Add your project's review rules | [Configuration](docs/configuration.md) |
| Understand how the review works | [Architecture](docs/architecture.md) |
| Compare its scope with CodeRabbit or Greptile | [Comparison](docs/comparison.md) |
| Fix a setup problem | [Troubleshooting](docs/troubleshooting.md) |
| Help build Sentinel | [Contributing](CONTRIBUTING.md) |

## What a review looks like

After installation, run your tests and commit your change:

```powershell
npx --no-install rove-sentinel gate --base origin/main --head HEAD --author human
```

Sentinel prepares the committed diff and relevant repository context, reviews
it in bounded pieces, verifies proposed findings, and reports its decision.
Fix a finding, commit the repair, and review again. The pre-push hook checks
the exact pushed commit; an earlier PASS cannot authorize a later edit.

The tool can also run a local watcher that reviews eligible GitHub PRs and
posts status comments. It does not merge PRs or replace GitHub branch protection.

## What you need

- Windows for the first supported release; macOS and Linux qualification is pending.
- Node.js 22+, Git, and authenticated GitHub CLI (`gh`).
- **At least one of Claude Code or Codex CLI**, separately installed and on PATH.
- Claude Code authenticated through a Claude subscription; Codex through ChatGPT.
- Your own provider allowances and access to the configured models.

Automatic provider selection is enabled by default. With one subscription,
Sentinel keeps separate review contexts and records the reduced model diversity.
Defaults are GPT-6.1 Sol and Claude Opus 5.5 at high effort; users can change
models, efforts and provider requirements in [configuration](docs/models.md).
Sentinel does not include subscriptions or provider binaries. Source context is
sent through your CLIs to their AI providers; local orchestration is not offline
inference. Read the [trust boundaries](docs/security.md).

## What it does today

- Reviews exact commits with project policy frozen at installation.
- Separates candidate findings from their adjudication.
- Uses diff shards, bounded history and reference maps for context.
- Rechecks blockers and focuses follow-up reviews on repairs.
- Records explicit permitted deferrals rather than silently dropping findings.
- Integrates with local Git hooks and an optional GitHub PR watcher.
- Bounds processes, queues, timeouts and retained reports.

AI review can miss bugs or report false positives. Keep your tests and human
judgment. Sentinel currently has no hosted service, IDE extension, automatic
fork-PR review, or public provider-plugin API. Copilot, OpenCode, Muse, Grok
Build and other agents are possible future work, not implemented integrations.

## Born in Rove

Sentinel grew out of **Rove**, an upcoming desktop application built around a
Mosaic Workspace. The original integrated review workflow has been used across
**hundreds of Rove pull requests**. This independent project makes the engine
available for other developers to inspect, use and improve.

Rove has not been publicly released. Its planned website is
`https://11kites.com/rove`; **the website is not live yet**.
See [origin and real-world use](docs/origin.md) for the scope of the usage claim.

## License

Original code and documentation are [Apache-2.0](LICENSE).
[Dependency notices](THIRD_PARTY_NOTICES.txt) retain third-party attribution;
external tools and services have their own licenses and terms. This license
does not license the Rove application or grant access to AI services.

Rove Sentinel is independent and is not affiliated with or endorsed by
Anthropic, OpenAI, GitHub, CodeRabbit, or Greptile.
