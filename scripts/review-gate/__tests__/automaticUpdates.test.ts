import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LONG_PAUSE_MS, automaticUpdate, maybeStartUpdateWorker, reviewNotices, updateInformation, watcherHolds } from '../automatic-updates.mjs';
import { engineCli, engineDirectory, engineStatePath, ensureEngine, inspectStoreLock, publishEngineState, removeStaleStoreLock, selectedEngine } from '../engine-store.mjs';
import { acquireReviewLease, acquireUpdateLease, updateMarker } from '../maintenance.mjs';
import { atomicWriteJson, ensureState, readJson } from '../storage.mjs';
import { policyForEngineUpgrade } from '../install.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { CHARTER_VERSION, GATE_VERSION } from '../constants.mjs';
import { notifyUpdate, updateMessage } from '../update-notifications.mjs';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'sentinel-auto-test-')); dirs.push(dir); return dir; }
async function fixture() {
  const root = await temp();
  const paths = await ensureState(path.join(root, 'repository-state'));
  const context = { repoRoot: path.join(root, 'project'), repository: 'https://github.com/example/project', paths };
  const policy = reviewPolicySnapshot({ charter: 'Frozen custom charter', lessons: 'Frozen lessons', config: { charter: 'rules.md' } });
  await atomicWriteJson(paths.policy, policy);
  await atomicWriteJson(path.join(paths.root, 'update-settings.json'), { enabled: true });
  const health = { watcherHealthy: true, heartbeat: { repoRoot: context.repoRoot, pid: 123, activity: 'paused' },
    queue: { depth: 0 }, persistedStateErrors: {}, paused: null };
  const run = vi.fn(async (_command, args) => ({ stdout: args.includes('--version') ? '1.11.0'
    : args.includes('status') ? JSON.stringify({ ...health, heartbeat: { ...health.heartbeat, gateVersion: args[0] === 'old-cli' ? '1.10.0' : '1.11.0' } }) : '{}' }));
  const deps = { contextFor: async () => context, check: vi.fn(async () => ({ status: 'available', latestVersion: '1.11.0' })),
    ensure: vi.fn(async (_version, options) => { await options?.reserve?.(); }), status: vi.fn(async () => health), stop: vi.fn(async () => true), run,
    notify: vi.fn(async () => {}), root: path.join(root, 'engines'), version: '1.10.0', cliPath: 'old-cli', platform: 'win32', env: {}, pauseTimeoutMs: 0 };
  return { root, context, health, deps };
}

describe('automatic engine activation', () => {
  it('activates a separate engine, preserves pins and uses only the frozen installed policy', async () => {
    const f = await fixture();
    expect(await automaticUpdate({}, f.deps)).toEqual({ status: 'updated', version: '1.11.0' });
    expect(f.deps.run.mock.calls.some(([, args]) => args.includes('--preserve-policy'))).toBe(true);
    expect(f.deps.run.mock.calls.every(([command]) => command === process.execPath)).toBe(true);
    expect(await readJson(engineStatePath(f.context.paths))).toMatchObject({ activeVersion: '1.11.0', pendingVersion: null, phase: 'active' });
    expect(await readJson(f.context.paths.paused)).toBeNull();
    expect(await readJson(updateMarker(f.context.paths))).toBeNull();
  });
  it.each(['pause', 'queue', 'owner', 'unhealthy', 'corrupt'])('downloads but defers when %s prevents a safe activation', async (kind) => {
    const f = await fixture();
    if (kind === 'pause') f.health.paused = { reason: 'manual pause' } as any;
    if (kind === 'queue') f.health.queue.depth = 1;
    if (kind === 'owner') f.health.heartbeat.repoRoot = 'another-checkout';
    if (kind === 'unhealthy') f.health.watcherHealthy = false;
    if (kind === 'corrupt') f.health.persistedStateErrors = { heartbeat: 'bad json' };
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'waiting' });
    expect(f.deps.ensure).toHaveBeenCalledOnce();
    expect(f.deps.stop).not.toHaveBeenCalled();
  });
  it('reserves only under the store\'s lock, and names a failed attempt without reserving it', async () => {
    const f = await fixture();
    const record = async () => (await readJson(path.join(f.deps.root, 'consumers', `${path.basename(f.context.paths.root)}.json`))) ?? {};
    // The store was busy: no reservation is written outside its lock.
    f.deps.ensure.mockImplementation(async () => { throw new Error('Another or interrupted runtime download owns the lock.'); });
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'download-failed' });
    expect((await record()).pendingVersion ?? null).toBeNull();
    expect(await readJson(engineStatePath(f.context.paths))).toMatchObject({ phase: 'download-failed', attemptedVersion: '1.11.0' });
    // A reservation the store took back after a failed install stays taken back.
    f.deps.ensure.mockImplementation(async (_version, options) => {
      await options.reserve(); await options.unreserve(); throw new Error('Release download returned HTTP 503.');
    });
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'download-failed' });
    expect((await record()).pendingVersion ?? null).toBeNull();
    f.deps.ensure.mockImplementation(async (_version, options) => { await options.reserve(); });
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'updated' });
    expect(await readJson(engineStatePath(f.context.paths))).toMatchObject({ attemptedVersion: null, pendingVersion: null });
  });
  it('updates a live watcher whose GitHub polls fail: the new engine may be the fix', async () => {
    const f = await fixture();
    Object.assign(f.health, { watcherHealthy: false, watcherRunning: true });
    expect(await automaticUpdate({}, f.deps)).toEqual({ status: 'updated', version: '1.11.0' });
  });
  it('lets a foreground review finish and refuses new reviews during activation', async () => {
    const f = await fixture();
    const release = await acquireReviewLease(f.context.paths);
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'waiting' });
    expect(f.deps.stop).not.toHaveBeenCalled();
    await release();
    const update = await acquireUpdateLease(f.context.paths, {});
    await expect(acquireReviewLease(f.context.paths)).rejects.toThrow('being updated');
    await update();
  });
  it('does not stop a busy watcher that has not acknowledged the pause', async () => {
    const f = await fixture(); f.health.heartbeat.activity = 'review';
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'waiting' });
    expect(f.deps.stop).not.toHaveBeenCalled();
    expect(await readJson(f.context.paths.paused)).toBeNull();
  });
  it.each(['valid', 'truncated', 'invalid-shape'])('reclaims a crashed %s lease when its PID belongs to a newer process', async (kind) => {
    const f = await fixture();
    const directory = path.join(f.context.paths.root, 'active-reviews');
    await mkdir(directory);
    const file = path.join(directory, '123-00000000-0000-4000-8000-000000000000.json');
    await writeFile(file, kind === 'valid' ? JSON.stringify({ pid: 123, startedAt: 10 }) : kind === 'truncated' ? '{' : '{}');
    const release = await acquireUpdateLease(f.context.paths, {}, {
      isAlive: () => true, startedAt: async () => Date.now() + 5000,
    });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await release();
  });
  it('preserves a verified live owner and refuses to guess when creation time is unavailable', async () => {
    const f = await fixture();
    const directory = path.join(f.context.paths.root, 'active-reviews'); await mkdir(directory);
    await writeFile(path.join(directory, '123-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: 123, startedAt: 10 }));
    for (const stamp of [10, null]) await expect(acquireUpdateLease(f.context.paths, {}, {
      isAlive: () => true, startedAt: async () => stamp,
    })).rejects.toThrow('review is active');
  });
  it('restores the prior runtime after a failed new install', async () => {
    const f = await fixture(); const original = f.deps.run.getMockImplementation();
    f.deps.run.mockImplementation(async (command, args) => {
      if (args[0] !== 'old-cli' && args.includes('install')) throw new Error('new install failed');
      return original(command, args);
    });
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'failed' });
    expect(f.deps.run.mock.calls.some(([, args]) => args[0] === 'old-cli' && args.includes('install'))).toBe(true);
    expect(await readJson(f.context.paths.paused)).toBeNull();
    expect(await readJson(updateMarker(f.context.paths))).toBeNull();
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'failed' });
    expect(f.deps.ensure).toHaveBeenCalledOnce();
  });
  it('retains the fence and recovery record if rollback cannot recover', async () => {
    const f = await fixture();
    f.deps.run.mockRejectedValue(new Error('scheduler unavailable'));
    expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: 'recovery-required' });
    expect(await readJson(updateMarker(f.context.paths))).not.toBeNull();
    expect(await readJson(path.join(f.context.paths.root, 'update-recovery.json'))).toMatchObject({ previousCli: 'old-cli' });
  });
  it('never downloads on opt-out, unsupported hosts or a non-newer release', async () => {
    for (const mode of ['disabled', 'unsupported', 'current', 'ahead', 'unavailable']) {
      const f = await fixture();
      if (mode === 'disabled') f.deps.env = { ROVE_SENTINEL_AUTO_UPDATE: '0' };
      else if (mode === 'unsupported') f.deps.platform = 'linux';
      else f.deps.check.mockResolvedValue({ status: mode, latestVersion: '1.9.0' });
      expect(await automaticUpdate({}, f.deps)).toMatchObject({ status: mode });
      expect(f.deps.ensure).not.toHaveBeenCalled();
    }
  });
  it('isolates two projects while using one shared runtime store', async () => {
    const a = await fixture(); const b = await fixture(); b.deps.root = a.deps.root;
    b.context.paths = await ensureState(path.join(b.root, 'other-repository-state'));
    await atomicWriteJson(path.join(b.context.paths.root, 'update-settings.json'), { enabled: true });
    await atomicWriteJson(b.context.paths.policy, await readJson(a.context.paths.policy));
    b.health.paused = { reason: 'other project pause' } as any;
    expect(await automaticUpdate({}, a.deps)).toMatchObject({ status: 'updated' });
    expect(await automaticUpdate({}, b.deps)).toMatchObject({ status: 'waiting' });
    expect(await readJson(engineStatePath(a.context.paths))).toMatchObject({ activeVersion: '1.11.0' });
    expect(await readJson(engineStatePath(b.context.paths))).not.toHaveProperty('activeVersion');
    expect(b.deps.stop).not.toHaveBeenCalled();
  });
  it('schedules only enrolled Windows watchers and rate-limits background workers', async () => {
    const f = await fixture(); const child = { on: vi.fn(), unref: vi.fn() }; const start = vi.fn(() => child);
    const options = { start, env: {}, platform: 'win32', now: Date.now(), root: f.deps.root };
    await atomicWriteJson(path.join(f.context.paths.root, 'update-settings.json'), { enabled: false });
    expect(await maybeStartUpdateWorker(f.context, options)).toBe(false);
    await atomicWriteJson(path.join(f.context.paths.root, 'update-settings.json'), { enabled: true });
    expect(await maybeStartUpdateWorker(f.context, options)).toBe(true);
    expect(await maybeStartUpdateWorker(f.context, options)).toBe(false);
    expect(start.mock.calls[0][2]).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' });
  });
  it('preserves custom project policy and refuses corruption during an engine upgrade', async () => {
    const f = await fixture();
    expect(await policyForEngineUpgrade(f.context.paths)).toMatchObject({ charter: 'Frozen custom charter', lessons: 'Frozen lessons' });
    const policy = await readJson(f.context.paths.policy); policy.charter = 'unapproved edit';
    await atomicWriteJson(f.context.paths.policy, policy);
    await expect(policyForEngineUpgrade(f.context.paths)).rejects.toThrow('corrupt');
  });
});

describe('shared immutable runtime distribution', () => {
  async function distribution(version = '1.11.0') {
    const root = await temp(); const archive = Buffer.from('synthetic archive');
    const digest = createHash('sha256').update(archive).digest('hex');
    const fetchImpl = vi.fn(async (url) => new Response(url.endsWith('SHA256SUMS') ? `${digest}  rove-sentinel-${version}.tgz\n` : archive));
    const npm = vi.fn(async (_args, { cwd }) => {
      const packageRoot = path.join(cwd, 'node_modules/rove-sentinel');
      await mkdir(path.join(packageRoot, 'scripts/review-gate'), { recursive: true });
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'rove-sentinel', version, sentinelEngineProtocol: 1 }));
      await writeFile(path.join(packageRoot, 'scripts/review-gate/cli.mjs'), '');
    });
    return { root, fetchImpl, npm };
  }
  it('tells the truth about proxies: npm reads HTTPS_PROXY, Node\'s fetch needs more', async () => {
    const guide = await readFile('docs/troubleshooting.md', 'utf8');
    const row = guide.split('\n').find((line) => line.startsWith('| `update` fails'));
    expect(row).toContain('HTTPS_PROXY');
    expect(row).toContain('NODE_USE_ENV_PROXY=1');
    expect(row).toContain('Node 22.21');
  });

  it('installs an engine without the user\'s npm configuration', async () => {
    const d = await distribution();
    await ensureEngine('1.11.0', { ...d, env: {
      PATH: 'kept', HTTPS_PROXY: 'kept', npm_config_allow_scripts: 'true', NPM_CONFIG_REGISTRY: 'https://registry.example.com/', npm_config_userconfig: 'mine',
    } });
    const [args, options] = d.npm.mock.calls[0];
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toEqual(expect.arrayContaining(['--ignore-scripts']));
    expect(value('--registry')).toBe('https://registry.npmjs.org/');
    // npm refuses to load one path as both configurations.
    expect(value('--userconfig')).not.toBe(value('--globalconfig'));
    for (const file of [value('--userconfig'), value('--globalconfig')]) expect(file.startsWith(options.cwd)).toBe(true);
    expect(Object.keys(options.env).sort()).toEqual(['HTTPS_PROXY', 'PATH']);
  });

  it('checks SHA-256 before npm, disables scripts, and reuses a verified engine across projects', async () => {
    const d = await distribution();
    const target = await ensureEngine('1.11.0', d);
    expect(target).toBe(engineDirectory('1.11.0', d.root));
    expect(d.npm.mock.calls[0][0]).toContain('--ignore-scripts');
    expect(await ensureEngine('1.11.0', d)).toBe(target);
    expect(d.npm).toHaveBeenCalledOnce();
    const paths = await ensureState(path.join(d.root, 'consumer'));
    await publishEngineState(paths, { activeVersion: '1.11.0', repoRoot: 'project' }, d.root);
    expect(await selectedEngine(paths, 'bundled', '1.10.0', d.root)).toBe(engineCli('1.11.0', d.root));
  });
  it('rejects corrupt downloads before executing a package manager', async () => {
    const d = await distribution(); d.fetchImpl.mockResolvedValue(new Response(`${'0'.repeat(64)}  rove-sentinel-1.11.0.tgz\n`));
    expect(await ensureEngine('1.11.0', d).catch((e) => e.message)).toContain('checksum mismatch');
    expect(d.npm).not.toHaveBeenCalled();
  });
  it('refuses unknown engine protocols and never selects partial installs', async () => {
    const d = await distribution(); const original = d.npm.getMockImplementation();
    d.npm.mockImplementation(async (...args) => {
      await original(...args);
      await writeFile(path.join(args[1].cwd, 'node_modules/rove-sentinel/package.json'), JSON.stringify({ name: 'rove-sentinel', version: '1.11.0' }));
    });
    await expect(ensureEngine('1.11.0', d)).rejects.toThrow('protocol');
    const paths = await ensureState(path.join(d.root, 'consumer'));
    await publishEngineState(paths, { activeVersion: '1.11.0' }, d.root);
    await expect(selectedEngine(paths, 'bundled', '1.10.0', d.root)).rejects.toThrow('incomplete');
  });
  it('preserves versions referenced by idle projects and running processes at the storage cap', async () => {
    const d = await distribution();
    await mkdir(engineDirectory('1.10.0', d.root), { recursive: true });
    const paths = await ensureState(path.join(d.root, 'consumer'));
    await publishEngineState(paths, { activeVersion: '1.10.0' }, d.root);
    await expect(ensureEngine('1.11.0', { ...d, maxVersions: 1 })).rejects.toThrow('storage is full');
    expect(d.fetchImpl).not.toHaveBeenCalled();
    await publishEngineState(paths, {}, d.root);
    await atomicWriteJson(path.join(d.root, 'processes/live.json'), { pid: process.pid, version: '1.10.0' });
    await expect(ensureEngine('1.11.0', { ...d, maxVersions: 1 })).rejects.toThrow('storage is full');
  });
  // Installed versions, and a project whose checkout is (or is not) still there.
  async function installed(root: string, versions: string[]) {
    for (const version of versions) await mkdir(engineDirectory(version, root), { recursive: true });
  }
  async function project(root: string, name: string, state: object, { gone = false } = {}) {
    const repoRoot = path.join(root, 'checkouts', name);
    if (!gone) await mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await publishEngineState(await ensureState(path.join(root, 'state', name)), { repoRoot, ...state }, root);
  }
  const present = async (root: string) => (await readdir(path.join(root, 'versions'))).sort();

  it('collects rollback-only copies, oldest first, rather than refusing a new release', async () => {
    const d = await distribution('1.12.0');
    await installed(d.root, ['1.9.0', '1.10.0', '1.11.0']);
    await project(d.root, 'a', { activeVersion: '1.11.0', previousVersion: '1.10.0' });
    await project(d.root, 'b', { activeVersion: '1.11.0', previousVersion: '1.9.0' });
    expect(await ensureEngine('1.12.0', { ...d, maxVersions: 3 })).toBe(engineDirectory('1.12.0', d.root));
    // 1.9.0 is older than 1.10.0, though it sorts after it as text.
    expect(await present(d.root)).toEqual(['1.10.0', '1.11.0', '1.12.0']);
  });
  it('never collects an active, pending or running version, even when only those are left', async () => {
    const d = await distribution('1.12.0');
    await installed(d.root, ['1.9.0', '1.10.0', '1.11.0']);
    await project(d.root, 'a', { activeVersion: '1.11.0', previousVersion: '1.9.0', pendingVersion: '1.10.0' });
    await project(d.root, 'b', { activeVersion: '1.9.0' });
    await atomicWriteJson(path.join(d.root, 'processes/live.json'), { pid: process.pid, version: '1.10.0' });
    const error = await ensureEngine('1.12.0', { ...d, maxVersions: 3 }).catch((caught) => caught.message);
    expect(error).toContain('storage is full');
    expect(error).toContain('1.9.0, 1.10.0, 1.11.0');
    expect(await present(d.root)).toEqual(['1.10.0', '1.11.0', '1.9.0']);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });
  it('lets a project whose checkout is gone keep only its active version', async () => {
    const d = await distribution('1.12.0');
    await installed(d.root, ['1.9.0', '1.10.0', '1.11.0']);
    await project(d.root, 'live', { activeVersion: '1.11.0' });
    await project(d.root, 'removed-worktree', { activeVersion: '1.9.0', pendingVersion: '1.10.0', previousVersion: '1.10.0' }, { gone: true });
    await ensureEngine('1.12.0', { ...d, maxVersions: 3 });
    // Another clone of the same remote may still select 1.9.0; nobody waits for 1.10.0.
    expect(await present(d.root)).toEqual(['1.11.0', '1.12.0', '1.9.0']);
  });
  it('keeps every rollback copy when the new release fails to download', async () => {
    const d = await distribution('1.12.0');
    await installed(d.root, ['1.9.0', '1.10.0', '1.11.0']);
    await project(d.root, 'a', { activeVersion: '1.11.0', previousVersion: '1.10.0' });
    await project(d.root, 'b', { activeVersion: '1.11.0', previousVersion: '1.9.0' });
    d.fetchImpl.mockResolvedValue(new Response(`${'0'.repeat(64)}  rove-sentinel-1.12.0.tgz\n`));
    await expect(ensureEngine('1.12.0', { ...d, maxVersions: 3 })).rejects.toThrow('checksum mismatch');
    expect(await present(d.root)).toEqual(['1.10.0', '1.11.0', '1.9.0']);
    // The reservation it made is taken back while it still holds the store.
    const lock = path.join(d.root, 'download.lock');
    const calls: string[] = [];
    const held = async (name: string) => { calls.push(`${name}:${await readFile(lock, 'utf8').then(() => 'locked', () => 'free')}`); };
    await expect(ensureEngine('1.12.0', { ...d, maxVersions: 3, reserve: () => held('reserve'), unreserve: () => held('unreserve') })).rejects.toThrow();
    expect(calls).toEqual(['reserve:locked', 'unreserve:locked']);
    // Nor when the verified runtime cannot be put in place.
    d.fetchImpl.mockImplementation(async (url) => new Response(url.endsWith('SHA256SUMS')
      ? `${createHash('sha256').update('synthetic archive').digest('hex')}  rove-sentinel-1.12.0.tgz\n` : Buffer.from('synthetic archive')));
    await mkdir(engineDirectory('1.12.0', d.root), { recursive: true });
    await writeFile(path.join(engineDirectory('1.12.0', d.root), 'left-behind'), '');
    await expect(ensureEngine('1.12.0', { ...d, maxVersions: 4 })).rejects.toThrow();
    expect(await present(d.root)).toEqual(['1.10.0', '1.11.0', '1.12.0', '1.9.0']);
  });
  it('waits for a live owner\'s lock, and removes one whose owner is provably gone, with its staging and a record', async () => {
    const d = await distribution();
    await ensureEngine('1.11.0', d);
    const lock = path.join(d.root, 'download.lock');
    const reserve = vi.fn(async () => {});
    // A live owner: nothing is reserved or reused, and the refusal names the repair.
    await writeFile(lock, JSON.stringify({ pid: process.pid, version: '1.12.0' }));
    await expect(ensureEngine('1.11.0', { ...d, lockWaitMs: 300, reserve })).rejects.toThrow('Run: npx --no-install rove-sentinel repair');
    expect(reserve).not.toHaveBeenCalled();
    // A dead owner's lock, and the staging only it can have created, are removed.
    await writeFile(lock, JSON.stringify({ pid: 2 ** 31 - 2, version: '1.12.0' }));
    await mkdir(path.join(d.root, 'staging'));
    expect(await ensureEngine('1.11.0', { ...d, lockWaitMs: 60_000, reserve })).toBe(engineDirectory('1.11.0', d.root));
    await expect(readFile(path.join(d.root, 'staging'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A lock never given an owner is gone only once it is ten minutes old.
    await writeFile(lock, '');
    await expect(ensureEngine('1.11.0', { ...d, lockWaitMs: 300, reserve })).rejects.toThrow('holds');
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lock, old, old);
    expect(await ensureEngine('1.11.0', { ...d, lockWaitMs: 300, reserve })).toBe(engineDirectory('1.11.0', d.root));
    const events = (await readFile(path.join(d.root, 'store-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(['stale-download-lock-removed', 'stale-download-lock-removed']);
    expect(events[0].why).toContain('is not running');
    expect(d.npm).toHaveBeenCalledOnce();
  });
  it('tells a reused PID from the lock\'s owner by its start time, and an earlier engine\'s lock only by its PID', async () => {
    const root = await temp();
    const lockFile = path.join(root, 'download.lock');
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: 1_000, version: '1.12.0' }));
    expect(await inspectStoreLock(root, { startedAt: async () => 5_000_000 })).toMatchObject({ state: 'stale', why: expect.stringContaining('now belongs to a process') });
    expect(await inspectStoreLock(root, { startedAt: async () => 1_500 })).toMatchObject({ state: 'live' });
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, version: '1.12.0' }));
    expect(await inspectStoreLock(root, { startedAt: async () => 5_000_000 })).toMatchObject({ state: 'live' });
  });
  it('never removes a lock another start put in place after the verdict, and clears a dead remover\'s marker', async () => {
    const root = await temp();
    const lockFile = path.join(root, 'download.lock');
    await writeFile(lockFile, JSON.stringify({ pid: 2 ** 31 - 2, version: '1.12.0' }));
    const verdict = await inspectStoreLock(root);
    expect(verdict.state).toBe('stale');
    // Between the verdict and the removal, the dead lock went and a live start took the name.
    const live = JSON.stringify({ pid: process.pid, version: '1.13.0' });
    await writeFile(lockFile, live);
    expect(await removeStaleStoreLock(root, verdict)).toBe(false);
    expect(await readFile(lockFile, 'utf8')).toBe(live);
    // A remover that died holding the marker leaves it; the next removal clears it.
    await writeFile(path.join(root, 'download.takeover'), JSON.stringify({ pid: 2 ** 31 - 2 }));
    await writeFile(lockFile, JSON.stringify({ pid: 2 ** 31 - 2, version: '1.12.0' }));
    const second = await inspectStoreLock(root);
    expect(await removeStaleStoreLock(root, second)).toBe(false);
    expect(await removeStaleStoreLock(root, second)).toBe(true);
    await expect(readFile(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
    // A live remover's marker is respected.
    await writeFile(path.join(root, 'download.takeover'), JSON.stringify({ pid: process.pid }));
    await writeFile(lockFile, JSON.stringify({ pid: 2 ** 31 - 2, version: '1.12.0' }));
    expect(await removeStaleStoreLock(root, await inspectStoreLock(root))).toBe(false);
    expect(await readFile(lockFile, 'utf8')).toContain('1.12.0');
  });
  it('writes the reservation while it holds the store, and trims a store an interrupted install left over its cap', async () => {
    const d = await distribution();
    await ensureEngine('1.11.0', d);
    const lock = path.join(d.root, 'download.lock');
    const seen: boolean[] = [];
    const reserve = vi.fn(async () => { seen.push(await readFile(lock, 'utf8').then(() => true, () => false)); });
    await ensureEngine('1.11.0', { ...d, reserve });
    expect(seen).toEqual([true]);
    // Under the cap nothing is collected, so a record nobody can read does not matter.
    await mkdir(path.join(d.root, 'consumers'), { recursive: true });
    await writeFile(path.join(d.root, 'consumers/unreadable.json'), '{');
    expect(await ensureEngine('1.11.0', d)).toBe(engineDirectory('1.11.0', d.root));
    await rm(path.join(d.root, 'consumers/unreadable.json'));
    await installed(d.root, ['1.7.0', '1.8.0', '1.9.0', '1.10.0']);
    await project(d.root, 'a', { activeVersion: '1.11.0', previousVersion: '1.10.0' });
    await ensureEngine('1.11.0', { ...d, maxVersions: 3 });
    expect(await present(d.root)).toEqual(['1.10.0', '1.11.0', '1.9.0']);
  });
  it('preserves an interrupted staging directory rather than erasing it', async () => {
    const d = await distribution(); await mkdir(path.join(d.root, 'staging'));
    await writeFile(path.join(d.root, 'staging/evidence.txt'), 'retained');
    await expect(ensureEngine('1.11.0', d)).rejects.toThrow();
    expect(await readFile(path.join(d.root, 'staging/evidence.txt'), 'utf8')).toBe('retained');
  });
});

describe('visible update notifications', () => {
  it('distinguishes pending and active versions and deduplicates native notifications', async () => {
    const f = await fixture(); const run = vi.fn(async () => ({}));
    const state = { phase: 'waiting', pendingVersion: '1.11.0' };
    expect(updateMessage(state, 'example')).toContain('after current reviews finish');
    expect(updateMessage({ phase: 'active', activeVersion: '1.11.0' }, 'example')).toContain('updated to 1.11.0');
    await notifyUpdate(f.context, state, { run, platform: 'win32', env: {} });
    await notifyUpdate(f.context, state, { run, platform: 'win32', env: {} });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toContain('-EncodedCommand');
  });
});

describe('an update the watcher keeps waiting is said', () => {
  const HOUR = 60 * 60 * 1000;
  const SAFETY = 'Provider process-tree cleanup could not be verified; inspect remaining provider processes before resuming.';
  const DEAD_PID = 2 ** 31 - 2;
  async function waiting(phase = 'waiting', extra: object = {}) {
    const f = await fixture();
    await publishEngineState(f.context.paths, { repoRoot: f.context.repoRoot, phase, pendingVersion: '99.0.0', ...extra }, f.deps.root);
    return f;
  }
  // A watcher of this engine and the installed policy, alive and beating.
  async function liveWatcher(paths, heartbeat: object = {}) {
    const { policyDigest } = await readJson(paths.policy);
    await atomicWriteJson(paths.lock, { ownerToken: 'owner', pid: process.pid });
    await atomicWriteJson(paths.heartbeat, { ownerToken: 'owner', pid: process.pid, at: new Date().toISOString(),
      gateVersion: GATE_VERSION, charterVersion: CHARTER_VERSION, policyDigest, ...heartbeat });
  }
  const kinds = async (paths) => (await updateInformation(paths)).blockedBy.map((hold) => hold.kind);

  it('names a safety pause, its time and reason, and the command, and never lifts it', async () => {
    const f = await waiting(); await liveWatcher(f.context.paths);
    const pause = { pausedAt: '2026-11-03T08:00:00.000Z', reason: SAFETY };
    await atomicWriteJson(f.context.paths.paused, pause);
    expect((await updateInformation(f.context.paths)).blockedBy).toEqual([
      expect.objectContaining({ kind: 'paused', since: pause.pausedAt, reason: SAFETY }),
    ]);
    const lines = await reviewNotices(f.context.paths, 'example');
    expect(lines[0]).toContain('99.0.0 is downloaded for example but cannot activate');
    expect(lines[0]).toContain(`paused (since ${pause.pausedAt}): ${SAFETY.slice(0, -1)}`);
    expect(lines[0]).toMatch(/Run: npx --no-install rove-sentinel repair$/);
    expect(lines[0]).not.toContain('after current reviews finish');
    // An agent reading the log acts on one command, at the end of the line.
    expect(lines[0].match(/rove-sentinel repair/g)).toHaveLength(1);
    // Days old, so the pushes it refuses are said too.
    expect(lines[1]).toContain('Pushes without a passing review are refused');
    expect(await readJson(f.context.paths.paused)).toEqual(pause);
  });
  it('names a stopped watcher and the error it stopped with', async () => {
    const f = await waiting();
    const stopped = 'Review daemon lock belongs to dead PID 4242; refusing automatic removal because another starter may have replaced it.';
    await atomicWriteJson(f.context.paths.daemonError, { message: stopped, at: '2026-11-05T10:00:00.000Z' });
    expect((await updateInformation(f.context.paths)).blockedBy).toEqual([
      expect.objectContaining({ kind: 'stopped', since: '2026-11-05T10:00:00.000Z', reason: stopped }),
    ]);
    const [line] = await reviewNotices(f.context.paths, 'example');
    expect(line).toContain('the review watcher is not running (since 2026-11-05T10:00:00.000Z): Review daemon lock belongs to dead PID 4242');
    expect(line).toMatch(/Run: npx --no-install rove-sentinel repair$/);
  });
  it('names a live watcher of another engine or policy, which activation also waits out', async () => {
    const f = await waiting(); await liveWatcher(f.context.paths, { policyDigest: 'another' });
    expect(await kinds(f.context.paths)).toEqual(['outdated']);
    await liveWatcher(f.context.paths, { gateVersion: '1.0.0' });
    expect((await reviewNotices(f.context.paths, 'example'))[0]).toContain('runs another engine or policy');
  });
  it('says nothing more while a running watcher simply finishes its reviews, or runs the activation itself', async () => {
    const f = await waiting(); await liveWatcher(f.context.paths);
    expect(await kinds(f.context.paths)).toEqual([]);
    await atomicWriteJson(f.context.paths.paused, { pausedAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString(), reason: 'Automatic Sentinel update to 99.0.0' });
    await atomicWriteJson(updateMarker(f.context.paths), { version: '99.0.0', pid: process.pid, startedAt: new Date().toISOString() });
    expect(await kinds(f.context.paths)).toEqual([]);
    expect(await reviewNotices(f.context.paths, 'example')).toEqual([expect.stringContaining('It will activate after current reviews finish.')]);
  });
  it('names the pause and fence an interrupted activation left behind', async () => {
    const f = await waiting(); await liveWatcher(f.context.paths);
    await atomicWriteJson(f.context.paths.paused, { pausedAt: '2026-11-10T00:00:00.000Z', reason: 'Automatic Sentinel update to 99.0.0' });
    expect(await kinds(f.context.paths)).toEqual(['paused']);
    await atomicWriteJson(updateMarker(f.context.paths), { version: '99.0.0', pid: DEAD_PID, startedAt: '2026-11-10T00:00:00.000Z' });
    expect(await kinds(f.context.paths)).toEqual(['paused', 'interrupted']);
    const [line] = await reviewNotices(f.context.paths, 'example');
    expect(line).toContain('an earlier activation was interrupted');
    expect(line).toMatch(/Run: npx --no-install rove-sentinel repair$/);
    // A live process that started after the marker reused its PID: still interrupted.
    await atomicWriteJson(updateMarker(f.context.paths), { version: '99.0.0', pid: process.pid, startedAt: '2026-11-10T00:00:00.000Z' });
    const reused = await watcherHolds(f.context.paths, { startedAt: async () => Date.parse('2026-11-12T00:00:00.000Z') });
    expect(reused.map((hold) => hold.kind)).toEqual(['paused', 'interrupted']);
    const same = await watcherHolds(f.context.paths, { startedAt: async () => Date.parse('2026-11-09T00:00:00.000Z') });
    expect(same).toEqual([]);
    // Stopped mid-activation, the phase stays `activating`: the fence is said there too.
    const g = await waiting('activating');
    await atomicWriteJson(updateMarker(g.context.paths), { version: '99.0.0', pid: DEAD_PID });
    expect(await kinds(g.context.paths)).toEqual(['interrupted']);
  });
  it('reports every unreadable record without hiding a readable pause', async () => {
    const f = await waiting(); await liveWatcher(f.context.paths);
    await atomicWriteJson(f.context.paths.paused, { pausedAt: '2026-11-03T08:00:00.000Z', reason: SAFETY });
    await writeFile(f.context.paths.githubFailure, '{');
    await writeFile(f.context.paths.queueSubmitLock, '{');
    const holds = (await updateInformation(f.context.paths)).blockedBy;
    expect(holds.map((hold) => hold.kind)).toEqual(['unreadable', 'paused']);
    expect(holds[0].reason).toMatch(/githubFailure: .*; queueSubmitLock: /);
  });
  it('names a queue submission lock its dead owner left, which activation also waits out', async () => {
    const f = await waiting(); await liveWatcher(f.context.paths);
    await atomicWriteJson(f.context.paths.queueSubmitLock, { pid: DEAD_PID });
    expect(await kinds(f.context.paths)).toEqual(['queue-lock']);
    const [line] = await reviewNotices(f.context.paths, 'example');
    expect(line).toMatch(/Run: npx --no-install rove-sentinel repair$/);
    await atomicWriteJson(f.context.paths.queueSubmitLock, { pid: process.pid });
    expect(await kinds(f.context.paths)).toEqual([]);
  });
  it('still reports when the update settings or an activation fence cannot be read', async () => {
    const f = await waiting(); await liveWatcher(f.context.paths);
    await writeFile(path.join(f.context.paths.root, 'update-settings.json'), '{');
    const information = await updateInformation(f.context.paths);
    expect(information.automatic).toBeNull();
    expect(information.blockedBy).toEqual([expect.objectContaining({ kind: 'unreadable', reason: expect.stringContaining('update-settings') })]);
    const g = await waiting('activating');
    await writeFile(updateMarker(g.context.paths), '{');
    expect(await kinds(g.context.paths)).toEqual(['unreadable']);
    // After a failed download too: the line says why nothing retries.
    const h = await waiting('download-failed', { lastError: 'Release download returned HTTP 503.' });
    await writeFile(path.join(h.context.paths.root, 'update-settings.json'), '{');
    const lines = await reviewNotices(h.context.paths, 'example');
    expect(lines[0]).not.toContain('retries');
    expect(lines[1]).toContain('cannot read the update settings for example');
  });
  it('keeps the last attempt in the line when a hold is named', async () => {
    const f = await waiting('waiting', { lastError: 'Another or interrupted update exists.' });
    expect((await reviewNotices(f.context.paths, 'example'))[0]).toMatch(/not running.*Last attempt: Another or interrupted update exists\./);
  });
  it('says when updates are disabled rather than promising an activation, and shows the last attempt', async () => {
    const f = await waiting('waiting', { lastError: 'A foreground or watcher review is active. Let it finish before updating.' });
    await liveWatcher(f.context.paths);
    expect(await reviewNotices(f.context.paths, 'example')).toEqual([expect.stringContaining('Last attempt: A foreground or watcher review is active.')]);
    await atomicWriteJson(path.join(f.context.paths.root, 'update-settings.json'), { enabled: false });
    const [line] = await reviewNotices(f.context.paths, 'example');
    expect(line).toContain('automatic updates are disabled here');
    expect(line).toContain('updates --enable');
  });
  it('reports a pause older than a day with no update waiting, and not a fresh one', async () => {
    const f = await waiting('active', { activeVersion: '99.0.0', pendingVersion: null }); await liveWatcher(f.context.paths);
    const now = Date.parse('2026-11-18T12:00:00.000Z');
    await atomicWriteJson(f.context.paths.paused, { pausedAt: new Date(now - LONG_PAUSE_MS - HOUR).toISOString(), reason: SAFETY });
    const lines = await reviewNotices(f.context.paths, 'example', { now });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('The review watcher for example has been paused since 2026-11-17T11:00:00.000Z');
    expect(lines[1]).toMatch(/Run: npx --no-install rove-sentinel repair$/);
    expect(await reviewNotices(f.context.paths, 'example', { now: now - 2 * HOUR })).toHaveLength(1);
  });
  it('reports a download that failed, with its reason, while it is still newer than the running engine', async () => {
    const full = 'Runtime storage is full: every installed version (1.15.0, 1.16.0) is active or pending for a project, or used by a running process.';
    const f = await waiting('download-failed', { lastError: full });
    const [line] = await reviewNotices(f.context.paths, 'example');
    expect(line).toContain('99.0.0 could not be downloaded for example');
    expect(line).toContain(full);
    expect(line).toMatch(/Run: npx --no-install rove-sentinel repair$/);
    const old = await waiting('download-failed', { pendingVersion: '1.0.0', lastError: full });
    expect(await reviewNotices(old.context.paths, 'example')).toEqual([]);
    // A failed attempt names its version without reserving it.
    const attempt = await waiting('download-failed', { pendingVersion: null, attemptedVersion: '99.0.0', lastError: full });
    expect((await reviewNotices(attempt.context.paths, 'example'))[0]).toContain('99.0.0 could not be downloaded');
  });
});
