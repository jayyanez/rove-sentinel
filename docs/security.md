# Trust and data boundaries

Sentinel runs under your OS account. It is not an OS sandbox. It invokes your
installed Claude Code and Codex tools in restricted review modes and controls
their lifecycle, but their correctness, platform sandbox behavior, and account
permissions remain part of the trust boundary.

Selected source, diffs, history and project rules are sent to the AI providers
through your authenticated CLIs. "Local orchestration" does not mean offline
inference or that source stays exclusively on your machine. Consult the terms
and data controls for your own provider accounts.

Repository content is untrusted reviewer input. Instructions inside a proposed
change cannot replace the installed policy. Review records include the exact
commit and policy digest; they are local evidence, not cryptographic proof to a
remote server. A user controlling local files or Git configuration can bypass a
local hook. Use independent server-side controls where required.

A [local installation](installation.md#install-without-changing-the-repository)
puts its hook in Git's own hooks folder, which the repository's commits cannot
change, and the hook calls a Sentinel installed outside the repository by its
path: `install --local` refuses a launcher inside the repository it reviews, so a
branch cannot replace its own reviewer. Its configuration file is outside the
repository too, and like any installed policy it is frozen at installation. The
hook is invisible to the rest of the team, and no server-side control knows of
it.

Automatic PR discovery excludes forks and requires an allowed author with a
same-repository head. This reduces unsolicited usage and exposure; it does not
make every allowed commit safe. Manual reviews are an explicit trust decision.
Do not run unknown code on a sensitive workstation to test a contribution.
Clippy is off by default because Cargo can execute project build scripts with
host access. Installing dependencies can also execute third-party install scripts.

Reports and temporary review context can contain private code. Retention and
cleanup are bounded but do not constitute secure erasure. Keep machine access
and filesystem permissions appropriate to your repositories. Never commit
provider tokens or upload complete local state as a public debugging artifact.

Review [accounts](models.md#accounts) are paths on your machine. Sentinel keeps
them in your per-user accounts file and sets the chosen one, as
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, only in that provider's reviewer process.
It never reads, copies or logs anything inside an account folder; it runs the
CLI's own sign-in status with the folder set. A request queued for the watcher
carries a digest of the author's folder, and reports, attestations, comments
and logs name accounts by label only. A credential variable that overrides
the folder (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`,
`CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`) refuses a review that would use that
provider's accounts, so a label never names the wrong account. `install`
writes a named accounts file's path into the local scheduled watcher, never
into a report.

To report a suspected vulnerability, use GitHub's private vulnerability reporting
for this repository when available. Do not disclose working credentials or
private code in a public issue. See [SECURITY.md](../SECURITY.md).
