# Troubleshooting

Start with `rove-sentinel doctor`, then `rove-sentinel status`. Keep the error,
engine version, OS, and exact base/head in a bug report; redact credentials,
private remote URLs, and private source excerpts.

| Symptom | What to check |
| --- | --- |
| A tool cannot launch | Open a fresh terminal; check each CLI's version and PATH |
| npm refuses the release URL with `EALLOWREMOTE` | npm 12 and later refuse a dependency given as a URL by default. Add `allow-remote=root` to the project's `.npmrc`, or pass `--allow-remote=root`, as in [installation](installation.md). pnpm and engine updates are not affected: an engine installs from a downloaded archive whose checksum it has verified |
| Authentication refused | Sign in through the provider(s) required by installed configuration; API-only authentication is insufficient |
| Policy missing or version mismatch | Reinstall from the trusted stable checkout after updating the dependency |
| Another checkout owns the watcher | Operate from that checkout; avoid competing watchers for the same remote |
| Push waits for review | Inspect watcher health, its current activity and the detached review log |
| Process cleanup failure pauses work | Investigate the recorded process and children; use `resume` if the watcher is healthy, or recover stale state before restarting |
| GUI evidence requested unexpectedly | Inspect the installed `guiEvidence` configuration; `none` turns the check off |
| Watcher stopped | `status` and `doctor` report `watcher.state`, and if it is `stopped`, why. A start replaces a lock by itself only when the machine booted after that lock's last heartbeat and its process is gone. A Windows shut down with Fast Startup may not count as a boot. For any other dead process's lock, inspect the state folder, then run `recover`, then `install` |
| `watcher.state` is `failing` | The watcher runs, but its last GitHub polls failed, so pull requests get no review; pushes still do. `watcher.reason` quotes the error. `spawn gh ENOENT` on macOS means a LaunchAgent without `gh` on its `PATH`: run `install` from a shell that finds it. Otherwise check `gh auth status` and the network. A poll that succeeds, or `install`, clears it. A computer that should leave pull requests alone installs with `--no-github` |
| `A replacement of the review daemon lock never finished` | A starter died while replacing a lock and left `takeover.lock` in the state folder. Confirm no Sentinel process is working there, delete that file, then run `recover`, then `install` |
| `update` fails behind a proxy, or in npm | An engine installs without your npm configuration, from the public registry, so a proxy or private registry in `.npmrc` is not read. The two steps differ. The npm install honours `HTTPS_PROXY`. The update check and the release download use Node's `fetch`, which ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set too, on Node 22.21 or later. Earlier Node 22 releases have no such setting, so those two steps need a direct connection. Set both for the account the watcher runs as |
| `update` to 1.16.0 fails with `EALLOWSCRIPTS` | The engine that downloads an update is the one running, and engines before 1.16.0 pass your npm configuration to its install. Run that one update with `npm_config_userconfig` pointing at an empty file, and with no `npm_config_allow_scripts` in its environment, which a package manager can set for what it runs. From 1.16.0 on it is not needed |
| `usage limit reached; retry after …` | A provider reported its subscription's usage limit. Under `auto` the review goes on with the other provider and says so (`providerFallback`); under `both`, `claude` or `codex` it fails until the time given. `status` lists the holds under `providerHolds`. After raising the allowance, `gate --force` tries the provider again. See [provider fallback](models.md#provider-failures-usage-limits-and-fallback) |
| `codex account "main" usage limit reached (retry after …); restarting this review with another codex account` | The review chose one of your [review accounts](models.md#accounts) for that provider, and it failed or reached its limit; the review restarted with the provider's next account. `status` lists each account's hold under `accounts`. If no other account is usable the provider is dropped as below |
| `Sentinel's accounts file is invalid: …` | Your per-user accounts file breaks a rule the message names (a label, a key, a relative folder). Fix it; reviews and `doctor` refuse it, and `status` shows the error under `accounts.error`. See [accounts](models.md#accounts) |
| `codex failed twice (…); restarting this review with claude only` | Under `auto`, a provider's work failed the round after its retry, so the review restarted once with the other provider; `providerFallback.reason` is `provider-failure`. The failing provider is held out of `auto` reviews for an hour, or until it completes work. If it keeps failing, run `doctor` and check that provider's CLI and sign-in; `gate --force` tries it again at once |
| Clippy timeout | Check the lane note and cold build cost; do not treat it as a passing Rust check |
| No GitHub PR comment | Check draft state, author allowlist, same-repository head, `gh` permissions, and that `watcher.state` is `running` |
| Hook no longer runs | Inspect `git config --get core.hooksPath` and the committed hook adapter |

## A shard reviewer failed and the gate failed closed

"N shard reviewer(s) failed after retry" means the only reviewer of some hunks
did not finish, so no PASS is possible. Rerun the gate: the shard reviews that
completed are kept for that exact base, head and policy for 24 hours, so the
rerun reviews only the failed shards (`--force` reviews everything again).

When the message says the same shard failed in consecutive runs, another rerun
alone is unlikely to pass. The error names the shard's files, its size in
parts and KB, its largest file, and the reviewer's own account:

- A timeout or a provider error: run `rove-sentinel doctor`, check that
  provider's CLI and sign-in, and try again later.
- "Truncated" or "blocked" reads: the account says which read. A reviewer
  reports its review incomplete for a shard part and for a required context
  read (charter, lessons, open briefs) alike, and the part-by-part retry
  gives every part reviewer the same context.
  - A shard part: a shard of several parts is already retried one part per
    reviewer, so a repeat means a single part could not be read whole. That
    is an engine limit a rerun does not change. Move the largest file named
    in the error into a change of its own so the rest of the branch can pass.
  - A required context read: every shard fails the same way and splitting the
    change does not help. Check that the installed charter and lessons are
    readable from the provider's sandbox.

  Either way, open an issue with the engine version, the retained report and
  the reviewer's account.

File size alone is not a reason to split code for Sentinel. From 1.12.0 a
shard is written in parts of at most 24 KB and a line longer than a part is cut
across parts; from 1.13.0 a shard of up to 96 KB, and the context with its
required reads, travel in the prompt instead of being read, and a follow-up
reviewer reads a prior blocker's file around the reported location instead of
whole. Earlier engines failed closed on a changed file over about 40 KB, a
changed line over about 2 KB, or a large prior-blocker file; a rule to split
files below those sizes was a workaround for them.

On Windows, per-repository records live under
`%LOCALAPPDATA%\Rove\shared-review-gate\<repository-hash>`. `status` reports the actual paths. Reports and context may contain
source code; do not upload that directory wholesale to a public issue.

Detached foreground logs are written under the repository's state folder, in
`logs/` (before 1.19.0, in the checkout's `output/` directory); `--log PATH`
names another file. A detached process launch is incomplete until its log ends
with an exit marker. A crashed or interrupted review is not a PASS.

Local hooks can be bypassed by someone controlling their machine. Emergency
bypass variables are retained for compatibility and are audited by exact SHA
and reason; they are not a normal troubleshooting remedy. Use independent GitHub
branch protection for server-side policy. Sentinel does not configure it for you.

`recover --reason "..."` is for stale watcher state and deliberately refuses to
clear a healthy watcher's lock. It does not clear a pause. After investigating
the original failure, use `resume` to clear the pause; restart or reinstall a
stopped watcher if necessary. Installation preserves an existing pause instead
of silently overriding an operator or cleanup safety decision.
