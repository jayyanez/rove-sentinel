# Configuration

Configuration is optional. Defaults work without any Rove source or documents.
Create `.rove-sentinel.json` at your repository root with `rove-sentinel init`.

```json
{
  "schemaVersion": 1,
  "charter": null,
  "lessons": null,
  "guiEvidence": "none",
  "clippy": false,
  "trustedAuthors": []
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `charter` | Repository-relative Markdown policy; `null` uses the bundled charter |
| `lessons` | Repository-relative project lessons; `null` supplies no project lessons |
| `guiEvidence` | `none` by default; `rove` enables the Rove visual-evidence contract |
| `clippy` | Opt into executing Cargo Clippy for changed Rust files under `src-tauri` |
| `trustedAuthors` | GitHub logins allowed for automatic same-repository PR review; empty means the repository owner |

Paths use forward slashes and cannot be absolute or contain `..`. Unknown keys
and invalid values are refused. A custom charter replaces the bundled prose;
it cannot override executable blocking rules. Custom charter and lessons files
are high-risk review inputs, even though they are Markdown.

Run `install` from your trusted stable checkout after approving configuration
or policy changes. Review uses the installed snapshot, including configuration,
not the version proposed by the branch being reviewed. Its digest is part of
each attestation. Commit configuration and policy alongside the project.

## Optional Rove compatibility

Rove selects its own charter and lessons, enables `guiEvidence: "rove"`, and
can enable the existing Clippy lane. The GUI validator expects the Rove
`docs/design/reviews/<branch-slug>/` format, actual PNG evidence, review documents,
and `docs/design/control-registry.md` rows for new `data-control` identifiers.
It validates evidence structure; it does not take screenshots or replace a human
visual review. Generic users do not need these directories.

Clippy currently targets `src-tauri/Cargo.toml`, uses a shared target cache,
and has an eight-minute bound. It can execute build scripts and access the
host environment. Enable it only for code you trust to build locally. Large
cold native dependency builds can time out repeatedly; a timeout is a visible
lane note, not proof that Rust passed. Arbitrary crate paths and custom command
lanes are not configurable in this release.

## Fixed first-release choices

Claude Code and Codex are required. Provider routing, model identifiers,
concurrency, timeouts, and convergence budgets are versioned in
`scripts/review-gate/constants.mjs`; arbitrary provider plugins and model
configuration are not public extension points yet. Do not set API keys to work
around an unsupported account: normal subscription runs scrub inherited API
credentials, and installed watchers explicitly discard the billing override.

The default base is `origin/main`. Use `gate --base <ref>` for an explicit
foreground target. The pre-push workflow currently assumes the remote's `main`
branch for new branches; projects with a different primary branch need an
adapter change before adopting the hook.
