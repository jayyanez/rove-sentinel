# One owner of a repository's watcher

**Status:** proposal. No code. It supersedes the unmerged attempt to recover a
watcher by removing a dead process's lock.

## The problem

A restart of the computer leaves `daemon.lock.json` behind. The next watcher refuses
to start ("Review daemon lock belongs to dead PID ..."), so the repository has no
watcher while its scheduler reports success. `status` and `doctor` now say so, and a
person can run `recover`. Sentinel should recover by itself.

An attempt to do that went through six review rounds and failed each one with new
races. Each repair was correct for the race it answered and opened another. This plan
explains why that happens, and proposes a layout where those races cannot be written.

## Recommendation

**Candidate E: generations, one state directory per owner token, and a liveness
endpoint held by the kernel.**

- Ownership is taken by creating the next numbered generation, which exactly one
  process can do. Nothing is ever removed to change owner.
- Each owner writes only inside its own directory, so no owner can overwrite another.
- An owner holds a listening endpoint for its whole life. When nothing answers, the
  owner is gone, whatever the process table and the clock say.

The rest of this document is the reasoning, and what must be proved before anyone
relies on it.

## What must hold

| | Property | Meaning here |
| --- | --- | --- |
| H1 | At most one watcher acts | One owner of a repository's state on a computer. If a forced recovery replaces a live owner, the old one stops at its next heartbeat, and until then can only repeat work that is safe to repeat |
| H2 | A provably dead owner never leaves a project without a watcher | Any start finds and replaces it, with no person, however the owner died, and no race leaves nobody in charge |
| H3 | No owner's records are touched by another | While an owner lives, nobody else writes or removes its records |
| H4 | Pushes are never rejected by a race | A hook refuses only for a true state: no watcher, a real policy mismatch, a queue that is really full |
| H5 | A person can always recover | One command works whatever state is left, including unreadable files, with no other process needing to cooperate |

**Provably dead** means a proof, not an inference. A process that cannot be inspected,
a read that failed and a file that is missing are not proofs.

## Why today's layout cannot do this

### The records

| Record | Written by | Read by | Removed by |
| --- | --- | --- | --- |
| `daemon.lock.json` | A starter, with `wx` | Starters, hook, `status`, stop, `recover` | Its owner, stop, `recover` |
| `heartbeat.json` | The owner | Starters, hook, `status`, updates, stop | The owner, stop, `recover` |
| `stop-request.json` | Stop, on Windows | The owner | The owner, stop |
| `daemon-error.json` | Any process that fails to start | `status`, install's wait | Any start |
| `queue-submit.lock` | Each submitter | Submitters, `status`, updates | Its submitter, `recover` |
| `claims/` | The owner | Any start | Any start |
| `active-reviews/` | Each reviewing process | Updates | Its process, updates |

Four of these share one path among several writers. That is the root of it: a record
that several processes can replace cannot belong to any one of them.

### Removing a path is not compare-and-swap

Compare-and-swap needs one indivisible step that says "only if it is still the one I
judged". File systems do not offer that for removal. `unlink` and `rename` name a
**path**, and a path can start naming a different file between looking and acting.

```text
recovery: read lock, token X, judged dead
owner X:  releases
starter:  creates lock, token Y
recovery: remove lock                 <- removes Y's lock, and Y still believes it owns
```

Every repair tried moves that gap and keeps it:

- **Compare the text first.** The comparison and the removal are still two steps.
- **Rename to claim it, then look.** The rename is atomic, but it is the removal: it may
  take the wrong file, and for that moment the right owner has no lock. Putting it back
  can fail, or find a newer lock in its place.
- **A marker around the removal.** That only helps if everyone honours it, and a marker
  is a second lock with the same problem: judging it abandoned and removing it is two
  steps again. Starters cannot honour it before creating their lock, so they check
  afterwards, and backing out is one more removal by path.
- **The owner watches the lock.** Now a brief absence looks like a loss, and a healthy
  watcher exits.

Three operations *are* atomic and have one winner: creating a name that does not exist
(`O_EXCL`, `link`, `mkdir`), renaming a uniquely named source, and listening on an
endpoint. A sound design uses only those to change ownership, and never removes
anything to do so.

## Candidates

| | Candidate | H1 | H2 | H3 | H4 | H5 | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Today: refuse, and a person recovers | Yes | **No** | **No** | **No** | Yes | The defect itself |
| B | The patched lock: rename claim, takeover marker, ownership checks | Mostly | Mostly | **No** | **No** | Yes | Six rounds. Every check-then-act on a shared path remains |
| C | An OS file lock (`flock`, `LockFileEx`) | Yes | Yes | **No** | **No** | Yes | The kernel frees it on death, which is ideal, but Node has no such call, and it would need a native dependency. Records stay shared |
| D | One state directory per owner token, with process ids for liveness | Yes | Mostly | Yes | Yes | Yes | Sound, but its proof of death needs ids and start times, which is where the clock-step and reused-id findings came from |
| E | D, plus generations and a kernel-held endpoint for liveness | Yes | Yes | Yes | Yes | Yes | **Recommended** |

D and E both rest on one state directory per owner token. That alone removes most of
the findings, because it removes the shared paths. E adds the two things D lacks: a
single atomic step to take ownership, and a proof of death that uses no process id and
no clock.

## The design

```text
<state root>/
  generations/
    000041                      who owned the repository, one file each, never edited
    000042
  owners/
    <token>/
      identity.json             pid, engine version, endpoint name, start time
      heartbeat.json            sequence, activity, versions, policy digest
      claims/                   requests this owner has taken
      released.json             written last, on a clean exit
  starts/
    <pid>-<uuid>.json           one failed start, written by that starter
  requests/                     queued requests, ownerless, as today
  results/  active-reviews/  paused.json  policy.json  watcher-options.json
```

### Taking ownership

1. Make a new token, create `owners/<token>/`, write `identity.json`, and start
   listening on an endpoint named for the token. All of this is private until step 4.
2. List `generations/`. The highest is the current generation.
3. Judge it. It is free if it is vacant, its owner wrote `released.json`, or its endpoint
   proves nobody holds it. If its owner answers, stop: a watcher is running.
4. `link` a complete file to `generations/<current + 1>`. The name either did not exist
   and now holds a whole record, or the call fails with `EEXIST`.
5. On `EEXIST`, another starter won. Remove your own directory and go back to step 2.
   Never remove anything else.

Winning is final. There is no backing out, so two starters cannot both give up.

### Being the owner

- **Liveness** is the endpoint. Connecting succeeds, or the refusal (`ECONNREFUSED`,
  `ENOENT`) proves nobody holds it. Anything else, such as a timeout or a denial, is not a
  proof, and the owner counts as alive. A hung watcher that holds its endpoint is not dead,
  and needs a person.
- **The fence.** Before each heartbeat the owner lists `generations/`. It was replaced if
  a successful listing shows a higher number, or if two successful listings in a row lack
  its own, which only a person deleting the folder can cause. It then stops any review,
  records that in its own directory, and exits. A read that fails means nothing and is
  retried.
- **Heartbeats** go to its own directory, so an old owner's late write lands where nobody
  reads it.
- **Claims** move a request by renaming it from `requests/` into its own `claims/`. The
  source name is unique, so one rename wins. No separate claim lock is needed.
- **Stopping** a watcher means sending its endpoint a stop message with its token. No
  shared stop file remains.
- **A clean exit** writes `released.json`, then closes the endpoint.

The fence is a check followed by an act, so it has a gap: a replaced owner could finish a
step after being replaced. That gap can only open by forced recovery of a live owner, since
nothing else replaces one, and what could happen in it is safe to repeat: results are
written per request, attestations per exact commit. A duplicate pull request comment is the
worst outcome, and it is accepted.

### Readers

The current owner is the highest generation, its record says which directory to read, and
liveness comes from its endpoint. `status`, `doctor`, the hook and updates all use one
function for this.

A hook that is waiting asks that function whether *a* live owner exists, not whether the
same one does. When the owner changes during a wait, the new owner returns the request to
the queue and serves it, and the push keeps waiting. It refuses only when no owner answers
for longer than a grace of two heartbeats.

### Everything else that was shared

- **Failed starts** go to `starts/`, one file each. They show only when no live owner
  exists, and are never read ahead of a healthy owner.
- **The queue needs no lock.** A submitter writes its request under a unique name, lists
  the queue, and sorts by `(createdAt, id)`. Only if its own rank is past the bound does it
  remove its own request and refuse. Two submitters at the boundary reach the same order,
  the bound still holds, and no lock exists to be left behind.
- **`active-reviews/`** stays as it is: already one file per process. A takeover does not
  wait for it. Foreground reviews coexist with a watcher by design, and resource recovery
  already spares live owners, so a foreground review no longer keeps a repository without
  a watcher.

### A person recovering

`recover` lists `generations/` and creates the next one as vacant, with the reason. It reads
nobody's records, so unreadable ones cannot stop it. Any start then takes the following
generation. If the owner answers, it refuses unless forced, as today.

If `generations/` itself cannot be listed, the guide says to delete the `generations/` and
`owners/` folders. That removes no review results or attestations, and a surviving owner
stops by the fence's second rule.

### Lifecycle of each record

| Record | Created by | Changed by | Removed by |
| --- | --- | --- | --- |
| `generations/<n>` | The winning starter, or `recover` | Nobody | The current owner, keeping the last 16 |
| `owners/<token>/` | Its starter | Its owner, while alive | Its starter if it lost; else the current owner, once that endpoint proves dead and its claims are recovered |
| `claims/*` in it | Its owner, by rename | Nobody | Its owner on completion; the next owner renames a dead owner's back to `requests/` unless a result exists |
| `requests/*` | A submitter | Nobody | The claiming rename, or the submitter if over the bound |
| `starts/*` | The failing starter | Nobody | Age, as other records |

Only one rule needs care: a directory is removed by another process only once its endpoint
has proved its owner dead, and by the current owner alone.

## Every interleaving found, and how this rules it out

These are the findings of the review rounds on the watcher recovery work, including the
branch this plan replaces. Each becomes a named test.

| # | Interleaving | Why it cannot occur here |
| --- | --- | --- |
| 1 | A recent heartbeat and a reused process id looked like a healthy owner, so a dead owner was never replaced | Liveness is the endpoint. Neither a heartbeat's age nor a process id is consulted |
| 2 | A dead submitter's lock survived a takeover, refusing every push under a healthy watcher that barred the `recover` needed to clear it | No submission lock exists |
| 3 | `recover` removed the lock and marker between a starter's read and its removal, and a replacement's lock was deleted | Nothing is removed to change owner, so no removal can hit a replacement |
| 4 | A delayed `recover` removed a newer marker it had judged abandoned, and two removals overlapped | No marker exists |
| 5 | `recover` judged a snapshot and removed the lock later; an owner's release and a starter's first acquisition were not fenced | Same as 3: ownership moves by creating a number, which needs no fence |
| 6 | `recover` with no lock in its snapshot removed one created meanwhile | Same as 3 |
| 7 | A stop read `EPERM` as a dead process and removed a live owner's state | A stop talks to the endpoint and removes nothing. `EPERM` from a process check is no longer part of any proof |
| 8 | A review lease was written after a takeover read the leases | A takeover no longer depends on leases |
| 9 | A clock step moved a process's reported start past its lock or heartbeat, so a healthy watcher looked gone | No clock is consulted. The endpoint answers |
| 10 | A failed marker write left a marker nothing removed, so starts stayed refused | No marker. A failed step 1 leaves only the starter's own private directory |
| 11 | Compare and removal were separate; acquisition checked the marker after writing, giving a successful acquisition with no lock, then another | One atomic `link`. There is no comparison and no check after |
| 12 | A starter's backout, delayed, deleted a later owner's lock | Nobody backs out of anything shared. A loser removes only its own directory |
| 13 | A claim swallowed a failed restore and deleted the only copy of a lock | Nothing is claimed by moving it |
| 14 | A losing owner's release briefly hid the winner's lock, and the winner read that as a loss and exited, leaving no watcher | Release writes only inside its own directory, and nothing moves a generation file, so no brief absence can occur |
| 15 | Shutdown trusted a flag cached at the last heartbeat and deleted a replacement's records | Each owner's records have their own path, and it deletes only its own |
| 16 | Shutdown checked ownership once, then deleted shared records | Same as 15 |
| 17 | `recover` cleared shared records after releasing its fence, and could delete a live submitter's lock | `recover` only creates a generation. No shared record or submission lock is touched |
| 18 | A heartbeat published after its ownership check overwrote the new owner's and rejected an active push | Heartbeats have per-owner paths, and a hook reads only the current owner's |
| 19 | A taker saw `EEXIST` and assumed a survivor while the other starter backed out, leaving no watcher | Whoever creates the number stays. A loser goes back and finds a live owner |
| 20 | A starter that lost wrote `daemon-error.json` beside a healthy winner, and the next wait failed | Failed starts are per attempt, and a healthy owner is read first |
| 21 | Any read failure counted as a lost lock, so one `EBUSY` stopped a healthy watcher and killed its review | Only a successful listing showing a higher number counts |
| 22 | A live foreground review kept a repository with no watcher until the next start | A takeover does not wait for foreground reviews |

Two cases remain and are accepted: a replaced owner's work between a forced recovery and its
next heartbeat, described above; and a hung owner that holds its endpoint, which stays until a
person acts, because hung is not provably dead.

## Migration

### Two versions on one project

State is per repository on one computer, and each repository selects one engine. Two
versions meet only in these cases:

| Case | What happens |
| --- | --- |
| An update stops the old watcher, then starts the new | Sequential, under the update fence, as today |
| An old hook, already running, starts a watcher during that gap | The new engine must not start beside it, and must fail the update so it rolls back |
| A rollback stops the new watcher, then starts the old | The old engine must find the state it understands |
| The new watcher crashed and a rollback starts the old | The old engine refuses a dead lock, as it does today. Not worse, and `recover` clears it |

### The bridge

The first release with this layout keeps the old engine working by also behaving like one.
The generation comes first, so that of all new starters only the one winner ever touches the
legacy lock:

1. A starter takes a generation as above, then takes `daemon.lock.json` with `wx`.
2. If a healthy old watcher holds that lock, the new owner writes `released.json`, reports
   `outdated` and exits. Its generation does no harm: it is released, and the next start
   passes it.
3. While it runs, the owner also writes `heartbeat.json` and answers `stop-request.json`,
   so older hooks, stops and starters see a healthy owner and leave it alone.
4. On a clean exit it removes `daemon.lock.json`, after `released.json`.
5. A legacy lock left by a dead process has no endpoint, so its proof is the old one: the id
   no longer exists, or the process holding it started after the lock was written, with
   the refusal kept in any doubt. This is the one path-based removal left. Older engines
   never remove a lock on their own start, so only a person's `recover` or stop can race it,
   and an old starter that slips into the gap simply wins the lock, which is step 2.
6. While the bridge exists, a watcher that finds `daemon.lock.json` gone or naming another
   token treats that as being replaced, on two readings in a row, since an old `recover`
   cannot create a generation. This is finding 14 again, for the bridge's life only, and it
   is accepted because it needs a person running an old engine's `recover` beside a healthy
   watcher, which that command refuses.

Leftover `claims/*.claim` files from an older engine are recovered once, by the first owner,
as today. `requests/` and `results/` keep their format. During the bridge an old submitter
still uses `queue-submit.lock` and a new one does not, so the queue's bound can be passed by
a few requests, for that short time.

### Retiring the bridge

An update can jump versions, and rollback returns to whatever ran before, so the bridge
cannot go on a fixed schedule. It stays until a release raises `sentinelEngineProtocol`, which
is the existing way to say an older engine is no longer a rollback target. The new layout is
not part of the protocol, so the first release does not need to raise it.

## What it relies on

| Primitive | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Atomic create of a complete file | `link` on NTFS | `link` on APFS | `link` on ext4, xfs, btrfs |
| Atomic claim | `rename`, which can fail with `EPERM` or `EBUSY` while another program holds the file, so it needs a retry | `rename` | `rename` |
| Liveness endpoint | Named pipe | Unix domain socket | Unix domain socket |
| Second listener refused | `EADDRINUSE` | `EADDRINUSE` | `EADDRINUSE` |
| Nothing holds it | `ENOENT` | `ECONNREFUSED` | `ECONNREFUSED` |
| Freed by the kernel on any death | To be proved | Measured once | To be proved |
| Not inherited by child processes | To be proved | Measured once | To be proved |

The state root must be on a local disk. All of this assumes it: `link` semantics and sockets
do not carry over network or synced folders, and a watcher should refuse to start on one.

**Measured so far,** once each, by a small synthetic script. **Windows has not been measured,
and everything said of named pipes above comes from documentation. Since it is the qualified
platform, measuring it is the first step of this work, and a bad result reopens the choice of
endpoint.**

macOS, Node 26:

- A live holder answered, and a second listener got `EADDRINUSE`.
- After a hard kill, `ECONNREFUSED`, with a child process of the dead holder still alive.
- Of 16 concurrent `link` calls to one name, 1 won and 15 got `EEXIST`.
- Of 16 concurrent renames of one file, 1 won and 15 got `ENOENT`.

**Known risk:** Unix socket paths are limited to about 104 bytes. In that measurement a path
of over 120 characters bound without error, which is not reassuring: it may have been cut
short silently. The endpoint must therefore not live under the state root. It needs a short
path, such as one under the user's runtime or temporary folder named by a hash of the token,
and `identity.json` records it.

## What must be proved by a test

**A model of the interleavings.** Every file operation goes through one seam, and a test
enumerates the orderings of two starters, an owner and a `recover`, checking H1 to H4 after
each. Findings 1 to 22 become named schedules in it. Six review rounds found these one at a
time; the model should find any like them before a reviewer does.

**Real processes:**

- Hard kill of an owner, with and without a surviving provider child process.
- Sixteen starters at once on a dead owner: one owner results, and nobody is left refusing.
- Requests in flight through a takeover: each completes exactly once, and no push is refused.
- A forced recovery of a live owner: the old owner stops within one heartbeat.
- A hung owner stays until a person acts.
- Unreadable records, a full disk at each step, and an external program holding a file open.
- A clock step of an hour either way on a healthy watcher: no takeover.
- Sleep and resume: no takeover.
- Bridge cases: each row of the two-versions table, against the last published engine.

**A real restart,** on Windows and on macOS, on disposable machines, with no injected
state:

1. Install a watcher and start a long review.
2. Restart the computer, once cleanly and once by cutting power.
3. Check that the watcher returns at logon without a person, that the interrupted request
   finishes, and that a push made right afterwards is reviewed.

Linux has no qualified scheduler, so its restart test waits for that support, and the
Linux column above stays unclaimed until then.

## What the unmerged attempt leaves

That work is on a local branch at `8a73e68`, and stays unpublished.

| Piece | Verdict |
| --- | --- |
| `isProcessAlive` treating only `ESRCH` as gone, and the stop path using it | **Keep, now.** A stop on `main` still reads `EPERM` as dead (finding 7). This is a small fix worth its own pull request |
| `processStartTime` and `processIsGone` | Keep for the bridge only, for the legacy lock |
| `DAEMON_LOCK_LOST`, `onDaemonLockLost` and the watcher's exit path | Keep the plumbing, with the fence as its trigger |
| The `daemon-lock-lost` event | Keep |
| The takeover marker, `removeDaemonLockExclusively`, `claimLock` | Discard, but for one use of the rename claim in the bridge's removal of a legacy lock |
| `ownsDaemonLock`, `clearOwnRecords`, `submissionIsAbandoned`, the fenced `tryAcquire` | Discard |
| `liveWork` | Discard: a takeover no longer depends on it |
| The lease refusal during a takeover | Discard |
| Its tests | Keep the scenarios as schedules in the model. Most assertions change |

## Delivery

1. Measure the endpoint on Windows: refusal after a hard kill, no inheritance by a provider
   child, and behaviour with the owner hung. Stop and rethink if any of it fails.
2. The stop's `EPERM` fix, on its own.
3. The file-operation seam and the model, against today's code, showing the findings fail.
4. Read path: one "current owner" function behind `status`, `doctor`, the hook and updates.
5. Generations, owner directories and the endpoint, with the bridge.
6. The queue without a lock.
7. Real restart qualification, recorded in the [validation record](../validation.md).

Steps 5 and 6 change how every project's watcher starts, so they should reach one project on
a pinned engine before a release turns them on everywhere. Until then, a restart still needs
`recover` and `install`, and `watcher.state` says so.
