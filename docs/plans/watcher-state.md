# One owner of a repository's watcher

**Status:** proposal, for the maintainer to decide. No code. It replaces an earlier draft of
this plan, which recommended generations and a liveness endpoint. An independent review
refuted that draft's proof of death, and measurements here confirmed it.

## The problem

A restart of the computer leaves `daemon.lock.json` behind. The next watcher refuses to start
("Review daemon lock belongs to dead PID ..."), so the repository has no watcher while its
scheduler reports success. `status` and `doctor` now say so, and `recover` followed by
`install` clears it. Sentinel should recover by itself.

An attempt to do that went through six review rounds and failed each one with new races. Each
repair answered its race and opened another. This plan explains why, and proposes a design in
which those races cannot be written.

## Recommendation

**Hold one kernel lock for the watcher's whole life, taken through the built-in `node:sqlite`,
and keep today's records.**

- The operating system frees the lock when the process dies, however it dies. A free lock is
  the proof of death. No process id, clock or heartbeat is part of it.
- A live owner cannot be replaced, so there is only ever one writer of the watcher's records.
  Nothing needs a generation number, a fence, a marker or a per-owner directory.
- `daemon.lock.json` stays, as a description of the owner rather than the lock. Old engines
  already understand it, so most of the migration disappears.

The price is a higher Node floor and a dependency on an API that Node still calls experimental.
Both are covered below. Linux has not been measured.

## What must hold

| | Property | Meaning here |
| --- | --- | --- |
| H1 | At most one watcher acts | One owner of a repository's state on a computer |
| H2 | A provably dead owner never leaves a project without a watcher | Any start replaces it, with no person, however it died, and no race leaves nobody in charge |
| H3 | No owner's records are touched by another | While an owner lives, nobody else writes or removes its records |
| H4 | Pushes are never rejected by a race | A hook refuses only for a true state: no watcher can start, a real policy mismatch, a hung owner, a queue that is really full |
| H5 | A person can always recover | One command works whatever state is left, including unreadable files |

**Provably dead** means a proof, not an inference. A process that cannot be inspected, a read
that failed and a file that is missing are not proofs.

## Why removing a lock file cannot work

Compare-and-swap needs one indivisible step that says "only if it is still the one I judged".
File systems do not offer that for removal. `unlink` and `rename` name a **path**, and a path
can start naming a different file between looking and acting:

```text
recovery: read lock, token X, judged dead
owner X:  releases
starter:  creates lock, token Y
recovery: remove lock                 <- removes Y's lock, and Y still believes it owns
```

Every repair moved that gap and kept it:

- **Compare the text first.** The comparison and the removal are still two steps.
- **Rename to claim it, then look.** The rename is the removal: it may take the wrong file, and
  for that moment the right owner has no lock. Putting it back can fail.
- **A marker around the removal.** A marker is a second lock with the same problem, and starters
  cannot honour it before creating their lock.
- **The owner watches the lock.** Now a brief absence looks like a loss, and a healthy watcher
  exits.

The sound answers are the ones where nothing is removed to change owner. Creating a name that
does not exist is atomic, and so is a lock the kernel holds and frees.

## Candidates

| | Candidate | Verdict |
| --- | --- | --- |
| A | Today: refuse, and a person recovers | The defect |
| B | Patched lock file: rename claim, takeover marker, ownership checks | Six rounds, and every check-then-act on a shared path remains |
| C | **Kernel lock through `node:sqlite`, today's records** | **Recommended** |
| C+D | Kernel lock, plus one state directory per owner token | Sound, but the directories solve a problem C no longer has |
| D | Per-owner directories, with process ids for liveness | Needs ids and start times, the source of the clock-step and reused-id findings |
| E | Generations, per-owner directories, a liveness endpoint | The earlier draft. Its proof of death is false |

**Why not per-owner directories.** They exist so that a late write from an old owner cannot hit
a new one. A kernel lock removes the premise: a new owner exists only after the old process has
died, and a dead process writes nothing. The review proposed C+D. Tracing each record shows C
alone is enough, and it keeps every file where old engines and rollbacks expect it.

**Other ways to hold a kernel lock.** Node has no `flock` or `LockFileEx` call. libuv's
`O_EXLOCK` flag works on Windows, as measured, but has no Linux equivalent, and a native addon
would add a compiled dependency to an engine that has none. SQLite wraps both platforms' locks
and ships inside Node.

## Measured evidence

Each run was once, with synthetic processes in a temporary folder.

- **Windows:** a physical x64 laptop, NTFS, Node 24.18. Where noted, the review reproduced the
  same on a second Windows machine.
- **macOS:** Apple silicon, APFS, Node 26.13.
- **Linux: nothing was run.** No Linux machine was available. Its column is unclaimed.

| Kernel lock (`BEGIN EXCLUSIVE`) | Windows | macOS |
| --- | --- | --- |
| Against a live holder | Busy | Busy |
| Against a suspended holder | Not run | Busy |
| After a hard kill, with the holder's child still alive | Free | Free |
| 16 racing processes | 1 won, 15 busy | 1 won, 15 busy |
| Lock file size while held and after a kill | 0 bytes | 0 bytes |
| Renaming the held file | `EBUSY` | **Allowed** |
| Deleting the held file | `EPERM` | **Allowed, and a second process can then hold a new file** |
| A lock file holding junk | Error 26, cannot lock | Error 26, cannot lock |
| Warning on load | None on Node 24.18 | None on Node 26.13 |

The two bold rows are a real difference: on POSIX the file is not protected, so the owner must
check it. See "The lock file".

**Readers must not fool a starter.** Eight processes polling in a tight loop, far above real use,
with no owner present:

| Starter's wait | Windows false "busy" | macOS false "busy" |
| --- | --- | --- |
| 0 ms | 145 of 3,417 | 1,141 of 1,521 |
| 250 ms | 0 of 1,405 | 0 of 324 |
| 1,000 ms | 0 of 1,361 | 0 of 229 |

So a starter waits about a second before believing an owner exists.

**The endpoint's proof of death is false.**

| Against a **live** holder | Result |
| --- | --- |
| Windows pipe, 12 clients in a tight loop, two runs | 12 and 168 `ENOENT` |
| Windows pipe, 16 clients, two runs | 321 and 225 `ENOENT` |
| Windows pipe, 24 clients, two runs | 226 and 122 `ENOENT` |
| Windows pipe, 256 one-shot connects, 40 rounds | None here. The review saw 24 of 10,240 |
| Windows pipe, 1 to 4 clients | None |
| macOS socket, holder suspended, connections left open | 128 connected, the next got `ECONNREFUSED` |

The load is well above normal, but a design that treats one refusal as proof would kill a
healthy watcher's review, and a stopped process plus polling hooks is exactly how the macOS case
would build up.

**Not measured:**

- The Node version floor. Documentation says `node:sqlite` needs no flag from 22.13.0, and only
  24.18 and 26.13 were at hand.
- The warning on Node 22.
- Linux, a real restart, a power cut, a full disk, and antivirus.

Delivery's first steps close these.

## The design

### The lock

`watcher.sqlite` in the state root. A starter opens it with a wait of about a second and runs
`BEGIN EXCLUSIVE`, and the watcher keeps that connection for its whole life. Nothing is ever
written to it, so it stays empty, and a power cut has nothing to tear.

- **Taking it** succeeds for exactly one process, which stays owner until it dies.
- **Busy** means an owner lives, or a person's `recover` is running, so the start stops there.
- **Any other error** is no proof, and the start refuses and says so.

### The records

They stay where they are, in the same format, because one writer needs nothing more.

| Record | Written by | Changed |
| --- | --- | --- |
| `daemon.lock.json` | The owner, after it holds the lock | Now a description, not the lock. A new field marks it as written by a kernel-lock engine |
| `heartbeat.json` | The owner | As today, with a sequence number added |
| `stop-request.json` | A stop | As today |
| `claims/` | The owner | As today: every claim present at takeover belongs to a dead owner |
| `requests/`, `results/` | As today | As today |
| `daemon-error.json` | A failed start | Each attempt gets an id, passed by the hook |
| `queue-submit.lock` | Nobody new | Replaced by a second kernel lock, `queue.sqlite` |

**Starting** is: take the lock, overwrite `daemon.lock.json` with an atomic rename, clear stale
state, recover claims, and begin the loop.

A failure after taking the lock must not end the watcher. Cleanup moves into the retrying loop,
because a surviving provider child can hold a directory open for minutes.

**Exiting** is: stop work, remove the heartbeat, leave `daemon.lock.json` in place, and let the
process end. The order is safe because a successor cannot exist until the lock is free. The file
left behind is the tombstone described under Migration.

**Stopping during a review** must leave the claim unresolved. Today `stop()` makes the review fail
and writes an error result, which refuses the waiting push. The request should instead return to
the queue at the next start, and the hook keeps waiting. This holds for a clean stop and for an
update.

### Readers

One function answers "who owns this repository?" for `status`, `doctor`, the hook and updates. It
takes the lock with no wait, using a read:

| Lock | `heartbeat.json` | Answer |
| --- | --- | --- |
| Busy | Advancing | `running` |
| Busy | Not advancing over several polls | `hung`, with the owner's pid. It refuses a waiting push, as a stale heartbeat does today, and never authorises a takeover |
| Free | Anything | `stopped` |
| Other error | Anything | `unknown`, with the error |

A heartbeat is judged by its sequence not advancing across polls, not by comparing clocks.

### The hook

- **It starts a watcher before it can refuse.** Today a full queue throws before any start, so a
  request left by a power cut blocks the only thing that would clear it.
- **It keeps starting during its wait.** If several polls find the lock free, it starts a watcher
  again. A second start is harmless: it finds the lock busy and exits. Without this, a crash
  mid-review, or a watcher that exits just as a starter gives way to it, refuses a recoverable push.
- **It counts polls and elapsed monotonic time,** not `Date.now()`, so a clock step cannot expire a
  wait.
- **It keeps today's policy checks.** A live owner on the wrong policy still refuses.

### The queue

Submission takes `queue.sqlite` for its short critical section, with today's five-second wait.
The kernel frees it if the submitter dies, so no stale lock exists to clear, and the code keeps
its shape. The bound stays exact among new submitters. Beside an old submitter it can be passed by
one, briefly.

### The lock file

- **On POSIX** a person can rename or delete it. The owner compares the file's identity at each
  heartbeat. If two readings in a row show it replaced, the owner exits, because a second holder
  may exist. A failed read means nothing.
- **On POSIX** a process loses a file lock if it opens and closes that file through another handle,
  so no code ever reads it except through this one module.
- **The connection must stay referenced,** so that garbage collection cannot close it.
- **Junk in the file** cannot come from Sentinel, since nothing writes to it, so a start refuses and
  `recover` replaces the file.

### A person recovering

`recover` takes the lock, so it cannot race a starter, and does today's work under it: clearing
technical outcomes, recovering claims and resources, and removing a stale heartbeat. A starter
finds the lock busy and waits.

- **If an owner holds the lock,** it refuses, as today for a healthy owner.
- **A hung owner needs `recover --kill`,** which is new. It ends the process named in
  `daemon.lock.json`, then takes the lock. The pid is trustworthy because a live holder wrote it. A
  person confirms by passing the flag. A vacant record or a marker could not stop a hung process.
- **If the record is unreadable,** `--kill` refuses and says how to find the holder: `handle` on
  Windows, `lsof` on macOS and Linux.
- **If the file is junk,** it is replaced, since nobody can hold it.

### Network folders

No refusal. `statfs` reports type 0 on Windows, so a volume's type cannot be read, and refusing
would break Linux homes on NFS that work today. A kernel lock either works there or fails loudly,
which reaches the "any other error" path.

## Every interleaving found, and how this rules it out

These are the findings of the review rounds on the earlier attempt. Each stays as a named test.

| # | Interleaving | Why it cannot occur here |
| --- | --- | --- |
| 1 | A recent heartbeat and a reused process id looked like a healthy owner | Liveness is the lock. No id is consulted |
| 2 | A dead submitter's lock survived, refusing every push under a healthy watcher | The kernel frees `queue.sqlite` |
| 3 | `recover` removed the lock between a starter's read and its removal | Nothing removes a lock. `recover` holds the same kernel lock as a starter |
| 4 | A delayed `recover` removed a newer marker | No marker exists |
| 5 | `recover` judged a snapshot and removed the lock later | Same as 3 |
| 6 | `recover` with no lock in its snapshot removed a new one | Same as 3 |
| 7 | A stop read `EPERM` as a dead process | **Closed on `main` by #23.** No proof uses a process check now |
| 8 | A lease was written after a takeover read the leases | A takeover no longer depends on leases |
| 9 | A clock step made a healthy watcher look gone | No clock is part of the proof |
| 10 | A failed marker write left a marker | No marker exists |
| 11 | Compare and removal were separate, giving an acquisition with no lock | One kernel operation |
| 12 | A starter's delayed backout deleted a later owner's lock | Nobody backs out of anything shared |
| 13 | A claim swallowed a failed restore and deleted the only copy | Nothing is moved |
| 14 | A losing owner's release hid the winner's lock, and the winner exited | There is no loser: a process that did not take the lock never wrote anything |
| 15 | Shutdown trusted a cached flag and deleted a replacement's records | A replacement cannot exist until this process has died |
| 16 | Shutdown checked ownership, then deleted shared records | Same as 15 |
| 17 | `recover` cleared shared records after releasing its fence | It holds the lock throughout |
| 18 | A late heartbeat overwrote the new owner's and rejected a push | Same as 15: the old writer is dead |
| 19 | A taker saw `EEXIST` while the other starter backed out, leaving nobody | Exactly one takes the lock and stays |
| 20 | A losing starter wrote an error beside a healthy winner | Errors carry an attempt id, and a healthy owner is read first |
| 21 | One read failure counted as a lost lock and stopped a healthy watcher | A failed read means nothing, and only two readings of a replaced file do |
| 22 | A live foreground review kept a repository with no watcher | A takeover does not wait for foreground reviews |

One case remains and is accepted: a hung owner holds its lock until a person acts, because hung is
not provably dead. `status` reports it and pushes are refused rather than left waiting.

## The independent review's findings

Eighteen findings. Windows claims were repeated on a separate physical machine, and code claims
were read against the source. Where the review was wrong or incomplete, that is noted.

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | A refused connect proves nothing | **Accepted, and it decided the design.** Reproduced on Windows and on macOS, where the review had only a source. Its fix is taken in part: the kernel lock yes, per-owner directories no. Its "rename of the held file gives `EBUSY`" holds on Windows only, and macOS allows it, which adds the identity check. Its "still emits an experimental warning" is false on Node 24.18 and 26.13, and Node 22 is unmeasured |
| 2 | A power cut can leave the newest record unreadable | **Resolved by design.** The proof uses no record, the lock file is empty, and a torn `daemon.lock.json` is simply overwritten by the next holder |
| 3 | The fence's exit refuses a waiting push | **Accepted, and wider.** Confirmed in the code: `handleRequestFailure` writes an error. There is no fence now, but a clean stop has the same effect, so a stop during a review must leave the claim unresolved |
| 4 | Nobody starts a watcher during a hook's wait | **Accepted.** The hook keeps starting during its wait, by counting polls |
| 5 | The bridge's released marker leaves no watcher | **Moot.** No `released.json` and no bridge steps |
| 6 | Old engines persist indefinitely | **Accepted, confirmed in the code.** `selectedEngine` returns the bundled CLI without an active version, and `startDaemonDetached` spawns its own. There is no retirement to get wrong: `daemon.lock.json` stays for good, and the file left behind is the tombstone |
| 7 | A hung owner cannot be stopped by a fence, and `recover` has no force flag | **Accepted.** Confirmed: only `--reason` exists. `recover --kill` is new, and `--kill` needs a readable record |
| 8 | A dead owner's child can stop the new owner from starting | **Accepted.** Confirmed: the cleanup is in the outer `try`, and providers run in the review bundle. Cleanup moves into the retrying loop |
| 9 | Pruning reuses a generation number | **Moot.** No generations. For the record, listings never fell behind during pruning on either NTFS or APFS |
| 10 | The lock-free queue breaks H4, and the bound is 1 | **Accepted, a different fix.** The rank rule is withdrawn. Its proposed slot names are declined, because a request's id must match its file name in today's claim path and old watchers read that. A kernel lock keeps the shape |
| 11 | A stale request blocks the start that would clear it | **Accepted.** The hook starts before it can refuse |
| 12 | The bridge's legacy removal repeats the race | **Accepted, and removed.** Sentinel never removes a legacy lock automatically. A crashed old watcher's lock stays a person's `recover`, as today. New engines stop old watchers through the unchanged path |
| 13 | Clocks remain in waits | **Accepted.** Waits count polls and monotonic time, heartbeats use a sequence, and the clock test targets those |
| 14 | Liveness alone hides stuck owners | **Accepted.** A `hung` state, and today's checks stay. The measured connect stall no longer applies, since a lock probe does not wait on the owner |
| 15 | Lifecycle gaps | **Mostly moot.** No directories or sockets to leak, and claims stay where a rollback sees them. `recover` keeps its work, under the lock. Attempt ids are adopted. `cancelQueuedRequest` is unchanged. A dead `queue-submit.lock` from an older engine is ignored by new submitters and cleared by `recover` |
| 16 | A network-folder refusal cannot be built | **Accepted.** Dropped. `statfs` type 0 confirmed |
| 17 | The proposed tests prove less than claimed | **Accepted.** At-least-once replaces exactly-once, the schedule model is dropped, and each test now states how it can fail |
| 18 | Smaller points | **Partly closed.** #23 fixed `install.mjs` and `storage.mjs`. `git.mjs` still reads `EPERM` as dead when cleaning review checkouts, and that is delivery's small fix. "Second listener refused" and "delete the folders" no longer apply |

## Migration

### The engine floor

`engines` rises from `>=22` to the verified floor, expected to be `>=22.13`. The guides, `doctor`
and the update path all check it. A watcher on an older Node refuses to start with a message saying
why, and an automatic update checks the floor before it stops the running watcher, so a host below
the floor stays on its engine with a visible reason instead of rolling back.

### The experimental warning

`node:sqlite` was silent on Node 24.18 and 26.13, and may not be on 22. Hooks must not print a
warning on every push:

- Only the one module that holds the lock imports `node:sqlite`, and only when called.
- That import filters this one warning. A test on the floor version asserts empty stderr.
- The API surface is two calls, `new DatabaseSync(path, { timeout })` and `exec`. If Node changes
  them, CI fails on that version before a release, and the fix is in one module.

### Two versions on one project

Old engines run indefinitely: a worktree with an older pin spawns its own CLI, and on macOS no
automatic update exists. The state is shared, so they meet.

| Case | What happens |
| --- | --- |
| An old starter, a new owner running | `wx` fails, it reads a healthy owner, and it leaves. Same as today |
| An old hook, a new owner running | It reads the same records. A version mismatch refuses, as it does today |
| An old stop of a new owner | Same path: stop request or signal, and the owner exits. Rollback depends on this |
| An old `recover` beside a healthy new owner | It refuses, as today |
| An old `recover` beside a hung new owner | It removes `daemon.lock.json`. The owner restores its own record, or exits if it finds another's |
| A new starter, an old owner running | It takes the kernel lock, finds a legacy record with a fresh heartbeat, releases the lock and reports `outdated` |
| A new starter, a legacy lock left by a crash | It refuses and names `recover`, as today. Updates stop the old watcher cleanly first, so this needs a crash before upgrading |
| An update stops the old, starts the new | As today. A legacy lock is gone by then |
| A rollback | The old stop removes the record, and the old engine starts as today. Claims are where it looks |
| A new starter on a record left by a new owner | It holds the kernel lock, so that owner is dead, and it overwrites the record |

### Tombstones for old starters

An old starter treats any existing `daemon.lock.json` with a dead owner as a refusal. So a new
owner **leaves its record in place when it exits**, and the record is the tombstone. Nothing has to
write a special value, and a `pid: 0` tombstone was considered and rejected: an old stop re-reads
the lock after the owner exits and throws "changed ownership" if it changed, which would break
rollback.

So an old starter in a stale worktree refuses with a message about a dead PID, and does not start
a second watcher. The cost is that message: the person should update that worktree's pin. An old
`recover` removes the tombstone, which is that person's decision, and leaves today's behaviour.

Nothing here retires: the record stays for as long as the file format does, at no cost. Raising
`sentinelEngineProtocol` is not needed and would stop nothing, since it is checked only when
downloading an engine.

## What must be proved by a test

Every test here must be able to fail. Each names what breaks it.

**The lock:**

| Test | It fails if |
| --- | --- |
| Hard kill, with a surviving provider child, then a start | The lock is inherited |
| 16 racing starters, repeated | Two win, or none does |
| A starter beside 8 polling readers | The wait is too short: it fails with a wait of 0, shown first |
| A long idle hold with forced garbage collection | The connection is not kept referenced |
| A held lock across a suspended process | A suspended owner is replaced |
| The same process reading the file through another handle | Run on POSIX to show the rule is needed |
| Renaming and deleting the held file on POSIX | The owner does not exit |

**The floor:** CI runs the suite on the exact floor version, and one version below it to show the
refusal. Empty stderr on the floor version fails if the warning filter stops working.

**The hook and the watcher, with real processes:**

| Test | It fails if |
| --- | --- |
| Kill the owner mid-review while a hook waits | The hook refuses, or no start comes |
| Clean stop during a review while a hook waits | An error result is written |
| An owner that exits just as a starter gives way | The hook gives up. Run repeatedly, at the race |
| A provider child holding the bundle open at takeover | The new owner exits |
| Requests through a takeover | One is lost. The property is at least once: a crash before the claim clears reviews again |
| A clock step of an hour either way, with a hook waiting | A wait expires. This targets the waits, since the takeover has no clock |
| A hung owner | The hook waits past the limit, or a takeover happens |
| `recover --kill` with an unreadable record | It ends a process |
| A stale request and a full queue after a power cut | No start comes |

**Findings 1 to 22** stay as named tests of the outcome each one broke. Those that needed a marker
or claim from the unpublished code cannot be shown failing against `main`, and that is stated in
each, rather than replaying a schedule.

**Two versions:** every row of the table above, with the last published engine as a real process.

**A real restart,** on Windows and on macOS, on disposable machines:

1. Install a watcher and start a long review.
2. Restart, once cleanly and once by cutting power.
3. Check that the watcher returns at logon with no person, the interrupted request finishes, and a
   push made right afterwards is reviewed.

A random power cut will not hit a torn file, so the same check also runs with a torn
`daemon.lock.json` and `heartbeat.json` placed by hand.

Linux has no qualified scheduler, so its restart test waits for that support.

## What the unmerged attempt leaves

That work is on a local branch at `8a73e68` and stays unpublished.

| Piece | Verdict |
| --- | --- |
| `isProcessAlive` | Done: on `main` through #23 |
| `DAEMON_LOCK_LOST`, the watcher's exit path, the `daemon-lock-lost` event | Keep, for a replaced lock file |
| Its dead-owner and concurrency tests | Keep the scenarios |
| Takeover marker, `removeDaemonLockExclusively`, `claimLock` | Discard |
| `ownsDaemonLock`, `clearOwnRecords`, `submissionIsAbandoned`, the fenced `tryAcquire` | Discard |
| `processStartTime`, `processIsGone`, `liveWork` | Discard: no proof uses them |
| The lease refusal during a takeover | Discard |

## Delivery

1. **Measure what is unmeasured:** the floor on exact Node versions, the warning on Node 22, and
   Linux when a machine exists. Stop and rethink if the floor is unworkable.
2. `git.mjs`'s `EPERM` reading, on its own.
3. Leave the claim unresolved on a stop, and move startup cleanup into the loop. Both are fixes that
   stand alone.
4. The hook: start before refusing, keep starting during a wait, count polls. These stand alone too.
5. The lock module and its tests, unused.
6. Readers: one "who owns this" function, with `hung`.
7. The watcher takes the lock, with the floor raised.
8. The queue's kernel lock, and `recover --kill`.
9. Real restart qualification, recorded in the [validation record](../validation.md).

Steps 2 to 4 help every project now, and none depends on this design. Step 7 changes how every
project's watcher starts, so it should reach one project on a pinned engine before a release turns
it on everywhere. Until then, a restart needs `recover` and `install`, and `watcher.state` says so.
