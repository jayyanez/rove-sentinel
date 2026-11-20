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
| Process cleanup failure pauses work | Run `npx --no-install rove-sentinel repair` and follow what it prints ([runbook](#runbook-for-agents)) |
| GUI evidence requested unexpectedly | Inspect the installed `guiEvidence` configuration; `none` turns the check off |
| Watcher stopped | `status` and `doctor` report `watcher.state`, and if it is `stopped`, why. A start replaces a lock by itself only when the machine booted after that lock's last heartbeat and its process is gone. A Windows shut down with Fast Startup may not count as a boot. For any other dead process's lock, run `npx --no-install rove-sentinel repair` |
| `watcher.state` is `failing` | The watcher runs, but its last GitHub polls failed, so pull requests get no review; pushes still do. `watcher.reason` quotes the error. `spawn gh ENOENT` on macOS means a LaunchAgent without `gh` on its `PATH`: run `install` from a shell that finds it. Otherwise check `gh auth status` and the network. A poll that succeeds, or `install`, clears it. A computer that should leave pull requests alone installs with `--no-github` |
| `A replacement of the review daemon lock never finished` | A starter died while replacing a lock and left `takeover.lock` in the state folder. Run `npx --no-install rove-sentinel repair`: a replacement lasts milliseconds, so it removes a marker over a minute old |
| `update` fails behind a proxy, or in npm | An engine installs without your npm configuration, from the public registry, so a proxy or private registry in `.npmrc` is not read. The two steps differ. The npm install honours `HTTPS_PROXY`. The update check and the release download use Node's `fetch`, which ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set too, on Node 22.21 or later. Earlier Node 22 releases have no such setting, so those two steps need a direct connection. Set both for the account the watcher runs as |
| `update` to 1.16.0 fails with `EALLOWSCRIPTS` | The engine that downloads an update is the one running, and engines before 1.16.0 pass your npm configuration to its install. Run that one update with `npm_config_userconfig` pointing at an empty file, and with no `npm_config_allow_scripts` in its environment, which a package manager can set for what it runs. From 1.16.0 on it is not needed |
| `… is downloaded … but cannot activate` | Run `npx --no-install rove-sentinel repair` and follow what it prints ([runbook](#runbook-for-agents)) |
| `Runtime storage is full: every installed version (…) is active or pending …` | Run `npx --no-install rove-sentinel repair` (with automatic updates on): it retries the update, and when the retry finds the store still full it lists the projects and running Sentinel processes that hold every slot ([runbook](#runbook-for-agents)) |
| `usage limit reached; retry after …` | A provider reported its subscription's usage limit. Under `auto` the review goes on with the other provider and says so (`providerFallback`); under `both`, `claude` or `codex` it fails until the time given. `status` lists the holds under `providerHolds`. After raising the allowance, `gate --force` tries the provider again. See [provider fallback](models.md#provider-failures-usage-limits-and-fallback) |
| `codex account "main" usage limit reached (retry after …); restarting this review with another codex account` | The review chose one of your [review accounts](models.md#accounts) for that provider, and it failed or reached its limit; the review restarted with the provider's next account. `status` lists each account's hold under `accounts`. If no other account is usable the provider is dropped as below |
| `Sentinel's accounts file is invalid: …` | Your per-user accounts file breaks a rule the message names (a label, a key, a relative folder). Fix it; reviews and `doctor` refuse it, and `status` shows the error under `accounts.error`. See [accounts](models.md#accounts) |
| `codex failed twice (…); restarting this review with claude only` | Under `auto`, a provider's work failed the round after its retry, so the review restarted once with the other provider; `providerFallback.reason` is `provider-failure`. The failing provider is held out of `auto` reviews for an hour, or until it completes work. If it keeps failing, run `doctor` and check that provider's CLI and sign-in; `gate --force` tries it again at once |
| Clippy timeout | Check the lane note and cold build cost; do not treat it as a passing Rust check |
| No GitHub PR comment | Check draft state, author allowlist, same-repository head, `gh` permissions, and that `watcher.state` is `running` |
| Hook no longer runs | Inspect `git config --get core.hooksPath` and the committed hook adapter |

## Runbook for agents

Any Sentinel line that ends with `Run: npx --no-install rove-sentinel repair`
means: run that command in the repository, then do what its output says. It is
safe to run at any time: it acts only after the checks below pass, and records
every action, with its evidence, in the repository's events. `--dry-run` shows
what it would do; `--json` gives the same report as data.

`repair` prints one line per state it found: `fixed`, `busy`, `ok`,
`would-fix` (dry run) or `blocked`, and for anything not fixed a `Next:` line
with the exact command. Run that command; when it is `repair` again, run it
again after the time it names. Exit code 0 means every state is fixed or fine;
1 means a `Next:` line waits. One repair runs at a time per repository. A pause
records who set it (from 1.20.1): repair lifts a safety pause or an update's,
never one a person set with `rove-sentinel pause`, whatever its reason says.

| Sentinel says | What `repair` checks | What it does | When it stops, the `Next:` line says |
| --- | --- | --- | --- |
| `Provider process-tree cleanup could not be verified` or `Windows provider parent exited before inherited pipes closed` (a safety pause, also from engines before 1.20.1) | Lists every process of this OS user. A process counts as this repository's review when its command line names a Sentinel review directory (`rove-review-…`) whose owner record names this repository and whose owner runs no review now, or it is, or is a child of, the provider recorded in the pause and started before it, or it descends from one of those. A process naming a review directory with no owner record cannot be traced to any repository: it is listed, never counted or stopped | Resumes when none is counted, while the pause is still the one it read | `npx --no-install rove-sentinel repair --stop-orphans`, with each counted process listed (PID, name, start time, command line). That command stops those processes only, each only while its PID still has the start time it was listed with, then resumes |
| A pause with any other reason (`rove-sentinel pause`) | Nothing: a person set it | Never lifts it | `npx --no-install rove-sentinel resume`, to run only if the person who asked for the repair asked to lift that pause |
| `Automatic Sentinel update to …` (a pause), or `an earlier activation was interrupted` | Whether the process that wrote `update-in-progress.json` still runs (its PID, and its start time on Windows) | While it runs, nothing. Once it is gone: when `update-recovery.json` belongs to that fence, stops any watcher, restores the policy and engine it records, reinstalls with that engine, verifies its watcher, removes the fence and the update's pause, then retries the update. When the journal is an earlier update's, the activation stopped before it changed anything, and only the fence is removed | `repair` again in five minutes while the activation runs; the error, if the rollback failed |
| `Review daemon lock belongs to dead PID …`, `the review watcher is not running`, `The review watcher is stopped` | Whether the lock's PID is gone, or now belongs to a process started after the lock was written (a reused PID) | Clears the stale state as `recover` does, then starts the watcher the way install does (on Windows its scheduled task) and waits for its heartbeat | `repair --stop-orphans` when the lock's process is this repository's watcher (`watch --daemon --repo <checkout>`) and has given no heartbeat for 30 seconds; that command stops it, then recovers and starts it. The install command, when no watcher is installed |
| `the review watcher runs another engine or policy` | Whether a review runs | Restarts it with `install --preserve-policy`, which keeps the installed policy | `repair` again in ten minutes while a review runs; `repair` in the watcher's own checkout when it runs from another one |
| `the review queue is locked` | Whether the submission lock's PID runs | Removes the lock if it is unchanged since it was read | — |
| `Another Sentinel process (PID …) holds …download.lock` | Whether the lock's owner runs, with the start time it recorded (1.20.1 and later) | Removes the lock, and the staging folder only its owner can have created, when the owner is gone; every download does the same | `repair` again in 15 minutes while its owner installs |
| `… could not be downloaded …`, `could not activate the update`, `is downloaded … It will activate after current reviews finish` with no hold | That nothing above holds the update | Retries it now (`update`) | `Runtime storage is full`: the projects whose records hold every slot, and running Sentinel processes (PID, version); run `repair` in each project listed, or again after the processes listed exit. Otherwise `repair` again in ten minutes |
| `A replacement of the review daemon lock never finished` | The age of `takeover.lock`; a replacement lasts milliseconds | Removes it when it is over a minute old, as the watcher's start already reads it as abandoned | `repair` again in one minute |
| `cannot read the update settings`, or a record that cannot be read | Which record | Removes a record that only counts (`github-failure.json`); treats an unreadable watcher lock or update fence as gone after ten minutes | The install command for an unreadable installed policy; `resume` for an unreadable pause record |

`recover` now starts the watcher after clearing its state, and `resume` starts a
watcher that is not running; both report the result under `watcher`.

### Which engine runs `repair`

From 1.20.1 the launcher runs `repair` on the newest engine at hand: its own,
the repository's active engine, or a verified copy in the shared engine store,
and never one older than the active engine, which it repairs. A repair on a
newer engine judges the watcher against the engine the repository selects, and
runs the update through the repository's own command (a local installation's
recorded launcher), on that engine. When that engine's last download failed on a
full store and its release is still missing, repair first frees a slot as a
1.20.1 download would, since an older engine cannot.

### Repair on an engine before 1.20.1

For a local installation (`install --local`), whose launcher is outside the
repository, run that launcher instead of `npx --no-install rove-sentinel`:
`status` gives the Node and the launcher the installation recorded as
`installation.node` and `installation.launcher`. In PowerShell the command is
`& '<installation.node>' '<installation.launcher>' repair --repo '<repository>'`;
on macOS, `'<installation.node>' '<installation.launcher>' repair --repo '<repository>'`.
Single quotes keep each path literal. Inside them, write each `'` in a path as
`''` in PowerShell, and as `'\''` on macOS.

A repository whose active engine predates 1.20.1 (its launcher pinned earlier
and its update blocked) answers `repair` with `Unknown review-gate command:
repair`. Then run this line in the repository, in PowerShell, Windows PowerShell
or a macOS shell alike. It needs only Node, which npx needs anyway: it
downloads the 1.20.1 release archive and that release's `SHA256SUMS`, stops on
a failed download, refuses to go on unless the archive's SHA-256 matches, as
the updater checks an engine, writes it to a new temporary folder and runs its
`repair` through npx, which the 1.20.1 launcher runs on the newest engine at
hand.

```sh
node -e "const v='1.20.1',u='https://github.com/jayyanez/rove-sentinel/releases/download/v'+v,c=require('crypto'),f=require('fs'),p=require('path'),o=require('os'),x=require('child_process');(async()=>{const k=process.argv.slice(1),z=k.filter((a)=>['--stop-orphans','--dry-run','--json'].includes(a)===false);if(z.length>0)throw new Error('Not a repair option: '+z.join(' ')+' (only --stop-orphans, --dry-run and --json are passed on)');const g=async(n)=>{const r=await fetch(u+'/'+n);if(r.ok===false)throw new Error(n+': HTTP '+r.status);return Buffer.from(await r.arrayBuffer())};const a=await g('rove-sentinel-'+v+'.tgz'),s=(await g('SHA256SUMS')).toString().split(/\r?\n/).find((l)=>l.endsWith(' rove-sentinel-'+v+'.tgz')),ok=Boolean(s)&&s.split(/\s+/)[0].toLowerCase()===c.createHash('sha256').update(a).digest('hex');if(ok===false)throw new Error('Checksum mismatch: the archive was not run');const t=p.join(f.mkdtempSync(p.join(o.tmpdir(),'rove-sentinel-')),'rove-sentinel-'+v+'.tgz');f.writeFileSync(t,a);const w=process.platform==='win32',n=p.join(p.dirname(process.execPath),'node_modules','npm','bin','npx-cli.js'),q=['--yes','--package',t,'--','rove-sentinel','repair'].concat(k),r=w===false?x.spawnSync('npx',q,{stdio:'inherit'}):f.existsSync(n)?x.spawnSync(process.execPath,[n].concat(q),{stdio:'inherit'}):x.spawnSync('npx '+q.map((a)=>JSON.stringify(a)).join(' '),{stdio:'inherit',shell:true});process.exitCode=r.status??1})().catch((e)=>{console.error(e.message);process.exitCode=1})"
```

`repair`'s options go after `--` at the end of the line, as in
`node -e "…" -- --stop-orphans`; the line passes on `--stop-orphans`,
`--dry-run` and `--json`, and refuses anything else. While the repository's
active engine predates 1.20.1, every `Next:` line this repair prints is this
same line with the options to pass (never `npx --no-install rove-sentinel
repair`, which would run the old engine): run each one exactly as printed.

Behind a proxy, Node's fetch needs what the updater needs (see `update` fails
behind a proxy, above). The checksum comes from the same release, so this is an integrity
check, not an independent signature: it trusts GitHub and the release
publisher, as the updater does. On Windows the repair then retries the update
when automatic updates are on; once it activates, the repository's own `repair`
works, and until then run this line again. On macOS, which has no
automatic updates, it repairs the watcher, pauses and locks; the engine moves
on through the project's dependency, as before.

Engines before 1.20.1 print these for the states above; each means: run the
line above.

| An engine before 1.20.1 prints | Its state |
| --- | --- |
| `Provider process-tree cleanup could not be verified; inspect remaining provider processes before resuming.` or `Windows provider parent exited before inherited pipes closed; inspect remaining provider processes before resuming.` | A safety pause |
| `Review daemon lock belongs to dead PID …; refusing automatic removal because another starter may have replaced it.` | A stopped watcher |
| `Runtime storage is full of versions retained by projects or running processes.` | A full engine store |
| `Another or interrupted runtime download owns …download.lock` | A stale store lock |
| `Another or interrupted update exists: …` or `Sentinel is being updated. Retry after it finishes; inspect … if interrupted.` | An interrupted activation |
| `updates` shows `"phase": "waiting"` or `"download-failed"` for days | An update the watcher keeps waiting |

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
