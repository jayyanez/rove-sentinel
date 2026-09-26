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

To report a suspected vulnerability, use GitHub's private vulnerability reporting
for this repository when available. Do not disclose working credentials or
private code in a public issue. See [SECURITY.md](../SECURITY.md).
