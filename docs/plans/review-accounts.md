# Review accounts: several logins of one provider CLI

Status: implemented and verified with the deterministic suite; not yet
reviewed, released or exercised against live CLIs signed in to several
accounts. It builds on the [provider fallback](provider-usage-limit-fallback.md)
and is stacked on it.

The owner's requirement: a user may have several accounts (subscriptions) of
the same CLI, and Sentinel should know them and choose among them. Code an
agent wrote under one Claude account should, when Codex is unavailable, be
reviewed under another Claude account, not the author's; and a usage limit
should move the review to another account of that provider before the
provider is dropped.

## Research

Searched: Codex's own source and documentation for how it selects its home
folder and stores a login, `codex --help` and `codex login --help` (Codex CLI
0.159.0), Claude Code's documentation of its environment variables and its
status line, and Codex's app-server protocol for a way to read the remaining
allowance. Nothing was run against an account.

### How each CLI selects an account

- **Claude Code: `CLAUDE_CONFIG_DIR`.** Its
  [environment variable reference](https://code.claude.com/docs/en/env-vars)
  says: "Override the configuration directory (default: `~/.claude`). All
  settings, session history, and plugins are stored under this path. … Useful
  for running multiple accounts side by side: for example,
  `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`." Where the
  credentials live (a file under that folder, or the macOS keychain) is the
  CLI's business; Sentinel never reads them. The same page notes that
  `CLAUDE_CODE_OAUTH_TOKEN` "takes precedence over keychain-stored
  credentials": an inherited token overrides the account folder, and so
  does `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, documented beside it as another
  alternative to `/login` (see [security](#security)).
- **Codex: `CODEX_HOME`, verified.** Its documentation
  ([advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
  formerly `developers.openai.com/codex/config-advanced`) says "Codex stores
  its local state under `CODEX_HOME` (defaults to `~/.codex`)", and lists
  `auth.json` "(if you use file-based credential storage) or your OS
  keychain/keyring" among that state. The open-source CLI confirms it
  (`openai/codex`, `main` at `e428b9a`, read through the GitHub API on
  2026-11-06): `codex-rs/utils/home-dir/src/lib.rs` (`find_codex_home`) reads
  `CODEX_HOME`, ignores it when empty, requires it to exist and be a
  directory, and canonicalizes it; unset, it is `~/.codex`.
  `codex-rs/login/src/auth/storage.rs` keeps the login in
  `$CODEX_HOME/auth.json`, or in the keyring under a key computed from the
  canonical `CODEX_HOME` path, so each home is its own login either way.
  `codex --help` and `codex login --help` do not mention the variable.
  Codex's `load_auth` (`codex-rs/login/src/auth/manager.rs`) reads
  `CODEX_API_KEY` (where the API-key variable is enabled, as in `codex exec`)
  and `CODEX_ACCESS_TOKEN` before the login stored under `CODEX_HOME`. Its
  [authentication page](https://learn.chatgpt.com/docs/auth) shows
  `CODEX_ACCESS_TOKEN` only as the input of `codex login --with-access-token`
  and does not document that precedence; the source does.

### Whether either CLI exposes the remaining allowance

Neither offers a documented, supported, non-interactive way for another
program to read how much of a subscription's allowance is left before it
starts work:

- Claude Code gives `rate_limits` (5-hour and 7-day `used_percentage` and
  `resets_at`) only to a [status line](https://code.claude.com/docs/en/statusline)
  script of an interactive session, "only after the first API response in the
  session". There is no command that prints it.
- Codex's app-server protocol has an `account/rateLimits/read` request and an
  `account/rateLimits/updated` notification
  (`codex-rs/app-server-protocol/src/protocol/v2/account.rs`), but
  `codex app-server` is marked `[experimental]` in `codex --help`, and using
  it would mean running a JSON-RPC session per account just to ask.

So, as the owner required, Sentinel scrapes nothing. It ranks accounts by
what it knows itself: an account with no hold first, then the one used least
recently. If a provider later documents a supported interface, ranking by
the allowance left can replace the rotation inside `rankAccounts`.

## Intended behaviour

1. **Nothing configured is today's review.** Without an accounts file, or with
   one that declares no account for a provider, that provider runs under the
   login the process inherits, is held per provider, and falls back exactly as
   in the provider fallback plan. No account field appears anywhere, and no
   account state is written.
2. **Configuration.** The user declares accounts per provider in a per-user,
   machine-local JSON file, never in the committed `.rove-sentinel.json` and
   never in the policy digest:

   ```json
   {
     "schemaVersion": 1,
     "accounts": {
       "claude": [
         { "label": "personal", "configDir": "<absolute path of a CLAUDE_CONFIG_DIR>" },
         { "label": "team", "configDir": "<absolute path of another one>" }
       ],
       "codex": [
         { "label": "main", "home": "<absolute path of a CODEX_HOME>" }
       ]
     }
   }
   ```

   The file is found, in order: the `--accounts <file>` flag (`gate`,
   `status`, `doctor`); the `ROVE_SENTINEL_ACCOUNTS` variable; the default,
   `accounts.json` beside the per-repository state folders:
   `%LOCALAPPDATA%\Rove\shared-review-gate\accounts.json` on Windows,
   `~/Library/Application Support/Rove/shared-review-gate/accounts.json` on
   macOS, `$XDG_STATE_HOME/rove/shared-review-gate/accounts.json` (or
   `~/.local/state/…`) elsewhere. A file named by the flag or the variable must
   exist; the default one may be absent. The file is validated strictly: only
   `schemaVersion` (1) and `accounts`; only `claude` and `codex`; at most 8
   accounts each; each entry exactly `label` and `configDir` (Claude) or
   `home` (Codex); a label of 1 to 32 letters, digits, `.`, `_` or `-`,
   unique per provider ignoring case; an absolute folder, two labels never
   naming the same folder. An error names the provider, entry and label,
   never a folder. `install` (`--accounts` too) checks the prerequisites
   with the accounts, as `doctor` does. The watcher reads, for each review,
   the file its installation named: `install` records a file named by the
   flag or the variable in `watcher-accounts.json` in the state folder (and
   removes the record when none was named), writes it as
   `ROVE_SENTINEL_ACCOUNTS` into the Windows task's wrapper (cleared there
   when none was named) and the macOS LaunchAgent, and every detached start
   (an install without a scheduler, the push hook, an install's rollback)
   takes it from that record through one helper, `detachedStartEnvironment`,
   over whatever the starting shell names. A rollback restores the previous
   installation's record before it restarts that watcher, so the restored
   watcher reads the file it read before; with no record, that installation
   named none and the default is right. The path stays in local state, a
   scheduler artifact or a process environment.
3. **The author's account.** The author's provider is the `--author` or the
   branch prefix, as before. The author's account is the `CLAUDE_CONFIG_DIR`
   or `CODEX_HOME` of the process that asks for the review (the shell that
   runs `gate`, or the hook that queues a request), the CLI's default folder
   when it is unset. It is matched against the configured folders by a digest
   of the normalized path (resolved, links followed when the folder exists,
   case-folded on Windows). A request queued for the watcher carries these
   digests (`requesterAccounts`), never a path; the watcher's own environment
   is not the author's. A review whose requester is not known (a pull request
   the watcher found on GitHub) excludes no account and records
   `authorOwn: null`. Only the author's provider is affected: a `human` or
   `grok` author has no account to exclude.
4. **Choosing the reviewers' accounts**, for each provider the review uses:
   1. The provider set is chosen as before: under `auto` the other provider
      than the author's leads, as author routing always did.
   2. Of that provider's accounts, the review leaves out any it already fell
      back from, any not signed in, and any held for its usage limit. It ranks
      the rest: accounts other than the author's with no hold; then the
      author's own account (the owner's decision: the last resort, used and
      said, never silent); then accounts held for a failure; within a rank,
      the least recently used, then the file's order. The first is used, for
      every role of that provider in the round, and its last use recorded.
   3. A provider with accounts is held, for the provider selection of the
      fallback plan, only when every account it may still use is held: for its
      usage limit when all of them are, otherwise for a failure, until the
      soonest retry time. A provider-wide hold from before its accounts were
      configured is not read.
5. **Holds per account.** A usage limit, or a failure the review falls back
   from, is recorded for the account that met it, in `account-state.json` in
   the repository's state folder, by provider and label, with the same record
   and expiry as a provider hold. An account that completes work in a round
   has its hold removed. `gate --force` ignores the account holds, as it does
   the provider holds.
6. **Restarts.** When a round fails closed under the fallback plan's rule
   (every failure a provider's, no veto), each failed provider is handled:
   - if it reviewed under an account and another account of it is usable, the
     account is held, left out for the rest of the review, and the review
     restarts from scratch with that provider's next account. This happens
     under every requirement, `both`, `claude` and `codex` included: they
     never switch provider, but switching account within the required
     provider is allowed, and recorded;
   - otherwise the provider is dropped as in the fallback plan: under `auto`
     only, once, and only while another provider remains.
   Every restart reviews the base, head and branch the first round resolved,
   never what `HEAD` or the base names by then; this holds for the fallback
   plan's provider restart too. A round that needs to drop a provider it may
   not drop fails closed. Safety
   stops (a process-tree cleanup failure, the launch fence, a lane, an error
   that is not a provider's, the round's veto) never restart.
7. **Evidence.** Every report, attestation, GitHub summary and comment, and
   text result of a review that used accounts carries, by label only:
   `accounts` (per provider, the label used, and for the author's provider
   `authorOwn`: `true`, `false`, or `null` when unknown) and `accountFallbacks`
   (each switch: `provider`, `from`, `to`, `reason`, `resetAt`,
   `retryAfter`). Each `providerExecutions` record names its `account`. The
   text result and the comment say, for example,
   `Account fallback: codex account "main" left out after its usage limit (retry after …); the review restarted from scratch with "spare".`
   and
   `Author's account: claude reviewed under the author's own account "personal"; no other claude account was usable.`
   Progress says `codex account "main" usage limit reached (retry after …); restarting this review with another codex account.`
8. **Status and doctor.** `status` lists `accounts`: each label, whether it is
   signed in (probed with that account's folder only), its live hold and its
   last review; an unreadable accounts file is reported as `accounts.error`.
   `doctor` and `install` probe every configured account, those of a
   provider the requirement leaves out included, and list the sign-ins under
   `accounts` (the required providers' also under `providers.accounts`);
   `doctor` prints the account holds and returns them as `accountHolds`.
   The probes of every account and provider are all awaited before a
   process-tree cleanup failure among them is raised. An unreadable account
   state reads as empty.

## Bounds

Every restart leaves out one more account of a failed provider, or drops a
provider. A review therefore runs at most one round per configured account
that fails, plus the fallback plan's single provider restart: at most
`accounts + 2` rounds, where `accounts` is the number of configured accounts
(at most 8 per provider, so 18). A guard stops the loop past that bound in
any case. Each round keeps the fallback plan's per-call bounds: one technical
retry, no retry after a usage limit, and no further provider work in a round
after a usage limit.

## Security

- Each reviewer process gets the subscription environment of today with one
  change: its provider's variable (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) set to
  the chosen account's folder. No other authentication variable is touched;
  inherited API keys are still removed.
- A credential variable that overrides the folder would make a recorded label
  name the wrong account. With accounts configured for a provider, its
  variables (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`;
  `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`) refuse the review before any provider
  work, naming the variable and never its value, and an account probed with
  one set does not count as signed in. Without accounts nothing changes.
- Sentinel never opens, copies or logs anything inside an account folder. It
  runs the CLI's own `auth status` / `login status` with the folder set, as
  the subscription probe always did.
- Folders stay on the machine: in the user's accounts file and in a reviewer
  process's environment. Requests carry digests, the account state is keyed by
  label, and reports, attestations, comments, progress and error messages name
  labels only. The policy digest does not change: the accounts file is not
  policy, and a review under another account of the same provider is the same
  review.

## Acceptance

1. Configuration: a valid file parsed; each refusal (unknown keys at every
   level, another schema, too many accounts, a bad or duplicate label, a
   relative or missing folder, one folder under two labels) without quoting a
   folder; the default place absent is no accounts, a named file must exist.
2. Nothing configured: the fallback plan's usage-limit review gives the same
   result, holds and progress, with no account field and no account state; a
   provider without accounts is probed with the inherited environment.
3. The author's account: excluded while another is usable; the default folder
   when the variable is unset; matched across a trailing separator and, on
   Windows, letter case; used as the last resort and recorded as such in the
   progress, the report, the attestation, the text result and the comment;
   `null` when the requester is unknown; a malformed identity refused.
4. Ranking: no hold before a failure hold, a usage limit never; least recently
   used first; excluded and signed-out accounts left out.
5. Restarts: a usage limit and a failure each move to the next account before
   the provider is dropped; when none remains, the provider is dropped once
   under `auto`; an explicit requirement switches accounts and never the
   provider, and fails closed when no account remains; every account held for
   its usage limit refuses an explicit requirement.
6. Each reviewer environment carries only its own account's folder; the
   execution record names the label.
7. No folder appears in a report, an attestation, a text result, a comment,
   the account state or a queued request, which carries the author's account
   as digests.
8. `pnpm verify` passes. Live acceptance is still owed: two signed-in accounts
   of each CLI, a review that switches between them, and `status` and `doctor`
   listing them.
9. The first commit's gate review, each with a regression: a corrupt account
   state reads as empty, under `--force` too; `install` verifies with the
   accounts file and gives the scheduled watcher a file named explicitly, and
   nothing for the default one; every account probe is awaited before a
   cleanup failure is raised; a provider restart and an account restart review
   the commit the first round resolved after `HEAD` moved; an overriding
   credential variable refuses a review with accounts, and changes nothing
   without them; `doctor` lists the accounts of a provider the requirement
   leaves out.
10. The second gate review, each with a regression: `doctor` and `install`
   await every prerequisite probe (provider, account, Git, GitHub) before a
   cleanup failure is raised; a watcher started without a scheduler gets an
   explicitly named accounts file in its environment; an overriding
   credential refuses only a provider the requirement can use, so a `codex`
   requirement ignores Claude's accounts and token.
11. The third gate review, with a regression: a rolled-back install restarts
   the previous watcher with the accounts file that installation recorded
   (or none), and every detached start takes its file from the record alone.
