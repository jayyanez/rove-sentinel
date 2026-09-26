# Support and current limitations

| Surface | Current scope |
| --- | --- |
| Windows | First release target; release notes record the tested host and results |
| macOS | LaunchAgent and process adapters exist; live standalone qualification pending |
| Linux | Portable core exists; no supported scheduler integration or live qualification |
| Review providers | Claude Code and Codex, both installed and authenticated |
| Git host | Local Git; automatic PR comments for github.com |
| Branch convention | `origin/main` by default; explicit base supported for direct review |
| Inputs | Committed diffs; no review of uncommitted editor buffers |
| Languages | Text review is language-flexible; no guarantee of equal language quality |
| Deterministic tools | Markdownlint; opt-in Clippy for `src-tauri` |
| Visual evidence | Optional Rove format validation; no screenshot generation |
| External contributors | No automatic fork PR review; same-repository author allowlist |

The first release does not implement GitHub Copilot, OpenCode, Muse, Grok Build,
Gemini, or arbitrary provider plugins. The `grok` author label is routing
metadata, not a provider integration. There is no API-only configuration,
credential sharing service, web UI, IDE extension, GitLab/GitHub Enterprise
publisher, required GitHub status check, auto-merge, or hosted continuous service.

An AI reviewer can miss bugs, misunderstand a project, or report a false positive.
A PASS means the configured workflow completed under its rules, not that the
code is correct, secure, or ready to release. Run project tests and use human
judgment. A documentation skip is not a model review.

Context, file selection, process time, concurrency, and retention are bounded.
Large patches may be refused. Binary and designated generated artifacts are
excluded from textual review. Deterministic tool failures appear as notes;
check them before interpreting the report. Provider availability, subscription
limits and model changes can interrupt reviews. Runtime execution of the app
under review is not part of the normal review pipeline.

This initial extraction has substantial inherited regression coverage and
real use inside Rove. That is useful provenance, not an independent precision or
recall benchmark. Compatibility outside the qualified environment requires
evidence; please include a minimal reproduction when reporting an issue.
