import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findOrphans, formatRepair, repairRepository, reviewDirectoriesIn, stopProcesses } from '../repair.mjs';
import { recoverReviewGate, resumeReviewGate, startWatcher } from '../install.mjs';
import { updateMarker } from '../maintenance.mjs';
import { atomicWriteJson, ensureState, readJson } from '../storage.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { CHARTER_VERSION, GATE_VERSION } from '../constants.mjs';
import { safetyPauseReason } from '../process.mjs';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'sentinel-repair-test-')); dirs.push(dir); return dir; }

const DEAD = 2 ** 31 - 2;
const NEXT = 'Run: npx --no-install rove-sentinel repair';
const STOP = 'npx --no-install rove-sentinel repair --stop-orphans';

type Proc = { pid: number; ppid: number; name: string; commandLine: string; startedAt: number | null };

async function fixture({ processes = [] as Proc[] } = {}) {
  const base = await temp();
  const paths = await ensureState(path.join(base, 'state', 'repo-state'));
  const repoRoot = path.join(base, 'checkout');
  await mkdir(path.join(repoRoot, '.git'), { recursive: true });
  const context = { repoRoot, stateRoot: paths.root, paths };
  const policy = reviewPolicySnapshot({ charter: 'Charter', lessons: 'Lessons', config: {} });
  await atomicWriteJson(paths.policy, policy);
  const list = { processes };
  const deps = {
    contextFor: async () => context, root: path.join(base, 'engines'), platform: 'win32',
    list: vi.fn(async () => list.processes), stop: vi.fn(async (targets) => targets.map((t) => t.pid)),
    startWatcherFn: vi.fn(async () => ({ started: true, pid: 4321 })), recover: vi.fn(async () => ({ recovered: true })),
    rollBack: vi.fn(async () => ({ rolledBack: true, version: '1.20.0', nextVersion: '1.20.1' })),
    update: vi.fn(async () => ({ status: 'updated', version: '1.20.1' })),
    startedAt: async () => null, waitMs: 0, reinstall: vi.fn(async () => ({})),
  };
  const healthy = async (extra = {}) => {
    await atomicWriteJson(paths.lock, { ownerToken: 'owner-token', pid: process.pid, startedAt: new Date().toISOString() });
    await atomicWriteJson(paths.heartbeat, { ownerToken: 'owner-token', pid: process.pid, at: new Date().toISOString(),
      repoRoot, gateVersion: GATE_VERSION, charterVersion: CHARTER_VERSION, policyDigest: policy.policyDigest, activity: 'paused', ...extra });
  };
  return { base, paths, repoRoot, context, deps, list, healthy };
}
const repair = (f, options = {}) => repairRepository({ repoRoot: f.repoRoot, ...options }, f.deps);
const events = async (paths) => Promise.all((await readdir(paths.events).catch(() => [])).map((name) => readJson(path.join(paths.events, name))));

describe('which processes a repair may count as this repository\'s', () => {
  it('reads Sentinel review directories from command lines, quoted, with spaces or after an equals sign', () => {
    expect(reviewDirectoriesIn('claude.exe -p --add-dir "C:\\Build Area\\Temp\\rove-review-abc123\\checkout" C:\\Temp\\rove-review-context-x1Y2 --effort high'))
      .toEqual(['C:\\Build Area\\Temp\\rove-review-abc123', 'C:\\Temp\\rove-review-context-x1Y2']);
    expect(reviewDirectoriesIn('codex exec --cd=/tmp/rove-review-context-Q9 --add-dir /tmp/rove-review-Z/checkout')).toEqual(['/tmp/rove-review-context-Q9', '/tmp/rove-review-Z']);
    expect(reviewDirectoriesIn('node build.js --name rove-review-context-nothing')).toEqual([]);
  });
  it('counts a process of this repository\'s review that no running review owns, its descendants, and nothing else', async () => {
    const f = await fixture();
    const mine = path.join(f.base, 'tmp', 'rove-review-context-mine');
    const active = path.join(f.base, 'tmp', 'rove-review-context-active');
    const other = path.join(f.base, 'tmp', 'rove-review-context-other');
    for (const [dir, owner] of [[mine, { pid: 111, repoRoot: f.repoRoot }], [active, { pid: process.pid, repoRoot: f.repoRoot }], [other, { pid: 111, repoRoot: path.join(f.base, 'elsewhere') }]] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'owner.json'), JSON.stringify(owner));
    }
    // The running review's lease.
    await mkdir(path.join(f.paths.root, 'active-reviews'), { recursive: true });
    await writeFile(path.join(f.paths.root, 'active-reviews', `${process.pid}-00000000-0000-4000-8000-000000000000.json`), JSON.stringify({ pid: process.pid }));
    const processes: Proc[] = [
      { pid: process.pid, ppid: 1, name: 'node.exe', commandLine: 'node gate', startedAt: 1 },
      { pid: 201, ppid: 111, name: 'codex.exe', commandLine: `codex exec --cd "${mine}"`, startedAt: 10 },
      { pid: 202, ppid: 201, name: 'pwsh.exe', commandLine: 'pwsh -NoProfile', startedAt: 11 },
      { pid: 203, ppid: process.pid, name: 'claude.exe', commandLine: `claude -p --add-dir "${active}"`, startedAt: 12 },
      { pid: 204, ppid: 111, name: 'codex.exe', commandLine: `codex exec --cd "${other}"`, startedAt: 13 },
      { pid: 205, ppid: 1, name: 'codex.exe', commandLine: `codex exec --cd "${path.join(f.base, 'tmp', 'rove-review-context-gone')}"`, startedAt: 14 },
    ];
    const found = await findOrphans(f.context, { processes });
    expect(found.map((entry) => [entry.pid, entry.kind])).toEqual([[201, 'repository'], [205, 'unattributed'], [202, 'repository']]);
  });
  it('traces the provider recorded in a safety pause, but not a PID reused after it', async () => {
    const f = await fixture();
    const pause = { pausedAt: new Date(1_000).toISOString(), reason: 'x', kind: 'provider-cleanup', provider: { pid: 300, command: 'codex' } };
    const processes: Proc[] = [
      { pid: 301, ppid: 300, name: 'node.exe', commandLine: 'node mcp-server', startedAt: 500 },
      { pid: 302, ppid: 300, name: 'notepad.exe', commandLine: 'notepad', startedAt: 5_000 },
    ];
    expect((await findOrphans(f.context, { processes, pause })).map((entry) => entry.pid)).toEqual([301]);
  });
  it('stops only processes whose PID still has the start time they were listed with, children first', async () => {
    const run = vi.fn(async () => ({}));
    const list = vi.fn(async () => [{ pid: 1, startedAt: 10 }, { pid: 2, startedAt: 99_999 }, { pid: 3, startedAt: 30 }] as any);
    const stopped = await stopProcesses([{ pid: 1, rawStartedAt: 10 }, { pid: 2, rawStartedAt: 20 }, { pid: 3, rawStartedAt: 30 }] as any, { platform: 'win32', run, list });
    expect(stopped).toEqual([3, 1]);
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['3', '1']);
  });
});

describe('repair', () => {
  it('resumes a safety pause once no process of this repository\'s reviews remains, and records the evidence', async () => {
    const f = await fixture(); await f.healthy();
    await atomicWriteJson(f.paths.paused, { pausedAt: new Date().toISOString(), reason: safetyPauseReason('ORPHANED_PROCESS_TREE'), kind: 'provider-cleanup' });
    const report = await repair(f);
    expect(report.ok).toBe(true);
    expect(report.steps).toEqual([expect.objectContaining({ state: 'pause', status: 'fixed' })]);
    expect(await readJson(f.paths.paused)).toBeNull();
    expect((await events(f.paths)).map((event) => event.action)).toContain('safety-pause-lifted');
  });
  it('recognises the safety pauses earlier engines wrote', async () => {
    const f = await fixture(); await f.healthy();
    await atomicWriteJson(f.paths.paused, { pausedAt: new Date().toISOString(), reason: 'Provider process-tree cleanup could not be verified; inspect remaining provider processes before resuming.' });
    expect((await repair(f)).ok).toBe(true);
    expect(await readJson(f.paths.paused)).toBeNull();
  });
  it('keeps a safety pause while its processes remain, names them and the command, and stops them only when told to', async () => {
    const dir = path.join(os.tmpdir(), `rove-review-context-repairtest${process.pid}`);
    dirs.push(dir);
    const f = await fixture();
    await f.healthy();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: 111, repoRoot: f.repoRoot }));
    f.list.processes = [{ pid: 4242, ppid: 111, name: 'codex.exe', commandLine: `codex exec --cd "${dir}"`, startedAt: 10 }];
    const pause = { pausedAt: new Date().toISOString(), reason: safetyPauseReason('PROCESS_TREE_CLEANUP_FAILED'), kind: 'provider-cleanup' };
    await atomicWriteJson(f.paths.paused, pause);
    const report = await repair(f);
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ state: 'pause', status: 'blocked', next: STOP, processes: [expect.objectContaining({ pid: 4242, name: 'codex.exe' })] });
    expect(formatRepair(report)).toContain(`Next: ${STOP}`);
    expect(f.deps.stop).not.toHaveBeenCalled();
    expect(await readJson(f.paths.paused)).toMatchObject({ reason: pause.reason });
    f.deps.stop.mockImplementation(async (targets) => { f.list.processes = []; return targets.map((t) => t.pid); });
    expect((await repair(f, { stopOrphans: true })).ok).toBe(true);
    expect(f.deps.stop.mock.calls[0][0].map((t) => t.pid)).toEqual([4242]);
    expect(await readJson(f.paths.paused)).toBeNull();
  });
  it('never lifts a person\'s pause', async () => {
    const f = await fixture(); await f.healthy();
    await atomicWriteJson(f.paths.paused, { pausedAt: new Date().toISOString(), reason: 'Holding reviews during a release' });
    const report = await repair(f, { stopOrphans: true });
    expect(report.steps[0]).toMatchObject({ status: 'blocked', next: expect.stringContaining('rove-sentinel resume') });
    expect(await readJson(f.paths.paused)).not.toBeNull();
  });
  it('lifts the pause an update left with no activation running', async () => {
    const f = await fixture(); await f.healthy();
    await atomicWriteJson(f.paths.paused, { pausedAt: new Date().toISOString(), reason: 'Automatic Sentinel update to 1.20.1' });
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'pause', status: 'fixed' });
    expect(await readJson(f.paths.paused)).toBeNull();
  });
  it('recovers a watcher whose lock owner is dead or a reused PID, then starts it as install does', async () => {
    for (const lock of [{ pid: DEAD, ownerToken: 'dead-owner', startedAt: new Date().toISOString() },
      { pid: 777, ownerToken: 'reused-pid', startedAt: new Date(1_000).toISOString() }]) {
      const f = await fixture({ processes: [{ pid: 777, ppid: 1, name: 'chrome.exe', commandLine: 'chrome', startedAt: 9_999_999 }] });
      await atomicWriteJson(f.paths.lock, lock);
      const report = await repair(f);
      expect(report.steps).toEqual([expect.objectContaining({ state: 'watcher', status: 'fixed' })]);
      expect(f.deps.recover).toHaveBeenCalledWith(f.context, { reason: expect.stringContaining(String(lock.pid)) });
      expect(f.deps.startWatcherFn).toHaveBeenCalledOnce();
    }
  });
  it('stops a hung watcher of this repository only when told to, then recovers and starts it', async () => {
    const f = await fixture();
    const startedAt = Date.now() - 60_000;
    await atomicWriteJson(f.paths.lock, { pid: 888, ownerToken: 'hung-owner', startedAt: new Date(startedAt + 1_000).toISOString() });
    f.list.processes = [{ pid: 888, ppid: 1, name: 'node.exe', commandLine: `node cli.mjs watch --daemon --repo ${f.repoRoot}`, startedAt }];
    const blocked = await repair(f, { });
    expect(blocked.steps[0]).toMatchObject({ state: 'watcher', status: 'blocked', next: STOP });
    expect(f.deps.recover).not.toHaveBeenCalled();
    const fixed = await repair(f, { stopOrphans: true });
    expect(fixed.steps[0]).toMatchObject({ state: 'watcher', status: 'fixed' });
    expect(f.deps.stop.mock.calls[0][0][0]).toMatchObject({ pid: 888 });
    expect(f.deps.recover).toHaveBeenCalledOnce();
  });
  it('says a watcher that cannot start, with the command, and leaves a repository without one alone', async () => {
    const f = await fixture();
    await atomicWriteJson(f.paths.lock, { pid: DEAD, ownerToken: 'dead-owner' });
    f.deps.startWatcherFn.mockResolvedValue({ started: false, reason: 'the watcher printed an error', next: NEXT });
    expect((await repair(f)).steps[0]).toMatchObject({ status: 'blocked', next: NEXT });
    const g = await fixture();
    g.deps.startWatcherFn.mockResolvedValue({ started: false, reason: 'no scheduled watcher is installed for this repository' });
    expect(await repair(g)).toMatchObject({ ok: true, steps: [expect.objectContaining({ state: 'watcher', status: 'ok' })] });
  });
  it('restarts a watcher of another engine or policy with the installed policy, once no review runs', async () => {
    const f = await fixture(); await f.healthy({ gateVersion: '1.0.0', activity: 'idle' });
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'watcher', status: 'fixed' });
    expect(f.deps.reinstall).toHaveBeenCalledWith(f.repoRoot);
    const g = await fixture(); await g.healthy({ gateVersion: '1.0.0', activity: 'review' });
    expect((await repair(g)).steps[0]).toMatchObject({ status: 'busy' });
    expect(g.deps.reinstall).not.toHaveBeenCalled();
  });
  it('removes a queue submission lock of a dead process, and keeps a live one', async () => {
    const f = await fixture(); await f.healthy({ activity: 'idle' });
    await writeFile(f.paths.queueSubmitLock, JSON.stringify({ pid: process.pid, ownerToken: 'live' }));
    expect((await repair(f)).steps).toEqual([]);
    await writeFile(f.paths.queueSubmitLock, JSON.stringify({ pid: DEAD, ownerToken: 'dead' }));
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'queue-lock', status: 'fixed' });
    await expect(readFile(f.paths.queueSubmitLock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('removes the store\'s stale download lock, and waits for a live one', async () => {
    const f = await fixture(); await f.healthy({ activity: 'idle' });
    await mkdir(f.deps.root, { recursive: true });
    await writeFile(path.join(f.deps.root, 'download.lock'), JSON.stringify({ pid: process.pid, version: '1.20.1' }));
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'store-lock', status: 'busy', next: expect.stringContaining('rove-sentinel repair') });
    await writeFile(path.join(f.deps.root, 'download.lock'), JSON.stringify({ pid: DEAD, version: '1.20.1' }));
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'store-lock', status: 'fixed' });
    await expect(readFile(path.join(f.deps.root, 'download.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rolls back an activation whose process is gone, and waits for one that runs', async () => {
    const f = await fixture(); await f.healthy({ activity: 'idle' });
    await atomicWriteJson(updateMarker(f.paths), { version: '1.20.1', pid: process.pid, startedAt: new Date().toISOString() });
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'interrupted-activation', status: 'busy' });
    expect(f.deps.rollBack).not.toHaveBeenCalled();
    await atomicWriteJson(updateMarker(f.paths), { version: '1.20.1', pid: DEAD, startedAt: new Date().toISOString() });
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'interrupted-activation', status: 'fixed' });
    expect(f.deps.rollBack).toHaveBeenCalledOnce();
  });
  it('retries a waiting or failed update once nothing holds it, and names the projects a full store holds', async () => {
    const f = await fixture(); await f.healthy({ activity: 'idle' });
    const info = vi.fn(async () => ({ automatic: true, phase: 'download-failed', pendingVersion: null, blockedBy: [] }));
    f.deps.info = info;
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'update', status: 'fixed' });
    expect(f.deps.update).toHaveBeenCalledWith({ repoRoot: f.repoRoot, force: true });
    f.deps.update.mockResolvedValue({ status: 'download-failed', error: 'Runtime storage is full: every installed version (1.18.0) is active or pending for a project, or used by a running process.' });
    await atomicWriteJson(path.join(f.deps.root, 'consumers', 'held.json'), { repoRoot: f.repoRoot, activeVersion: '1.18.0' });
    const report = await repair(f);
    expect(report.steps[0]).toMatchObject({ state: 'update', status: 'blocked', holders: [expect.objectContaining({ activeVersion: '1.18.0' })] });
    expect(report.steps[0].next).toContain('rove-sentinel repair');
  });
  it('removes a daemon-lock takeover marker over ten minutes old, and a watcher lock never given an owner', async () => {
    const f = await fixture(); await f.healthy({ activity: 'idle' });
    await writeFile(f.paths.takeover, '');
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'takeover-marker', status: 'busy' });
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(f.paths.takeover, old, old);
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'takeover-marker', status: 'fixed' });
    await expect(readFile(f.paths.takeover)).rejects.toMatchObject({ code: 'ENOENT' });
    const g = await fixture();
    await writeFile(g.paths.lock, '{');
    await utimes(g.paths.lock, old, old);
    expect((await repair(g)).steps[0]).toMatchObject({ state: 'watcher', status: 'fixed' });
    expect(g.deps.recover).toHaveBeenCalledOnce();
  });
  it('changes nothing in a dry run', async () => {
    const f = await fixture(); await f.healthy();
    const pause = { pausedAt: new Date().toISOString(), reason: safetyPauseReason('ORPHANED_PROCESS_TREE'), kind: 'provider-cleanup' };
    await atomicWriteJson(f.paths.paused, pause);
    await atomicWriteJson(updateMarker(f.paths), { version: '1.20.1', pid: DEAD });
    const report = await repair(f, { dryRun: true });
    expect(report.steps.map((entry) => entry.status)).toEqual(['would-fix', 'would-fix']);
    expect(await readJson(f.paths.paused)).toMatchObject({ reason: pause.reason });
    expect(f.deps.rollBack).not.toHaveBeenCalled();
    expect(await events(f.paths)).toEqual([]);
  });
});

describe('recover and resume start the watcher', () => {
  it('starts the installed scheduled task, or names install when there is none', async () => {
    const f = await fixture();
    const run = vi.fn(async (_command, args) => (args[0] === '/Query' ? { code: 0, stdout: '' } : { code: 0 }));
    const started = await startWatcher(f.context, { platform: 'win32', run, waitHeartbeat: async () => ({ pid: 99 }), clearError: async () => {} });
    expect(started).toEqual({ started: true, pid: 99 });
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['/Query', '/Run']);
    const missing = vi.fn(async () => ({ code: 1, stderr: 'ERROR: The system cannot find the file specified.' }));
    expect(await startWatcher(f.context, { platform: 'win32', run: missing, clearError: async () => {} }))
      .toMatchObject({ started: false, next: expect.stringContaining('rove-sentinel install') });
  });
  it('recover starts the watcher after clearing its state; resume starts one that is not running', async () => {
    const f = await fixture();
    const start = vi.fn(async () => ({ started: true, pid: 5 }));
    expect(await recoverReviewGate({ repoRoot: f.repoRoot, reason: 'a dead watcher lock' }, { start, contextFor: async () => f.context, recover: async () => ({ recovered: true }) }))
      .toMatchObject({ recovered: true, watcher: { started: true } });
    expect(await resumeReviewGate({ repoRoot: f.repoRoot }, { start, contextFor: async () => f.context })).toMatchObject({ resumed: true, watcher: { started: true } });
    await f.healthy();
    start.mockClear();
    expect(await resumeReviewGate({ repoRoot: f.repoRoot }, { start, contextFor: async () => f.context })).toMatchObject({ watcher: { running: true } });
    expect(start).not.toHaveBeenCalled();
  });
});
