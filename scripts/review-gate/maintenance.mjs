import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
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
  await writeFile(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  if (await exists(marker)) { await rm(file); throw refuse(); }
  return () => rm(file, { force: true });
}

/** Interrupted updates remain fenced until their recorded recovery is completed. */
export async function acquireUpdateLease(paths, details) {
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
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (alive(owner.pid)) throw new Error('A foreground or watcher review is active. Let it finish before updating.');
      await rm(file, { force: true });
    }
    return release;
  } catch (error) { await release(); throw error; }
}
