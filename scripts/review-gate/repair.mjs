import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activationRuns, automaticUpdate, rollBackInterruptedUpdate, updateInformation, UPDATE_PAUSE,
} from './automatic-updates.mjs';
import { engineRoot, engineStatePath, inspectStoreLock, removeStaleStoreLock, retainedVersions } from './engine-store.mjs';
import { createGateContext } from './gate.mjs';
import { recoverStaleDaemonState, startWatcher } from './install.mjs';
import { processStartedAt, updateMarker } from './maintenance.mjs';
import { isSafetyPause, REPAIR_COMMAND, runProcess } from './process.mjs';
import { CHARTER_VERSION, GATE_VERSION } from './constants.mjs';
import { reviewPolicySnapshot } from './context.mjs';
import {
  daemonOwnerIsHealthy, isProcessAlive, readJson, recordEvent, resumeGate,
} from './storage.mjs';

const ownCli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const STOP_ORPHANS = `${REPAIR_COMMAND} --stop-orphans`;
// Two start times of one process, read by two system calls, agree within this.
const START_TOLERANCE_MS = 2_000;
// A download installs within this (two bounded fetches and one npm install).
const DOWNLOAD_BOUND_MS = 15 * 60_000;
const EXCERPT = 240;

const comparable = (value) => {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
// A record its writer never finished, left this long, has no writer left.
const UNFINISHED_RECORD_MS = 10 * 60_000;
const ageOf = async (file, now) => {
  try { return now - (await stat(file)).mtimeMs; } catch { return null; }
};
const parse = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };

/**
 * Every process of this OS user that the system lists: PID, parent PID, name,
 * command line and start time (milliseconds since the epoch, or null).
 */
export async function listProcesses({ platform = process.platform, run = runProcess } = {}) {
  if (platform === 'win32') {
    const script = "$ErrorActionPreference = 'Stop'; $list = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine; startedAt = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } }); ConvertTo-Json -InputObject $list -Compress -Depth 2";
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 });
    const parsed = JSON.parse(result.stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: entry.pid, ppid: entry.ppid, name: entry.name || '', commandLine: entry.commandLine || '',
      startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : null,
    }));
  }
  const result = await run('ps', ['-axo', 'pid=,ppid=,lstart=,args='], { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 });
  return result.stdout.split(/\r?\n/).map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/))
    .filter(Boolean).map(([, pid, ppid, lstart, args]) => ({
      pid: Number(pid), ppid: Number(ppid), name: path.basename(args.split(/\s+/)[0] || ''), commandLine: args,
      startedAt: Number.isFinite(Date.parse(lstart)) ? Date.parse(lstart) : null,
    }));
}

/**
 * The Sentinel review directories a command line names: a provider runs with
 * its review context (`rove-review-context-…`) or checkout (`rove-review-…`) as
 * an argument. Quoted paths may hold spaces; unquoted ones end at a space.
 */
export function reviewDirectoriesIn(commandLine) {
  const text = String(commandLine || '');
  const found = new Set();
  for (const match of text.matchAll(/rove-review-[A-Za-z0-9_.-]+/g)) {
    const before = text.slice(0, match.index);
    const quotes = (before.match(/"/g) || []).length;
    const start = quotes % 2 === 1 ? before.lastIndexOf('"') + 1 : Math.max(before.lastIndexOf(' '), before.lastIndexOf('='), before.lastIndexOf("'")) + 1;
    const prefix = before.slice(start);
    if (!/[\\/]$/.test(prefix) || !/^(?:[A-Za-z]:)?[\\/]/.test(prefix)) continue;
    found.add(`${prefix}${match[0]}`);
  }
  return [...found];
}

async function readOwner(directory) {
  try { return JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')); }
  catch { return null; }
}

/** PIDs of reviews running now in a state folder: a lease whose process is alive and is the one that wrote it. */
async function liveLeaseOwners(stateRoot, byPid) {
  const directory = path.join(stateRoot, 'active-reviews');
  const owners = new Set();
  for (const entry of await readdir(directory).catch(() => [])) {
    const lease = await readJson(path.join(directory, entry)).catch(() => null);
    const pid = Number.isInteger(lease?.pid) ? lease.pid : Number(entry.match(/^(\d+)-/)?.[1]);
    const proc = byPid.get(pid);
    if (!proc) continue;
    if (Number.isFinite(lease?.startedAt) && proc.startedAt !== null && Math.abs(proc.startedAt - lease.startedAt) > START_TOLERANCE_MS) continue;
    owners.add(pid);
  }
  return owners;
}

/** Live review leases in every Sentinel state folder of this OS user. */
async function anyLiveReview(stateRoot, byPid) {
  const base = path.dirname(stateRoot);
  for (const entry of await readdir(base).catch(() => [])) {
    if ((await liveLeaseOwners(path.join(base, entry), byPid)).size) return true;
  }
  return false;
}

const describe = (proc, why) => ({
  pid: proc.pid, name: proc.name, startedAt: proc.startedAt === null ? null : new Date(proc.startedAt).toISOString(),
  commandLine: proc.commandLine.length > EXCERPT ? `${proc.commandLine.slice(0, EXCERPT)}…` : proc.commandLine, why,
});

/**
 * Processes left by this repository's reviews, which no running review owns:
 * - `repository`: its command line names a review directory whose owner record
 *   names this repository's checkout (or the watcher's), and the process that
 *   owns that directory holds no live review lease; or it descends from the
 *   provider recorded in this repository's safety pause and started before it;
 * - `unattributed`: it names a review directory that no longer has an owner
 *   record, so the repository is unknown; Sentinel stops it only when no review
 *   runs in any Sentinel state folder of this OS user;
 * and the live descendants of either. A process that names another repository's
 * review directory is that repository's and is never listed.
 */
export async function findOrphans(context, { processes, pause = null, heartbeat = null, readOwnerRecord = readOwner } = {}) {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const leases = await liveLeaseOwners(context.paths.root, byPid);
  const checkouts = new Set([context.repoRoot, heartbeat?.repoRoot].filter(Boolean).map(comparable));
  for (const checkout of [...checkouts]) checkouts.add(comparable(await realpath(checkout).catch(() => checkout)));
  const roots = new Map();
  const pausedAt = Date.parse(pause?.pausedAt);
  const provider = Number.isInteger(pause?.provider?.pid) ? pause.provider.pid : null;
  for (const proc of processes) {
    if (proc.pid === process.pid) continue;
    for (const directory of reviewDirectoriesIn(proc.commandLine)) {
      const owner = await readOwnerRecord(directory);
      if (!owner) { roots.set(proc.pid, { proc, kind: 'unattributed', why: `names ${directory}, which has no owner record` }); break; }
      if (!checkouts.has(comparable(owner.repoRoot))) continue;
      if (leases.has(owner.pid)) continue;
      roots.set(proc.pid, { proc, kind: 'repository', why: `names ${directory}, a review directory of this repository whose owner PID ${owner.pid} runs no review` });
      break;
    }
    if (!roots.has(proc.pid) && provider !== null && Number.isFinite(pausedAt) && proc.startedAt !== null && proc.startedAt <= pausedAt
      && (proc.pid === provider || proc.ppid === provider)) {
      roots.set(proc.pid, { proc, kind: 'repository', why: `is the provider process ${provider} of this repository's paused review, or its child` });
    }
  }
  // Descendants, by the parent PIDs of live processes, of anything found above.
  const found = new Map(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of processes) {
      if (found.has(proc.pid) || proc.pid === process.pid) continue;
      const parent = found.get(proc.ppid);
      if (parent && (parent.proc.startedAt === null || proc.startedAt === null || proc.startedAt >= parent.proc.startedAt)) {
        found.set(proc.pid, { proc, kind: parent.kind, why: `descends from PID ${parent.proc.pid}` });
        grew = true;
      }
    }
  }
  return [...found.values()].map(({ proc, kind, why }) => ({ ...describe(proc, why), kind, rawStartedAt: proc.startedAt }));
}

/**
 * Stops listed processes, children first, each only while its PID still has
 * the start time it was listed with. Returns the ones it stopped.
 */
export async function stopProcesses(targets, { platform = process.platform, run = runProcess, list = listProcesses, kill = process.kill } = {}) {
  const now = new Map((await list({ platform, run })).map((proc) => [proc.pid, proc]));
  const stopped = [];
  for (const target of [...targets].reverse()) {
    const current = now.get(target.pid);
    if (!current || (target.rawStartedAt !== null && current.startedAt !== null && Math.abs(current.startedAt - target.rawStartedAt) > START_TOLERANCE_MS)) continue;
    if (platform === 'win32') await run('taskkill.exe', ['/PID', String(target.pid), '/F'], { allowFailure: true, timeoutMs: 30_000 });
    else { try { kill(target.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; } }
    stopped.push(target.pid);
  }
  return stopped;
}

/** Whether the process holding the watcher lock is the one that wrote it, and is this repository's watcher. */
function watcherLockOwner(lock, byPid, repoRoot) {
  const proc = byPid.get(lock?.pid);
  if (!proc) return { state: 'gone', why: `its PID ${lock?.pid} is not running` };
  const written = Date.parse(lock.startedAt);
  if (proc.startedAt !== null && Number.isFinite(written) && proc.startedAt > written + START_TOLERANCE_MS) {
    return { state: 'gone', why: `PID ${lock.pid} now belongs to a process started at ${new Date(proc.startedAt).toISOString()}, after the lock was written` };
  }
  const normal = (text) => String(text).replaceAll('\\', '/').toLowerCase();
  const line = normal(proc.commandLine);
  const isWatcher = line.includes(' watch') && line.includes('--daemon') && line.includes(normal(repoRoot));
  return { state: isWatcher ? 'watcher' : 'other', proc };
}

/**
 * Finds what keeps this repository's reviews or updates blocked, verifies each
 * with the same checks a careful person would make, acts when they pass, and
 * otherwise stops with the processes or records that failed them and the exact
 * command to run next. Every action is recorded with its evidence in the
 * repository's events.
 */
export async function repairRepository({ repoRoot = process.cwd(), dryRun = false, stopOrphans = false } = {}, deps = {}) {
  const {
    contextFor = createGateContext, root = engineRoot(), platform = process.platform, run = runProcess,
    list = listProcesses, stop = stopProcesses, startWatcherFn = startWatcher, recover = recoverStaleDaemonState,
    rollBack = rollBackInterruptedUpdate, update = automaticUpdate, info = updateInformation,
    isAlive = isProcessAlive, startedAt = processStartedAt, waitMs = 30_000, now = Date.now,
    reinstall = async (repo) => run(process.execPath, [ownCli, 'install', '--preserve-policy', '--repo', repo],
      { cwd: repo, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024 }),
  } = deps;
  const context = await contextFor(repoRoot);
  const { paths } = context;
  const steps = [];
  const step = (entry) => { steps.push(entry); return entry; };
  const audit = (action, evidence) => (dryRun ? null : recordEvent(paths, { type: 'repair', action, ...evidence }));
  let processes = null;
  const snapshot = async () => (processes ??= await list({ platform, run }));
  const fresh = async () => { processes = null; return snapshot(); };

  // 1. The shared engine store's download lock.
  const storeLock = await inspectStoreLock(root, { isAlive, startedAt });
  if (storeLock.state === 'stale') {
    if (dryRun) step({ state: 'store-lock', status: 'would-fix', detail: `download.lock is stale: ${storeLock.why}. Repair removes it and its staging folder.` });
    else if (await removeStaleStoreLock(root, storeLock, { reason: 'repair', isAlive })) {
      await audit('store-lock-removed', { why: storeLock.why, owner: storeLock.owner ?? null });
      step({ state: 'store-lock', status: 'fixed', detail: `Removed the engine store's download.lock: ${storeLock.why}.` });
    } else step({ state: 'store-lock', status: 'blocked', detail: 'Another process replaced or is removing download.lock.', next: `Run again in one minute: ${REPAIR_COMMAND}` });
  } else if (storeLock.state === 'live') {
    step({ state: 'store-lock', status: 'busy', detail: `PID ${storeLock.owner?.pid ?? 'unknown'} is installing engine ${storeLock.owner?.version ?? 'unknown'} in the shared store (${storeLock.why}).`, next: `Run again in ${Math.round(DOWNLOAD_BOUND_MS / 60_000)} minutes: ${REPAIR_COMMAND}` });
  }

  // 2. An activation whose process is gone. A fence that never got its owner
  // written is gone once it is UNFINISHED_RECORD_MS old.
  const markerRaw = await readFile(updateMarker(paths), 'utf8').catch(() => null);
  let marker = markerRaw === null ? null : parse(markerRaw);
  let unfinished = false;
  if (markerRaw !== null && marker === undefined) {
    const age = await ageOf(updateMarker(paths), now());
    if (age !== null && age > UNFINISHED_RECORD_MS) { unfinished = true; marker = { pid: null, version: 'unknown' }; }
    else {
      step({ state: 'interrupted-activation', status: 'busy', detail: 'An update fence is being written.', next: `Run again in ten minutes: ${REPAIR_COMMAND}` });
      marker = null;
    }
  }
  if (marker) {
    if (!unfinished && await activationRuns(marker, { isAlive, startedAt })) {
      step({ state: 'interrupted-activation', status: 'busy', detail: `An update to ${marker.version} is activating now (PID ${marker.pid}).`, next: `Run again in five minutes: ${REPAIR_COMMAND}` });
    } else if (dryRun) {
      step({ state: 'interrupted-activation', status: 'would-fix', detail: `The activation of ${marker.version} stopped (PID ${marker.pid} is gone). Repair restores the engine and policy recorded in update-recovery.json, verifies its watcher, then removes the fence and its pause.` });
    } else {
      try {
        const result = await rollBack(context, { isAlive: unfinished ? () => false : isAlive, startedAt, root, unfinished });
        await audit('interrupted-activation-rolled-back', { markerPid: marker.pid, version: result.version, nextVersion: result.nextVersion });
        step({ state: 'interrupted-activation', status: 'fixed', detail: `Rolled back the interrupted activation of ${result.nextVersion ?? marker.version}; ${result.version} runs again.` });
      } catch (error) {
        step({ state: 'interrupted-activation', status: 'blocked', detail: `The interrupted activation could not be rolled back: ${error?.message || String(error)}`, next: `Run again once the cause above is gone: ${REPAIR_COMMAND}` });
      }
    }
  }

  // 3. Records that only count or report, and cannot be read: removing them loses nothing.
  for (const [name, file] of [['github-failure', paths.githubFailure]]) {
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (raw !== null && parse(raw) === undefined) {
      if (dryRun) step({ state: name, status: 'would-fix', detail: `${path.basename(file)} cannot be read; repair removes it.` });
      else { await rm(file, { force: true }); await audit(`${name}-removed`, { file }); step({ state: name, status: 'fixed', detail: `Removed ${path.basename(file)}, which could not be read.` }); }
    }
  }
  const policyRaw = await readFile(paths.policy, 'utf8').catch(() => null);
  if (policyRaw !== null && parse(policyRaw) === undefined) {
    step({ state: 'policy', status: 'blocked', detail: 'The installed policy cannot be read.', next: "Run from the repository's trusted checkout: npx --no-install rove-sentinel install" });
  }
  // A daemon-lock replacement lasts milliseconds; its marker, this old, has no holder.
  const takeoverAge = await ageOf(paths.takeover, now());
  if (takeoverAge !== null && takeoverAge > UNFINISHED_RECORD_MS) {
    if (dryRun) step({ state: 'takeover-marker', status: 'would-fix', detail: `${paths.takeover} is ${Math.round(takeoverAge / 60_000)} minutes old; repair removes it.` });
    else {
      await rm(paths.takeover, { force: true });
      await audit('takeover-marker-removed', { ageMs: takeoverAge });
      step({ state: 'takeover-marker', status: 'fixed', detail: `Removed ${paths.takeover}, left ${Math.round(takeoverAge / 60_000)} minutes ago by a watcher start that died.` });
    }
  } else if (takeoverAge !== null) {
    step({ state: 'takeover-marker', status: 'busy', detail: 'A watcher start is replacing the daemon lock.', next: `Run again in ten minutes: ${REPAIR_COMMAND}` });
  }
  // 4. A pause, before any recovery removes the review directories that tell
  // this repository's leftover processes apart.
  await repairPause();
  // 5. The watcher.
  const watcher = await repairWatcher();
  // 6. The review queue's submission lock.
  await repairQueueLock(watcher);
  // 7. An update waiting, or failed.
  await repairUpdate();

  const blocked = steps.filter((entry) => entry.status === 'blocked');
  return { repository: context.repoRoot, stateRoot: context.stateRoot, dryRun, ok: blocked.length === 0, steps };

  async function repairWatcher() {
    const lockRaw = await readFile(paths.lock, 'utf8').catch(() => null);
    const heartbeat = await readJson(paths.heartbeat).catch(() => null);
    let lock = lockRaw === null ? null : parse(lockRaw);
    if (lockRaw !== null && (lock === undefined || !Number.isInteger(lock?.pid))) {
      const age = await ageOf(paths.lock, now());
      if (age === null || age <= UNFINISHED_RECORD_MS) {
        step({ state: 'watcher', status: 'busy', detail: 'The watcher lock is being written by a starting watcher.', next: `Run again in ten minutes: ${REPAIR_COMMAND}` });
        return { running: false };
      }
      lock = { pid: null, startedAt: null };
    }
    if (daemonOwnerIsHealthy(lock, heartbeat)) return await repairOutdatedWatcher(heartbeat);
    const byPid = new Map((await snapshot()).map((proc) => [proc.pid, proc]));
    let ownerGone = !lock;
    let why = lock ? null : 'no watcher holds the lock';
    if (lock && lock.pid === null) { ownerGone = true; why = `its lock has no owner and is over ${UNFINISHED_RECORD_MS / 60_000} minutes old`; }
    else if (lock) {
      const owner = watcherLockOwner(lock, byPid, heartbeat?.repoRoot ?? context.repoRoot);
      if (owner.state === 'gone') { ownerGone = true; why = owner.why; }
      else {
        // A watcher that is starting beats within seconds.
        const until = now() + waitMs;
        while (now() < until) {
          const [l, h] = await Promise.all([readJson(paths.lock).catch(() => null), readJson(paths.heartbeat).catch(() => null)]);
          if (daemonOwnerIsHealthy(l, h)) return { running: true, heartbeat: h };
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        const target = { ...describe(owner.proc, 'holds the watcher lock without a heartbeat'), kind: 'watcher', rawStartedAt: owner.proc.startedAt };
        if (owner.state !== 'watcher') {
          step({ state: 'watcher', status: 'blocked', detail: `PID ${lock.pid} holds the watcher lock without a heartbeat, and its command line is not this repository's watcher.`, processes: [target], next: `Run again in two minutes: ${REPAIR_COMMAND}` });
          return { running: false };
        }
        if (!stopOrphans || dryRun) {
          step({ state: 'watcher', status: dryRun && stopOrphans ? 'would-fix' : 'blocked', detail: `This repository's watcher (PID ${lock.pid}) runs without a heartbeat for ${Math.round(waitMs / 1000)} seconds.`, processes: [target], next: STOP_ORPHANS });
          return { running: false };
        }
        await stop([target], { platform, run, list });
        await audit('hung-watcher-stopped', { process: target });
        ownerGone = true;
        why = `its watcher PID ${lock.pid} ran without a heartbeat and was stopped`;
      }
    }
    if (dryRun) {
      step({ state: 'watcher', status: 'would-fix', detail: `The watcher is not running (${why}). Repair clears its stale state and starts it the way install does.` });
      return { running: false };
    }
    if (lock && ownerGone) {
      try {
        await recover(context, { reason: `repair: the watcher lock's owner is gone (${why})` });
        await audit('watcher-recovered', { why, lockPid: lock.pid });
      } catch (error) {
        step({ state: 'watcher', status: 'blocked', detail: `Could not clear the stopped watcher's state: ${error?.message || String(error)}`, next: `Run again in one minute: ${REPAIR_COMMAND}` });
        return { running: false };
      }
    }
    const daemonError = await readJson(paths.daemonError).catch(() => null);
    // Without a scheduler, only a watcher that has run before is started again.
    if (!['win32', 'darwin'].includes(platform) && !lock && !heartbeat && !daemonError) {
      step({ state: 'watcher', status: 'ok', detail: 'No watcher has run for this repository on this computer.' });
      return { running: false, installed: false };
    }
    const started = await startWatcherFn(context, { platform, run });
    if (started.started) {
      await audit('watcher-started', { why, pid: started.pid ?? null });
      step({ state: 'watcher', status: 'fixed', detail: `Started the watcher (PID ${started.pid ?? 'unknown'}); it had stopped: ${why}.` });
      return { running: true };
    }
    if (!lock && !heartbeat && /no scheduled watcher/.test(started.reason ?? '')) {
      step({ state: 'watcher', status: 'ok', detail: 'No watcher is installed for this repository.' });
      return { running: false, installed: false };
    }
    step({ state: 'watcher', status: 'blocked', detail: `The watcher did not start: ${started.reason}`, next: started.next ?? `Run: ${REPAIR_COMMAND}` });
    return { running: false };
  }

  /** A live watcher of another engine or installed policy, which activation waits out for ever. */
  async function repairOutdatedWatcher(heartbeat) {
    let digest = null;
    try { digest = reviewPolicySnapshot(await readJson(paths.policy)).policyDigest; } catch { digest = null; }
    if (heartbeat.gateVersion === GATE_VERSION && heartbeat.charterVersion === CHARTER_VERSION && (!digest || heartbeat.policyDigest === digest)) {
      return { running: true, heartbeat };
    }
    const detail = `The watcher runs ${heartbeat.gateVersion ?? 'an unknown engine'}${digest && heartbeat.policyDigest !== digest ? ' with another policy than the installed one' : ''}; this engine is ${GATE_VERSION}.`;
    if (comparable(heartbeat.repoRoot ?? context.repoRoot) !== comparable(context.repoRoot)) {
      step({ state: 'watcher', status: 'blocked', detail: `${detail} It runs from another checkout.`, next: `Run in ${heartbeat.repoRoot}: ${REPAIR_COMMAND}` });
      return { running: true, heartbeat };
    }
    const byPid = new Map((await snapshot()).map((proc) => [proc.pid, proc]));
    if (heartbeat.activity === 'review' || (await liveLeaseOwners(paths.root, byPid)).size) {
      step({ state: 'watcher', status: 'busy', detail: `${detail} A review runs now; restarting would end it.`, next: `Run again in ten minutes: ${REPAIR_COMMAND}` });
      return { running: true, heartbeat };
    }
    if (dryRun) { step({ state: 'watcher', status: 'would-fix', detail: `${detail} Repair restarts it with install --preserve-policy, which keeps the installed policy.` }); return { running: true, heartbeat }; }
    try {
      await reinstall(context.repoRoot);
      await audit('outdated-watcher-restarted', { from: heartbeat.gateVersion ?? null, to: GATE_VERSION });
      step({ state: 'watcher', status: 'fixed', detail: `${detail} Restarted it with the installed policy.` });
    } catch (error) {
      step({ state: 'watcher', status: 'blocked', detail: `${detail} Restarting it failed: ${error?.message || String(error)}`, next: `Run again in ten minutes: ${REPAIR_COMMAND}` });
    }
    return { running: true, heartbeat };
  }

  async function repairQueueLock(watcher) {
    let raw;
    try { raw = await readFile(paths.queueSubmitLock, 'utf8'); } catch { return; }
    let owner = null;
    try { owner = JSON.parse(raw); } catch { owner = null; }
    if (!Number.isInteger(owner?.pid) || isAlive(owner.pid)) return;
    if (dryRun) { step({ state: 'queue-lock', status: 'would-fix', detail: `The review queue's submission lock belongs to PID ${owner.pid}, which is not running. Repair removes it.` }); return; }
    // Unchanged since it was judged: a submitter that replaced it keeps its lock.
    const current = await readFile(paths.queueSubmitLock, 'utf8').catch(() => null);
    if (current !== raw) return;
    await rm(paths.queueSubmitLock, { force: true });
    await audit('queue-lock-removed', { pid: owner.pid, watcherRunning: Boolean(watcher?.running) });
    step({ state: 'queue-lock', status: 'fixed', detail: `Removed the review queue's submission lock of PID ${owner.pid}, which is not running.` });
  }

  async function repairPause() {
    let paused;
    try { paused = await readJson(paths.paused); }
    catch (error) {
      step({ state: 'pause', status: 'blocked', detail: `The pause record cannot be read (${error?.message || String(error)}), so whether a person or a failed cleanup paused reviews is unknown.`, next: 'Run: npx --no-install rove-sentinel resume' });
      return;
    }
    if (!paused) return;
    const reason = String(paused.reason ?? '');
    if (reason.startsWith(UPDATE_PAUSE)) {
      const fence = await readJson(updateMarker(paths)).catch(() => null);
      if (fence && await activationRuns(fence, { isAlive, startedAt })) return;
      if (dryRun) { step({ state: 'pause', status: 'would-fix', detail: 'An update left its pause with no activation running. Repair lifts it.' }); return; }
      await resumeGate(paths);
      await audit('update-pause-lifted', { pause: paused });
      step({ state: 'pause', status: 'fixed', detail: 'Lifted the pause an update left with no activation running.' });
      return;
    }
    if (!isSafetyPause(paused)) {
      step({ state: 'pause', status: 'blocked', detail: `A person paused reviews (${paused.pausedAt}): ${reason}. Repair never lifts a person's pause.`, next: 'Only if the person who asked for this repair asked you to lift that pause, run: npx --no-install rove-sentinel resume' });
      return;
    }
    const heartbeat = await readJson(paths.heartbeat).catch(() => null);
    let orphans = await findOrphans(context, { processes: await snapshot(), pause: paused, heartbeat });
    if (orphans.length && stopOrphans && !dryRun) {
      const byPid = new Map((await snapshot()).map((proc) => [proc.pid, proc]));
      const anyReview = orphans.some((orphan) => orphan.kind === 'unattributed') && await anyLiveReview(context.stateRoot, byPid);
      const stoppable = orphans.filter((orphan) => orphan.kind === 'repository' || !anyReview);
      const stopped = await stop(stoppable, { platform, run, list });
      await audit('orphans-stopped', { pause: paused, stopped, processes: stoppable });
      orphans = await findOrphans(context, { processes: await fresh(), pause: paused, heartbeat });
      if (orphans.length && anyReview) {
        step({ state: 'pause', status: 'blocked', detail: `Paused (${paused.pausedAt}): ${reason}. ${orphans.length} process(es) name review directories with no owner record, and a review runs now in another repository, so they may be its.`, processes: orphans, next: `Run again once that review finishes: ${STOP_ORPHANS}` });
        return;
      }
    }
    if (orphans.length) {
      step({ state: 'pause', status: dryRun && stopOrphans ? 'would-fix' : 'blocked', detail: `Paused (${paused.pausedAt}): ${reason}. ${orphans.length} process(es) left by this repository's reviews still run, and no running review owns them.`, processes: orphans, next: STOP_ORPHANS });
      return;
    }
    if (dryRun) { step({ state: 'pause', status: 'would-fix', detail: `Paused (${paused.pausedAt}): ${reason}. No process of this repository's reviews remains; repair resumes.` }); return; }
    await resumeGate(paths);
    await audit('safety-pause-lifted', { pause: paused, processesChecked: (await snapshot()).length });
    step({ state: 'pause', status: 'fixed', detail: `Resumed: no process left by this repository's reviews remains (${(await snapshot()).length} processes checked). The pause was: ${reason}` });
  }

  async function repairUpdate() {
    const information = await info(paths);
    if (information.automatic !== true || platform !== 'win32') return;
    const phase = information.phase;
    if (!['waiting', 'download-failed', 'failed'].includes(phase)) return;
    if (information.blockedBy.length) {
      step({ state: 'update', status: 'blocked', detail: `Rove Sentinel ${information.pendingVersion} cannot activate yet: ${information.blockedBy.map((hold) => hold.kind).join(', ')} (see the steps above).`, next: `Run again after following the steps above: ${REPAIR_COMMAND}` });
      return;
    }
    if (dryRun) { step({ state: 'update', status: 'would-fix', detail: `The update is ${phase}. Repair retries it now.` }); return; }
    const result = await update({ repoRoot: context.repoRoot, force: true });
    await audit('update-retried', { phase, result: result.status, error: result.error ?? null });
    if (result.status === 'updated') { step({ state: 'update', status: 'fixed', detail: `Activated Rove Sentinel ${result.version}.` }); return; }
    if (['current', 'ahead'].includes(result.status)) { step({ state: 'update', status: 'ok', detail: 'No newer release is waiting.' }); return; }
    if (result.status === 'waiting') { step({ state: 'update', status: 'busy', detail: `Rove Sentinel ${result.version} waits for reviews to finish.`, next: `Run again in ten minutes: ${REPAIR_COMMAND}` }); return; }
    const error = result.error ?? (await readJson(engineStatePath(paths)).catch(() => null))?.lastError ?? result.status;
    if (/^Runtime storage is full/.test(String(error))) {
      const holders = await storeHolders(root);
      step({ state: 'update', status: 'blocked', detail: `${error}`, holders, next: holders.length ? `Run in each checkout listed: ${REPAIR_COMMAND}` : `Run again in ten minutes: ${REPAIR_COMMAND}` });
      return;
    }
    step({ state: 'update', status: 'blocked', detail: `The update failed: ${error}`, next: `Run again in ten minutes: ${REPAIR_COMMAND}` });
  }
}

/** The projects whose records keep every slot of a full store, for the agent to repair next. */
async function storeHolders(root) {
  const holders = [];
  for (const entry of await readdir(path.join(root, 'consumers')).catch(() => [])) {
    const record = await readJson(path.join(root, 'consumers', entry)).catch(() => null);
    if (record?.repoRoot) holders.push({ repoRoot: record.repoRoot, activeVersion: record.activeVersion ?? null, pendingVersion: record.pendingVersion ?? null });
  }
  const { required } = await retainedVersions(root);
  return holders.filter((holder) => required.has(holder.activeVersion) || required.has(holder.pendingVersion));
}

/** The report as lines; each blocked one ends with the command to run. */
export function formatRepair(report) {
  const lines = [`Rove Sentinel repair for ${report.repository}${report.dryRun ? ' (dry run: nothing changed)' : ''}:`];
  if (!report.steps.length) lines.push('  ok: nothing is blocked.');
  for (const entry of report.steps) {
    lines.push(`  ${entry.status}: ${entry.state}: ${entry.detail}`);
    for (const proc of entry.processes ?? []) lines.push(`    PID ${proc.pid} ${proc.name} started ${proc.startedAt ?? 'unknown'} ${proc.why}: ${proc.commandLine}`);
    for (const holder of entry.holders ?? []) lines.push(`    ${holder.repoRoot}: active ${holder.activeVersion ?? 'none'}, pending ${holder.pendingVersion ?? 'none'}`);
    if (entry.next) lines.push(`    Next: ${entry.next}`);
  }
  lines.push(report.ok ? 'Result: nothing is blocked now.' : 'Result: blocked; run each Next command above.');
  return lines.join('\n');
}

