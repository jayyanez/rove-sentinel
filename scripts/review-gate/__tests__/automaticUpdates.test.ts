import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automaticUpdate, maybeStartUpdateWorker } from '../automatic-updates.mjs';
import { engineCli, engineDirectory, engineStatePath, ensureEngine, publishEngineState, selectedEngine } from '../engine-store.mjs';
import { acquireReviewLease, acquireUpdateLease, updateMarker } from '../maintenance.mjs';
import { atomicWriteJson, ensureState, readJson } from '../storage.mjs';
import { policyForEngineUpgrade } from '../install.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
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
    ensure: vi.fn(async () => {}), status: vi.fn(async () => health), stop: vi.fn(async () => true), run,
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
  async function distribution() {
    const root = await temp(); const archive = Buffer.from('synthetic archive');
    const digest = createHash('sha256').update(archive).digest('hex');
    const fetchImpl = vi.fn(async (url) => new Response(url.endsWith('SHA256SUMS') ? `${digest}  rove-sentinel-1.11.0.tgz\n` : archive));
    const npm = vi.fn(async (_args, { cwd }) => {
      const packageRoot = path.join(cwd, 'node_modules/rove-sentinel');
      await mkdir(path.join(packageRoot, 'scripts/review-gate'), { recursive: true });
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'rove-sentinel', version: '1.11.0', sentinelEngineProtocol: 1 }));
      await writeFile(path.join(packageRoot, 'scripts/review-gate/cli.mjs'), '');
    });
    return { root, fetchImpl, npm };
  }
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
