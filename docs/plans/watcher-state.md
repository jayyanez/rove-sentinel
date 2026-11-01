# One owner of a repository's watcher

**Status:** proposal, for the maintainer to decide. No code. Two independent reviews read it, and
this is the last round: every finding is listed with its status, and the open ones are stated
rather than answered with another redesign.

## The problem

A restart of the computer leaves `daemon.lock.json` behind. The next watcher refuses to start
("Review daemon lock belongs to dead PID ..."), so the repository has no watcher while its
scheduler reports success. `status` and `doctor` now say so, and `recover` followed by
`install` clears it. Sentinel should recover by itself.

An attempt to do that went through six review rounds and failed each one with new races. Each
repair answered its race and opened another. This plan explains why, compares a design
meant to rule those races out with a much narrower goal, and recommends the narrower one.

## Recommendation

**Do not build the full design now. Solve the incident that happened.**

The only real incident is a lock left behind by a restart, and a watcher that stayed stopped with
nobody noticing. `status` and `doctor` already show the second. For the first, take Option A in
[The narrower goal](#the-narrower-goal): a starter treats a lock as dead only when the machine
booted after that lock's last heartbeat **and** its process is gone. There is no new Node floor, no
experimental API, no change of format and no migration between protocols.

Three designs in a row have failed review. The kernel lock is the strongest of them, and its core
survived: two conforming holders cannot hold one lock on one local file. But the second review
found ten P1 problems around that core, in replacing the file, living beside old engines, the Node
floor and recovery. They are the price of promising all five properties below, and one incident
does not justify that price.

Option A gives up those promises on purpose. It also removes a lock file, which this plan argues
against in general, so it has one narrow exception to defend, and **no reviewer has read it yet**.
It needs a review before any code. If it fails, the fallback is Option C: stay as `main` is, where
a restart costs a person one `recover` and one `install`, and `status` says so.

The kernel lock stays below as the reference design, as the reviews read it. It becomes worth its
price if a real incident of a kind Option A does not cover ever appears.

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

## The narrower goal

### What really happened

| Incident | Seen | Today |
| --- | --- | --- |
| A restart left `daemon.lock.json`, and every later start refused with "belongs to dead PID" | Yes | `recover` then `install` clears it |
| The watcher stayed stopped and nobody noticed, because the scheduler reported success | Yes | `status` and `doctor` report `watcher.state` |

Everything else in this plan was found by reasoning, review or measurement, not by an outage.

### The options

| | Option | What it does |
| --- | --- | --- |
| Full | Kernel lock | The design below: an owner holds a lock through `node:sqlite` for its whole life |
| A | Boot rule | `acquireDaemonLock` replaces a lock left by an earlier boot. Every starter runs it |
| B | Logon recover | The refusal stays. The logon task runs a safe recover before it starts the watcher |
| C | Nothing more | `main`, plus the small fixes under Delivery |

### What each one covers

| Event | Seen | Full | A | B | C |
| --- | --- | --- | --- | --- | --- |
| Restart, then a logon | **Yes** | Recovers | Recovers | Recovers | A person |
| Restart, then a push with no logon | No | Recovers | Recovers: the hook starts a watcher | A person | A person |
| Restart on Linux, which has no scheduler | No | Recovers at a push | Recovers at a push | A person | A person |
| Stopped with nobody noticing | **Yes** | Cause gone | Cause gone for a restart | Cause gone for a logon | Shown by `status` and `doctor` |
| Shut down and power on with Windows Fast Startup | No | Recovers | **A person:** the boot time does not move | Recovers at logon | A person |
| Log off | No | Recovers | **A person** | Recovers at logon | A person |
| A crash or a kill, same boot | No | Recovers | **A person** | Recovers at logon | A person |
| A power cut that tears a record | No | Lock yes, C9 still stops it | **A person:** no readable heartbeat, no proof | Recovers at logon, unless C9 stops it | A person |
| A hung owner | No | `recover --kill`, disputed by C4 | As `main` | As `main` | As `main` |

The Fast Startup row comes from how that feature is documented. It has not been measured.

### The five properties

| Property | Full, as promised | Full, after review | A | B | C |
| --- | --- | --- | --- | --- | --- |
| H1 One watcher | Promised | Not held: C1, C2, C3 | **Not promised.** As `main` | **Not promised.** As `main` | **Not promised** |
| H2 Dead owner recovered | Promised | Not held: C2, C5, C9 | **Narrowed** to an owner from an earlier boot | **Narrowed** to a logon after the process is gone | **Not promised** |
| H3 Records untouched | Promised | Not held: C1, C3 | **Not promised.** As `main` | **Not promised.** As `main` | **Not promised** |
| H4 No refusal by a race | Promised | Not held: C5, C7 | **Not promised.** As far as the small fixes reach | **Not promised** | **Not promised** |
| H5 A person can recover | Promised | Not held: C4, C9, C10 | **Not promised.** `recover` as today | **Not promised** | **Not promised** |

"As `main`" is not a guarantee. An old or a new `recover` beside a hung owner removes its lock
today, and nothing here changes that.

### Option A, exactly

A starter that finds an existing lock it cannot accept checks, in order:

1. The heartbeat is readable and carries the lock's `ownerToken`.
2. Its `at` is earlier than the boot time.
3. `process.kill` on the lock's pid gives `ESRCH`.

Any other answer is no proof, and the refusal stays. A proof takes `takeover.lock`, created with
`wx`, and then reads the lock again. If the lock changed, the starter gives way. If not, it removes
the lock, creates its own the normal way, and removes `takeover.lock`.

**Why this removal differs from the one this plan rejects.** The race above needs an owner that
releases between the look and the removal, and a process from an earlier boot cannot release
anything. A plain `wx` cannot succeed while the file exists, so a starter cannot slip in either.
The only other removers are takeovers, which the marker serialises, and `stop` and `recover`. New
engines can take the marker in `recover`. Old engines cannot, and that remains a window.

**Why two tests.** The boot time is computed from the wall clock, so a large forward step could
make a live owner's last heartbeat look older than the boot. Its process is alive, and step 3
refuses. A backward step only makes the rule not fire, and the refusal stays. A pid reused after
the restart also refuses: that restart needs a person, and it is the safe direction.

**Measured.** `Date.now() - os.uptime() * 1000` held within 17 ms on Windows and within a second on
macOS, where `os.uptime()` gave whole seconds. On macOS it matched `kern.boottime` within a second.
On Windows it was **27 s later** than `LastBootUpTime`, so a value from this boot can read as an
earlier one in that first half minute. Step 3 covers that case, because such an owner is either
alive or truly dead. No real restart has been run through this rule.

**What it costs.** About a dozen lines, one marker and one new way to fail: a starter that dies
holding `takeover.lock` leaves a refusal until `recover` or the next boot. It reads a heartbeat
old engines already write, so the first restart after an update is covered. A rollback finds what
it expects.

**What it does not fix.** A truncated `results/<id>.json` makes `recoverClaims` throw on every
attempt, for a starter and for `recover` alike (C9). That needs its own small fix in every option.

### Why not the others

**Option B** keeps every path a push uses unchanged, so a mistake can only happen at logon, and it
reaches logoffs and crashes because its proof can be `ESRCH` alone. It misses a host nobody logs on
to and all of Linux, it changes every project's installed task, and two logons can still race, so
it needs the same marker. It covers more kinds of death but fewer of the machines where a restart
happens.

**`ESRCH` alone inside Option A** would add logoffs, crashes and Fast Startup. It widens the takeover
to a live boot, where the earlier review rounds found their races. It is the natural next step if
Option A holds up, and it should not be the first one.

**Option C** is honest and cheap, and it leaves the incident in place: a person after each restart.

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

This is the reference design, left as the reviews read it. It is not the recommendation. Where it
is wrong, [Every review finding](#every-review-finding) says so, and those passages have not been
rewritten.

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

## Every review finding

Thirty findings: R1 to R18 from the first independent review, C1 to C12 from the second, which
read this plan at `55b65eb`.

- **Resolved:** answered by merged code, by a pull request that passed the gate, or because the
  design no longer has that part.
- **Accepted:** true, and the design takes the change, which is not built yet.
- **Open:** true and unanswered.

Status describes the full design. The last column says what happens under Option A.

| # | Finding | Status | How it was checked, and what remains | Under Option A |
| --- | --- | --- | --- | --- |
| R1 | A refused connect proves nothing | Resolved | Reproduced on Windows and macOS. No connect remains | Does not arise |
| R2 | A power cut can leave the newest record unreadable | Resolved | The lock's proof reads no record. C9 is what is left | A torn heartbeat refuses |
| R3 | A failing exit refuses a waiting push | **Open** | Confirmed in `handleRequestFailure`. The fix stopped at the gate: see below | Still applies, independent of the design |
| R4 | Nobody starts a watcher during a hook's wait | **Open** | #25 did this and stopped at the gate: a start can land after the hook's lease, inside an update's fence, and a wait past its base timeout never reaches it. #25 is a draft, not to merge | Still applies, own fix |
| R5 | A released marker leaves no watcher | Resolved | No bridge exists | Does not arise |
| R6 | Old engines persist indefinitely | **Open** | Confirmed. The plan said the file left behind was enough, and C3 disproves that | No protocol to retire |
| R7 | A hung owner cannot be stopped, and `recover` has no force flag | **Open** | Confirmed. `recover --kill` was the answer, and C4 disputes it | As `main`: accepted |
| R8 | A dead owner's child can stop the new owner from starting | Accepted | Confirmed: cleanup is in the outer `try`. Moving it into the loop is unbuilt | Still applies, own fix |
| R9 | Pruning reuses a generation number | Resolved | No generations | Does not arise |
| R10 | The lock-free queue breaks H4, and the bound is 1 | Accepted | A second kernel lock. C5 adds that a five-second wait proves nothing | `main`'s queue stays |
| R11 | A stale request blocks the start that would clear it | **Open** | Starting before submitting stopped at the gate: a cold watcher sees an empty queue and can take an unrelated review first, delaying the push. Unpublished | Still applies, own fix |
| R12 | A legacy removal repeats the race | Resolved | The full design removes nothing | **Back in narrow form:** the first thing a review of A must attack |
| R13 | Clocks remain in waits | Accepted | The hook's waits still use `Date.now()`: the change was in #25, which is not to merge. Heartbeat age still uses clocks | Adds a clock, guarded by `ESRCH` |
| R14 | Liveness alone hides stuck owners | **Open** | `hung` was the answer, and C5 shows busy cannot name an owner | As `main` |
| R15 | Lifecycle gaps | Resolved | Mostly moot, and the rest is in the design | Does not arise |
| R16 | A network-folder refusal cannot be built | Resolved | `statfs` type 0 confirmed, and the refusal is dropped. See C6 | Does not arise |
| R17 | The proposed tests prove less than claimed | Accepted | Rewritten once, and C12 extends it | Applies to A's tests |
| R18 | Smaller points | Resolved | #23 and #24 | Resolved there too |
| C1 | Detecting a replaced file does not keep exclusion | **Open** | Confirmed: macOS allows the rename, as measured, and an owner can act until it notices. The identity check narrows the window and does not close it | No kernel lock to lose |
| C2 | The first new acquire is not serialised with old starters | **Open** | Confirmed from `storage.mjs`. A half-written record cannot be told from a dead new owner's | Same format, same `wx` |
| C3 | Old `stop` and `recover` can delete a new owner's state | **Open** | Confirmed in `install.mjs`. The plan's rows for these cases are wrong | Old `recover` beside a takeover stays a window |
| C4 | `recover --kill` cannot know the pid is the current holder | **Open** | Reasoned, not reproduced. "A live holder wrote it" proves the past only | Not built |
| C5 | Busy and a timeout do not prove a watcher exists | **Open** | Reasoned, consistent with the measured reader interference. Zero failures in a run prove no ordering | No busy state |
| C6 | Network folders may not fail loudly | **Open** | Not reproduced, and SQLite's own warning stands. The plan's sentence is withdrawn | No kernel lock. Pid and boot tests are no proof between two machines sharing a state root |
| C7 | Node 22.13 has no `timeout` option | Accepted | Confirmed from Node's source: absent at v22.13.0 and v22.15.0, present at v22.16.0 and v24.0.0. The warning is emitted at all four. The floor must rise or use `PRAGMA busy_timeout`. Node 23 not checked | No `node:sqlite` |
| C8 | The updater that must check a new floor is the old one | **Open** | Confirmed: `automatic-updates.mjs` stops the watcher first, and `engine-store.mjs` does not read `engines` | No new floor |
| C9 | A truncated result stops recovery; requests are not durable | **Open** | **Run on Windows and macOS:** `recoverClaims` threw `SyntaxError` twice and the claim stayed. `atomicWriteJson` does not sync | **Still applies**, on `main` today. Own fix |
| C10 | Replacing a junk lock file repeats check-then-remove | **Open** | Reasoned, and the plan contradicts itself: `recover` must take the lock it cannot open | No kernel lock file |
| C11 | The SQLite protocol is incomplete | **Open** | Conditional, not reproduced. Exact SQL and journal modes are unspecified | No SQLite |
| C12 | Several tests can pass with the guarantees broken | Accepted | Confirmed by reading their failure conditions. Each needs a negative control | A's tests need the same |

**Not resolved, and stated:** R3, R4, R6, R7, R11, R14, C1 to C6 and C8 to C11 stay open on the full
design. That is the reason it is not recommended. Under Option A, R3, R4, R8, R11 and C9 remain and
need their own fixes, R12 returns in a narrow form, and C3 and C6 leave stated windows.

**R3 stopped at the gate.** Leaving a stopped review's claim unresolved is a small change, but a
claimed request has no durable cancel: a cancel during a review removes nothing, and recovery
brings the request back. Recording the cancel closed most of it. The gate then found recovery can
read "no result" just before the cancel writes one. The cost is one abandoned review run again,
and no false verdict, but closing it means another step of the kind this plan warns about. That
work stopped there, unpublished, for the maintainer to decide.

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

**Whichever option is chosen.** These stand alone and depend on no design:

1. `git.mjs`'s `EPERM` reading: #24.
2. The hook starts a watcher before it can refuse and during its wait (R4, R11): stopped at the gate
   both ways, for the maintainer to decide.
3. A stop during a review (R3): stopped at the gate, for the maintainer to decide.
4. A truncated result must not stop `recoverClaims` (C9): not started.
5. Startup cleanup moves into the retrying loop (R8): not started.

**For Option A:**

1. A review of Option A before any code, by a reader who has not seen this plan's argument for it.
   If it fails, stop at Option C rather than repair it.
2. Run a real restart on Windows and macOS, and Windows Fast Startup on a client edition.
3. The rule, the marker and tests that pause between each step and hold two starters at the same
   point. It should reach one project on a pinned engine before a release turns it on everywhere.

**If the full design is ever chosen,** C1 to C11 need answers first, beginning with the transition
from old engines. Its work is then: measure the floor, the lock module, one "who owns this"
reader, the watcher taking the lock, the queue's kernel lock, and a real restart recorded in the
[validation record](../validation.md).

Until then, a restart needs `recover` and `install`, and `watcher.state` says so.
