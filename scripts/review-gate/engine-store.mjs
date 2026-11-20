import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { processStartedAt } from './maintenance.mjs';
import { runProcess } from './process.mjs';
import { atomicWriteJson, readJson, stateRootFor } from './storage.mjs';
import { RELEASE_REPOSITORY, compareVersions, releaseUrls, stableVersion } from './updates.mjs';

export const engineRoot = () => path.join(stateRootFor(`https://github.com/${RELEASE_REPOSITORY}`), 'engines');
export const engineStatePath = (paths) => path.join(paths.root, 'engine.json');
export function engineDirectory(version, root = engineRoot()) {
  if (!stableVersion(version)) throw new Error('Invalid runtime version.');
  return path.join(root, 'versions', version);
}
export const engineCli = (version, root) => path.join(engineDirectory(version, root), 'node_modules/rove-sentinel/scripts/review-gate/cli.mjs');
export const consumerRecord = (paths, root = engineRoot()) => path.join(root, 'consumers', `${path.basename(paths.root)}.json`);

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** All commands, including directly scheduled watchers, keep their immutable runtime alive. */
export function registerEngineProcess(version, cliPath, root = engineRoot()) {
  const expected = path.resolve(engineCli(version, root));
  if (path.resolve(cliPath) !== expected) return () => {};
  const directory = path.join(root, 'processes');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ pid: process.pid, version }), { flag: 'wx', mode: 0o600 });
  const release = () => { try { unlinkSync(file); } catch { /* Dead process records are reclaimed by the store. */ } };
  process.once('exit', release);
  return release;
}

export async function publishEngineState(paths, state, root = engineRoot()) {
  // Register first: collection must never delete a version before the local pointer is durable.
  await atomicWriteJson(consumerRecord(paths, root), {
    repoRoot: state.repoRoot, activeVersion: state.activeVersion, previousVersion: state.previousVersion,
    pendingVersion: state.pendingVersion,
  });
  await atomicWriteJson(engineStatePath(paths), { schemaVersion: 1, ...state });
}

/**
 * The engine a `repair` runs on: the newest of the launcher's own, the active
 * one and every verified ready copy in the shared store, and never one older
 * than the active engine, which it repairs. A newer engine knows every state an
 * older one leaves; an older one may not know the command at all.
 */
export async function repairEngine(paths, bundledCli, bundledVersion, root = engineRoot()) {
  const state = await readJson(engineStatePath(paths)).catch(() => null);
  const active = stableVersion(state?.activeVersion) ? state.activeVersion : null;
  const candidates = stableVersion(bundledVersion) ? [{ version: bundledVersion, cli: bundledCli }] : [];
  for (const version of (await readdir(path.join(root, 'versions')).catch(() => [])).filter(stableVersion)) {
    const ready = await readJson(path.join(engineDirectory(version, root), 'ready.json')).catch(() => null);
    const cli = engineCli(version, root);
    if (ready?.version === version && ready?.schemaVersion === 1 && await stat(cli).then(() => true, () => false)) candidates.push({ version, cli });
  }
  const eligible = candidates.filter((candidate) => !active || compareVersions(candidate.version, active) >= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!eligible.length) throw new Error(`No copy of the active engine ${active}, or of a newer one, is installed to repair this repository. Run from the repository's trusted checkout: npx --no-install rove-sentinel install`);
  return eligible[0].cli;
}

/**
 * Frees one slot of a full store, as a download would: versions nothing keeps,
 * then copies kept only for a rollback, oldest first; never one a project has
 * active or pending or a running process uses. An older engine's download then
 * fits. Returns what it removed; throws the store-full error when nothing can go.
 */
export async function makeStoreRoom(root = engineRoot(), { maxVersions = 5, lockWaitMs = 30_000, unlessReady = null } = {}) {
  const lockFile = path.join(root, 'download.lock');
  await mkdir(path.join(root, 'versions'), { recursive: true });
  if ((await readdir(path.join(root, 'versions'))).filter(stableVersion).length < maxVersions) return { removed: [] };
  const lock = await lockStore(root, lockFile, 'repair', lockWaitMs);
  if (!lock.release) return { busy: true, owner: lock.owner };
  try {
    // Checked under the lock: a release now ready needs no slot.
    if (stableVersion(unlessReady)) {
      // Ready as a download reuses a copy: its record and its CLI.
      const ready = await readJson(path.join(engineDirectory(unlessReady, root), 'ready.json')).catch(() => null);
      // A CLI that cannot be checked may be there: nothing is removed for it.
      const cliPresent = await stat(engineCli(unlessReady, root))
        .then(() => true, (error) => !['ENOENT', 'ENOTDIR'].includes(error?.code));
      if (ready?.version === unlessReady && ready?.schemaVersion === 1 && cliPresent) return { removed: [] };
    }
    const removed = await collectionPlan(root, maxVersions);
    await removeDisplaced(root, removed);
    if (removed.length) await recordStoreEvent(root, { type: 'store-room-made', removed });
    return { removed };
  } finally { await lock.release(); }
}

export async function selectedEngine(paths, bundledCli, bundledVersion, root = engineRoot()) {
  const state = await readJson(engineStatePath(paths));
  if (!state?.activeVersion) return bundledCli;
  if (state.schemaVersion !== 1 || !stableVersion(state.activeVersion)) throw new Error('Invalid Sentinel runtime selection; inspect engine.json.');
  const cli = engineCli(state.activeVersion, root);
  const ready = await readJson(path.join(engineDirectory(state.activeVersion, root), 'ready.json'));
  if (ready?.version !== state.activeVersion || ready?.schemaVersion !== 1) {
    throw new Error('Selected Sentinel runtime is incomplete. Restore it before reviewing; no silent fallback is allowed.');
  }
  await realpath(cli);
  return cli;
}

/** PowerShell single-quote arguments, never interpolate command text from repository content. */
export async function runNpm(args, options, { run = runProcess, platform = process.platform } = {}) {
  if (platform !== 'win32') return run('npm', args, options);
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& npm ${args.map(quote).join(' ')}; exit $LASTEXITCODE`], options);
}

async function boundedDownload(url, maximum, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'rove-sentinel-updater' } });
  if (!response.ok) throw new Error(`Release download returned HTTP ${response.status}.`);
  // GitHub redirects release assets onto its dedicated HTTPS asset host.
  if (response.url) {
    const target = new URL(response.url);
    if (target.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
      throw new Error('Unexpected release download host.');
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty release download.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error('Release asset exceeds the download limit.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** True when a project's record names a checkout that is no longer there. */
async function checkoutGone(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot) return false;
  try { await stat(path.join(repoRoot, '.git')); return false; }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
}

/**
 * What each installed version is kept for. `required`: a live process runs it,
 * or a project has it active or pending. `rollback`: only some project's
 * previous version. A record whose checkout is gone keeps only its active
 * version: the clones of one remote share one selection, and the record names
 * whichever checkout wrote it last, so another clone may still run that version.
 */
export async function retainedVersions(root) {
  const required = new Set();
  const rollback = new Set();
  const keep = (set, version) => { if (stableVersion(version)) set.add(version); };
  for (const folder of ['consumers', 'processes']) {
    const dir = path.join(root, folder);
    const entries = await readdir(dir).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      const file = path.join(dir, entry);
      const record = await readJson(file);
      if (!record) continue;
      if (folder === 'processes') {
        if (!processAlive(record.pid)) { await rm(file, { force: true }); continue; }
        keep(required, record.version);
        continue;
      }
      keep(required, record.activeVersion);
      if (await checkoutGone(record.repoRoot)) continue;
      keep(required, record.version);
      keep(required, record.pendingVersion);
      keep(rollback, record.previousVersion);
    }
  }
  for (const version of required) rollback.delete(version);
  return { required, rollback };
}

/**
 * Which installed versions a new one would displace, oldest first: versions
 * nothing keeps, then copies kept only for a rollback. A new release outranks
 * a rollback copy; nothing required is ever removed. Throws when that frees no
 * slot. A command that read its selection just before its project moved off
 * a version, and has not yet registered, can find that copy gone: it fails to
 * start, and the next command selects the new version.
 */
async function collectionPlan(root, maxVersions, { strict = true, protect = null } = {}) {
  const versions = (await readdir(path.join(root, 'versions'))).filter(stableVersion).sort(compareVersions);
  const { required, rollback } = await retainedVersions(root);
  const remove = [];
  for (const collectable of [(old) => !required.has(old) && !rollback.has(old), (old) => !required.has(old)]) {
    for (const old of versions) {
      if (versions.length - remove.length < maxVersions) break;
      if (old !== protect && collectable(old) && !remove.includes(old)) remove.push(old);
    }
  }
  const kept = versions.filter((old) => !remove.includes(old));
  if (strict && kept.length >= maxVersions) {
    throw new Error(`Runtime storage is full: every installed version (${kept.join(', ')}) is active or pending for a project, or used by a running process. Update or uninstall inactive projects, or end processes that run an old version, before retrying.`);
  }
  return remove;
}

/** Best effort once the new runtime is in place: a later install finishes what fails. */
async function removeDisplaced(root, versions) {
  for (const old of versions) await rm(engineDirectory(old, root), { recursive: true, force: true }).catch(() => {});
}

// An owner writes its PID within milliseconds of creating the lock; a lock
// still without one after this long belongs to a start that died in between.
const UNWRITTEN_LOCK_MS = 10 * 60_000;
// Two start times of one process, read by two system calls, agree within this.
const START_TOLERANCE_MS = 2_000;

let ownStart;
const ownStartedAt = () => (ownStart ??= processStartedAt(process.pid).catch(() => null));

/**
 * Who holds the store's lock, and whether that owner is provably gone: its PID
 * is not alive, or is alive with another start time than the one it recorded
 * (a reused PID). A lock written before 1.20.1 records no start time, so only a
 * dead PID proves it gone; one with no readable owner is gone once it is
 * UNWRITTEN_LOCK_MS old. `raw` is the content the verdict was made on.
 */
export async function inspectStoreLock(root, { isAlive = processAlive, startedAt = processStartedAt, now = Date.now() } = {}) {
  const lockFile = path.join(root, 'download.lock');
  let raw;
  let modified;
  try {
    modified = (await stat(lockFile)).mtimeMs;
    raw = await readFile(lockFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'free' };
    throw error;
  }
  let owner = null;
  try { owner = JSON.parse(raw); } catch { owner = null; }
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) {
    return now - modified > UNWRITTEN_LOCK_MS
      ? { state: 'stale', raw, owner, why: `it records no owner and is ${Math.round((now - modified) / 60_000)} minutes old` }
      : { state: 'live', raw, owner, why: 'its owner is still writing it' };
  }
  if (!isAlive(owner.pid)) return { state: 'stale', raw, owner, why: `its owner PID ${owner.pid} is not running` };
  if (Number.isFinite(owner.startedAt)) {
    const observed = await startedAt(owner.pid).catch(() => null);
    if (observed !== null && Math.abs(observed - owner.startedAt) > START_TOLERANCE_MS) {
      return { state: 'stale', raw, owner, why: `PID ${owner.pid} now belongs to a process started at ${new Date(observed).toISOString()}, not its owner` };
    }
  }
  return { state: 'live', raw, owner, why: `PID ${owner.pid} still runs` };
}

/** A bounded log of what Sentinel itself removed from the shared store, with its evidence. */
export async function recordStoreEvent(root, event) {
  const file = path.join(root, 'store-events.jsonl');
  try {
    if ((await stat(file)).size > 256 * 1024) await rename(file, `${file}.1`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

/**
 * Removes a lock whose owner is provably gone, and the staging directory only
 * that owner can have created. Removers take `download.takeover` exclusively,
 * then remove the lock only while it still holds the content the verdict was
 * made on: a lock another start created in its place is never removed. A
 * takeover marker left by a dead remover is cleared the same way.
 */
export async function removeStaleStoreLock(root, verdict, { reason = 'automatic', isAlive = processAlive } = {}) {
  const lockFile = path.join(root, 'download.lock');
  const marker = path.join(root, 'download.takeover');
  let handle;
  try { handle = await open(marker, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A takeover lasts milliseconds: a marker whose holder is gone, or that
    // never got its PID within a minute, is removed while it holds what was read.
    let raw = null;
    let modified = Date.now();
    try { modified = (await stat(marker)).mtimeMs; raw = await readFile(marker, 'utf8'); } catch { return false; }
    let holder = null;
    try { holder = JSON.parse(raw); } catch { holder = null; }
    // A takeover lasts milliseconds: a minute-old marker is abandoned even if its PID was reused.
    const abandoned = Date.now() - modified > 60_000 || (Number.isInteger(holder?.pid) && !isAlive(holder.pid));
    if (abandoned && await readFile(marker, 'utf8').catch(() => null) === raw) {
      await rm(marker, { force: true });
      await recordStoreEvent(root, { type: 'takeover-marker-removed', reason, holderPid: holder?.pid ?? null });
    }
    return false;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    const current = await readFile(lockFile, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== verdict.raw) return false;
    await rm(path.join(root, 'staging'), { recursive: true, force: true });
    await rm(lockFile, { force: true });
    await recordStoreEvent(root, { type: 'stale-download-lock-removed', reason, owner: verdict.owner, why: verdict.why });
    return true;
  } finally {
    await handle.close().catch(() => {});
    await rm(marker, { force: true }).catch(() => {});
  }
}

/**
 * The store's lock, which every collection and reservation holds. Waits up to
 * `waitMs` while its owner may be alive; removes it, and retries, when that
 * owner is provably gone.
 */
async function lockStore(root, lockFile, version, waitMs) {
  const deadline = Date.now() + waitMs;
  // Liveness is read every time; a PID's start time once, as its probe is a process launch.
  // Read again every 30 seconds, so a PID reused while this waits is seen.
  const starts = new Map();
  const startedAt = (pid) => {
    const cached = starts.get(pid);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = processStartedAt(pid).catch(() => null);
    starts.set(pid, { at: Date.now(), value });
    return value;
  };
  let last = null;
  while (true) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: await ownStartedAt(), version })); }
      catch (error) { await handle.close(); await rm(lockFile, { force: true }); throw error; }
      const release = async () => { try { await handle.close(); } finally { await rm(lockFile, { force: true }); } };
      return { release };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const verdict = await inspectStoreLock(root, { startedAt }).catch(() => null);
    if (verdict) last = verdict;
    if (Date.now() >= deadline) return { busy: true, owner: last?.owner ?? null };
    if (verdict?.state === 'free') continue;
    if (verdict?.state === 'stale' && await removeStaleStoreLock(root, verdict)) continue;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Shared per OS user; all repository watchers reuse the same verified immutable files.
 * `reserve` writes the caller's reservation (pendingVersion) while the store's
 * lock is held, before even a ready copy is checked: a collection after that
 * reads the reservation, and one before it already removed what it would, so
 * the check sees it gone and downloads the version again. `unreserve` takes it
 * back, under the same lock, when no copy existed and none could be installed.
 * Unlike 1.20.0, a ready copy is not reused while a dead owner's lock remains.
 */
export async function ensureEngine(version, { root = engineRoot(), fetchImpl = globalThis.fetch,
  npm = runNpm, env = process.env, timeoutMs = 60_000, maxVersions = 5, lockWaitMs = 600_000, reserve = async () => {}, unreserve = async () => {} } = {}) {
  const directory = engineDirectory(version, root);
  const lockFile = path.join(root, 'download.lock');
  // False only when the copy is known to be absent or incomplete; an error
  // that leaves it unknown is thrown.
  const isReady = async () => {
    const ready = await readJson(path.join(directory, 'ready.json'));
    if (ready?.version !== version || ready?.schemaVersion !== 1) return false;
    try { await stat(engineCli(version, root)); return true; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
  };
  await mkdir(root, { recursive: true });
  const lock = await lockStore(root, lockFile, version, lockWaitMs);
  // Nothing is reserved or reused without the lock.
  if (!lock.release) {
    const owner = lock.owner;
    throw new Error(`Another Sentinel process (PID ${owner?.pid ?? 'unknown'}${Number.isFinite(owner?.startedAt) ? `, started ${new Date(owner.startedAt).toISOString()}` : ''}) holds ${lockFile} while it installs engine ${owner?.version ?? 'unknown'}, and this command waited ${Math.round(lockWaitMs / 60_000)} minutes. Run: npx --no-install rove-sentinel repair`);
  }
  const stage = path.join(root, 'staging');
  let createdStage = false;
  let installing = false;
  try {
    await reserve();
    await mkdir(path.join(root, 'versions'), { recursive: true });
    if (await isReady()) {
      // Finish, at best effort, a collection an interrupted install left undone.
      try {
        if ((await readdir(path.join(root, 'versions'))).filter(stableVersion).length > maxVersions) {
          await removeDisplaced(root, await collectionPlan(root, maxVersions + 1, { strict: false, protect: version }));
        }
      } catch { /* The ready runtime is returned either way. */ }
      return directory;
    }
    // Only now is it known that no copy exists for the reservation to protect.
    installing = true;
    // Refuse before downloading when no slot can be freed; remove nothing yet,
    // so a failed download leaves every rollback copy in place.
    await collectionPlan(root, maxVersions);
    // A crashed staging directory is deliberately not overwritten.
    await mkdir(stage);
    createdStage = true;
    const urls = releaseUrls(version);
    const checksumFile = await boundedDownload(urls.checksumsUrl, 64 * 1024, { fetchImpl, timeoutMs });
    const name = `rove-sentinel-${version}.tgz`;
    const checksum = checksumFile.toString('utf8').split(/\r?\n/).map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
      .filter((match) => match?.[2] === name);
    if (checksum.length !== 1) throw new Error('Release checksum asset does not identify exactly one expected archive.');
    const archive = await boundedDownload(urls.archiveUrl, 32 * 1024 * 1024, { fetchImpl, timeoutMs });
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== checksum[0][1].toLowerCase()) throw new Error('Release archive checksum mismatch.');
    const archivePath = path.join(stage, name);
    await writeFile(archivePath, archive);
    await writeFile(path.join(stage, 'package.json'), '{"name":"sentinel-managed-runtime","private":true}\n');
    const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/(TOKEN|SECRET|KEY|PASSWORD|NODE_OPTIONS|NODE_PATH)|^npm_config_/i.test(key)));
    // An engine installs the same on every machine: two paths that hold nothing
    // stand in for the user's and the global npm configuration, whose settings
    // npm can refuse. npm refuses one path for both.
    // Local checksum-verified archive: npm never follows an unchecked release URL.
    await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--userconfig', path.join(stage, '.no-user-npmrc'), '--globalconfig', path.join(stage, '.no-global-npmrc'),
      '--registry', 'https://registry.npmjs.org/', '--cache', path.join(stage, '.npm-cache'), archivePath],
    { cwd: stage, env: cleanEnv, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024 });
    const pkg = JSON.parse(await readFile(path.join(stage, 'node_modules/rove-sentinel/package.json'), 'utf8'));
    if (pkg.name !== 'rove-sentinel' || pkg.version !== version || pkg.sentinelEngineProtocol !== 1) {
      throw new Error('Downloaded package identity or engine protocol is unsupported.');
    }
    await stat(path.join(stage, 'node_modules/rove-sentinel/scripts/review-gate/cli.mjs'));
    await rm(path.join(stage, '.npm-cache'), { recursive: true, force: true });
    await rm(archivePath);
    await atomicWriteJson(path.join(stage, 'ready.json'), { schemaVersion: 1, version, sha256: digest, ...urls });
    // Plan from fresh records once the new runtime is complete, and remove
    // only after it is in place: a failure before then removes nothing.
    const displaced = await collectionPlan(root, maxVersions);
    await rename(stage, directory);
    await removeDisplaced(root, displaced);
    return directory;
  } catch (error) {
    // No copy existed and none was installed: take the reservation back while
    // the lock is held. A failure before that was known leaves it in place.
    if (installing) await unreserve().catch(() => {});
    throw error;
  } finally {
    // Only this lock owner created staging. A failed install leaves no selectable runtime.
    try { if (createdStage) await rm(stage, { recursive: true, force: true }); }
    finally { await lock.release(); }
  }
}
