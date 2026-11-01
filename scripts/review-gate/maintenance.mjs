import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.mjs';

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function processStartedAt(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid < 1) return null;
  try {
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$sentinelOwner = Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$sentinelOwner.StartTime).ToUnixTimeMilliseconds()`],
    { timeoutMs: 5000, maxOutputBytes: 4096 });
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; } // Access denial cannot justify reclaiming a live owner's lease.
}
let ownStart;

/** When a process started, on any platform; null when that cannot be read. */
export async function processStartTime(pid, { run = runProcess, platform = process.platform } = {}) {
  if (platform === 'win32') return processStartedAt(pid);
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const result = await run('ps', ['-o', 'lstart=', '-p', String(pid)],
      { timeoutMs: 5000, maxOutputBytes: 4096, env: { ...process.env, LC_ALL: 'C' } });
    const value = Date.parse(result.stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

/**
 * True only with proof that the process that wrote a record at `writtenAt` is
 * gone: its id no longer exists, or the process holding that id started after
 * the record was written, as a reused id after a restart does. A process that
 * cannot be inspected is not proof.
 */
export async function processIsGone(pid, writtenAt, { isAlive = alive, startedAt = processStartTime } = {}) {
  if (!isAlive(pid)) return true;
  if (!Number.isInteger(pid) || pid < 1 || !Number.isFinite(writtenAt)) return false;
  const observed = await startedAt(pid);
  return observed !== null && observed > writtenAt + 1000;
}

async function entriesOf(directory) {
  return await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
}

async function writtenAt(file) {
  const details = await stat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  return details?.mtimeMs ?? null;
}

/**
 * The work whose owner may still run, described for a refusal: review leases,
 * claims, and a queue submission in progress. A queued request has no owner: it
 * is what a watcher is for. A record whose owner cannot be read counts as live.
 */
export async function liveWork(paths, { gone = processIsGone } = {}) {
  const live = [];
  const check = async (label, pid, file) => {
    const at = await writtenAt(file);
    if (at !== null && !(await gone(pid, at))) live.push(label);
  };
  const leases = path.join(paths.root, 'active-reviews');
  for (const entry of await entriesOf(leases)) {
    await check(`review lease ${entry}`, Number(/^(\d+)-/.exec(entry)?.[1]), path.join(leases, entry));
  }
  for (const entry of await entriesOf(paths.claims)) {
    if (entry.endsWith('.claim')) {
      await check(`claim ${entry}`, Number(/\.(\d+)\.[^.]+\.claim$/.exec(entry)?.[1]), path.join(paths.claims, entry));
    } else if (entry.endsWith('.lock')) {
      const file = path.join(paths.claims, entry);
      const pid = await readFile(file, 'utf8').then((text) => Number(text.trim()), (error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (pid !== null) await check(`claim lock ${entry}`, pid, file);
    }
  }
  const submitter = await submitterPid(paths);
  if (submitter !== undefined) await check('a queue submission', submitter, paths.queueSubmitLock);
  return live;
}

async function submitterPid(paths) {
  const text = await readFile(paths.queueSubmitLock, 'utf8').catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (text === undefined) return undefined;
  try { return JSON.parse(text)?.pid ?? null; } catch { return null; }
}

/**
 * True when a queue submission lock is left by a process that is gone. Such a
 * lock cannot be replaced while it exists, so it can be removed after this.
 */
export async function submissionIsAbandoned(paths, { gone = processIsGone } = {}) {
  const pid = await submitterPid(paths);
  if (pid === undefined) return false;
  const at = await writtenAt(paths.queueSubmitLock);
  return at !== null && await gone(pid, at);
}

export const updateMarker = (paths) => path.join(paths.root, 'update-in-progress.json');

/** Readers register before a second check; an updater excludes subsequent readers. */
export async function acquireReviewLease(paths) {
  const marker = updateMarker(paths);
  const refuse = () => new Error(`Sentinel is being updated. Retry after it finishes; inspect ${marker} if interrupted.`);
  if (await exists(marker)) throw refuse();
  const directory = path.join(paths.root, 'active-reviews');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  ownStart ??= processStartedAt(process.pid);
  await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: await ownStart }), { flag: 'wx', mode: 0o600 });
  if (await exists(marker)) { await rm(file); throw refuse(); }
  return () => rm(file, { force: true });
}

/** Interrupted updates remain fenced until their recorded recovery is completed. */
export async function acquireUpdateLease(paths, details, { isAlive = alive, startedAt = processStartedAt } = {}) {
  await mkdir(paths.root, { recursive: true });
  const marker = updateMarker(paths);
  try {
    await writeFile(marker, JSON.stringify({ ...details, pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another or interrupted update exists: ${marker}. Inspect it before retrying.`);
    throw error;
  }
  const release = () => rm(marker, { force: true });
  try {
    const directory = path.join(paths.root, 'active-reviews');
    const entries = await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      const file = path.join(directory, entry);
      let owner;
      try { owner = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        if (!(error instanceof SyntaxError)) throw error;
        owner = null;
      }
      if (!Number.isInteger(owner?.pid) || owner.pid < 1) {
        // The exclusive filename identifies even a lease whose writer crashed mid-write.
        const match = entry.match(/^(\d+)-[0-9a-f-]{36}\.json$/i);
        if (!match) throw new Error(`Unrecognized corrupt review lease: ${file}. Inspect it before updating.`);
        owner = { pid: Number(match[1]) };
      }
      let live = isAlive(owner?.pid);
      if (live) {
        const observedStart = await startedAt(owner?.pid);
        if (observedStart !== null) {
          if (Number.isFinite(owner?.startedAt) && owner.startedAt > 0) live = observedStart === owner.startedAt;
          else {
            // Legacy/truncated records have no start stamp. A process born after
            // this immutable file cannot be its writer, even if the PID matches.
            const details = await stat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
            if (!details) continue;
            live = observedStart <= details.mtimeMs + 1000;
          }
        } else live = isAlive(owner?.pid);
      }
      if (live) throw new Error(`A foreground or watcher review is active. Let it finish before updating. Lease: ${file}`);
      await rm(file, { force: true });
    }
    return release;
  } catch (error) { await release(); throw error; }
}
