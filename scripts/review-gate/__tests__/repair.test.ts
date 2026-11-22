import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findOrphans, formatRepair, listProcesses, repairRepository, reviewDirectoriesIn, reviewDirectoryCandidates, stopProcesses } from '../repair.mjs';
import { recoverReviewGate, resumeReviewGate, startWatcher } from '../install.mjs';
import { rollBackInterruptedUpdate } from '../automatic-updates.mjs';
import { updateMarker } from '../maintenance.mjs';
import { atomicWriteJson, ensureState, readJson } from '../storage.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { CHARTER_VERSION, GATE_VERSION } from '../constants.mjs';
import { REPAIR_BOOTSTRAP, safetyPauseReason } from '../process.mjs';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'sentinel-repair-test-')); dirs.push(dir); return dir; }

const DEAD = 2 ** 31 - 2;
const NEXT = 'Run: npx --no-install rove-sentinel repair';
const STOP = 'npx --no-install rove-sentinel repair --stop-orphans';
const RESUME_IF_ASKED = 'Only if the person who asked for this repair asked you to lift that pause, run: npx --no-install rove-sentinel resume';

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
    selectedVersionOf: async () => GATE_VERSION, sentinel: vi.fn(async () => ({ stdout: '{}' })),
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
    // `ps` joins arguments with spaces: a path with spaces is read from each earlier space too.
    expect(reviewDirectoryCandidates('codex exec --cd /var/tmp/my dir/rove-review-context-Q9')).toEqual([['/var/tmp/my dir/rove-review-context-Q9']]);
    expect(reviewDirectoryCandidates('codex --add-dir /srv/x /tmp/rove-review-A')).toEqual([['/tmp/rove-review-A', '/srv/x /tmp/rove-review-A']]);
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
    expect(found.orphans.map((entry) => [entry.pid, entry.kind])).toEqual([[201, 'repository'], [202, 'repository']]);
    // A directory without an owner record is listed, never counted or stopped.
    expect(found.unattributed.map((entry) => entry.pid)).toEqual([205]);
  });
  it('traces the provider recorded in a safety pause, but not a PID reused after it', async () => {
    const f = await fixture();
    const pause = { pausedAt: new Date(1_000).toISOString(), reason: 'x', kind: 'provider-cleanup', provider: { pid: 300, command: 'codex' } };
    const processes: Proc[] = [
      { pid: 301, ppid: 300, name: 'node.exe', commandLine: 'node mcp-server', startedAt: 500 },
      { pid: 302, ppid: 300, name: 'notepad.exe', commandLine: 'notepad', startedAt: 5_000 },
    ];
    expect((await findOrphans(f.context, { processes, pause })).orphans.map((entry) => entry.pid)).toEqual([301]);
  });
  it('lists macOS and Linux processes with times in UTC and the C format, keeping the user\'s characters', async () => {
    const run = vi.fn(async () => ({ stdout: '  42     1 Wed Nov 19 08:00:00 2026 /usr/bin/codex exec --cd /tmp/rove-review-context-é1\n' }));
    const saved = process.env.LC_ALL;
    process.env.LC_ALL = 'fr_FR.UTF-8';
    try {
      const [proc] = await listProcesses({ platform: 'darwin', run });
      expect(proc).toMatchObject({ pid: 42, ppid: 1, startedAt: Date.parse('2026-11-19T08:00:00Z'), commandLine: '/usr/bin/codex exec --cd /tmp/rove-review-context-é1' });
      const { env } = run.mock.calls[0][2];
      expect(env).toMatchObject({ TZ: 'UTC', LC_TIME: 'C', LC_CTYPE: 'fr_FR.UTF-8' });
      expect(env.LC_ALL).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saved;
    }
  });
  it('reads the Windows listing one line a process, and keeps every process a damaged line still names, marked unreadable', async () => {
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    const lines = [
      `P 0 0 1000 ${b64('System Idle Process')}  E`,
      `P 42 7 2000 ${b64('node.exe')} ${b64('node watch \u2192 \u2022 \u2713 \u00d7 "C:\\Temp\\rove-review-context-1"')} E`,
      // A start time the system did not give, and a command line that does not decode.
      `P 43 42  ${b64('codex.exe')} not*base64 E`,
      // A parent PID and a start time beyond what a Date holds, which no listing gives.
      `P 44 4x2 99999999999999999 ${b64('node.exe')} ${b64('node')} E`,
      // Cut short: the end marker, or more, is missing.
      'P 45 1',
      `P 46 1 3000 ${b64('node.exe')} ${b64('node --flag')}`,
      // Base64 of bytes that are not UTF-8, and an empty parent PID, which the listing never writes.
      `P 47  3000 ${b64('node.exe')} ${Buffer.from([0xff, 0xfe, 0x41]).toString('base64')} E`,
      // A leading U+FEFF is the command line's own.
      `P 48 1 3000 ${b64('node.exe')} ${b64('\ufeffnode')} E`,
      'WARNING: anything else PowerShell printed',
    ];
    const run = vi.fn(async () => ({ stdout: [...lines, 'END 8', ''].join('\r\n') }));
    expect(await listProcesses({ platform: 'win32', run })).toEqual([
      { pid: 0, ppid: 0, name: 'System Idle Process', commandLine: '', startedAt: 1000 },
      { pid: 42, ppid: 7, name: 'node.exe', commandLine: 'node watch \u2192 \u2022 \u2713 \u00d7 "C:\\Temp\\rove-review-context-1"', startedAt: 2000 },
      { pid: 43, ppid: 42, name: 'codex.exe', commandLine: '', startedAt: null, unreadable: true },
      { pid: 44, ppid: null, name: 'node.exe', commandLine: 'node', startedAt: null, unreadable: true },
      { pid: 45, ppid: 1, name: '', commandLine: '', startedAt: null, unreadable: true },
      { pid: 46, ppid: 1, name: 'node.exe', commandLine: 'node --flag', startedAt: 3000, unreadable: true },
      { pid: 47, ppid: null, name: 'node.exe', commandLine: '', startedAt: 3000, unreadable: true },
      { pid: 48, ppid: 1, name: 'node.exe', commandLine: '\ufeffnode', startedAt: 3000 },
    ]);
    expect(run.mock.calls[0][0]).toBe('powershell.exe');
    // A listing that did not end, or whose count or a PID cannot be read, would hide a process: it fails.
    const whole = `P 42 7 2000 ${b64('node.exe')} ${b64('node')} E`;
    for (const [stdout, error] of [
      [`${whole}\r\n`, 'did not end'],
      [`${whole}\r\nP x 7 2000 ${b64('node.exe')} ${b64('node')} E\r\nEND 2\r\n`, 'gave 1 readable PID(s) for 2 process line(s)'],
      [`${whole}\r\nEND 2\r\n`, 'gave 1 readable PID(s) for 2 process line(s)'],
      [`${whole}\r\nEND x\r\n`, 'an unreadable count of'],
    ]) await expect(listProcesses({ platform: 'win32', run: async () => ({ stdout }) })).rejects.toThrow(error);
  });
  // Windows PowerShell writes to a pipe in the console's code page, where U+2192
  // and U+2022 become the control bytes 0x1A and 0x07 that broke the JSON listing.
  it.runIf(process.platform === 'win32')('lists a Windows process whose command line holds symbols the console code page cannot write', async () => {
    const marker = 'sentinel-listing-probe \u2192 \u2022 \u2191 \u2193 \u00a7 \u00b6 \u2713 \u2718 \u00d7';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', marker, 'x'.repeat(5000)], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const found = (await listProcesses()).find((proc) => proc.pid === child.pid);
      expect(found?.commandLine).toContain(marker);
      expect(found?.commandLine.endsWith('x'.repeat(5000))).toBe(true);
      expect(found?.startedAt).toEqual(expect.any(Number));
    } finally { child.kill(); }
  }, 120_000);
  it('stops only processes whose PID still has the start time it was listed with, children first, and counts only confirmed stops', async () => {
    const run = vi.fn(async (_command, args) => ({ code: args[1] === '4' ? 128 : 0 }));
    const list = vi.fn(async () => [{ pid: 1, startedAt: 10 }, { pid: 2, startedAt: 99_999 }, { pid: 3, startedAt: 30 }, { pid: 4, startedAt: 40 }, { pid: 5, startedAt: null }] as any);
    const stopped = await stopProcesses([{ pid: 1, rawStartedAt: 10 }, { pid: 2, rawStartedAt: 20 }, { pid: 3, rawStartedAt: 30 }, { pid: 4, rawStartedAt: 40 }, { pid: 5, rawStartedAt: null }] as any, { platform: 'win32', run, list });
    expect(stopped).toEqual([3, 1]);
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['4', '3', '1']);
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
  it('keeps a safety pause while a process the listing could not read whole might be one of its reviews', async () => {
    const f = await fixture({ processes: [{ pid: 77, ppid: 1, name: 'codex.exe', commandLine: '', startedAt: null, unreadable: true } as Proc] });
    await f.healthy();
    const pause = { pausedAt: new Date().toISOString(), reason: safetyPauseReason('ORPHANED_PROCESS_TREE'), kind: 'provider-cleanup' };
    await atomicWriteJson(f.paths.paused, pause);
    for (const dryRun of [true, false]) {
      const report = await repair(f, { dryRun });
      expect(report.steps).toEqual([expect.objectContaining({ state: 'pause', status: 'blocked', next: 'Run again in one minute: npx --no-install rove-sentinel repair' })]);
      expect(report.steps[0].detail).toContain('PID 77');
      expect(await readJson(f.paths.paused)).toEqual(pause);
    }
    // Nor does a dry run promise that stopping a known leftover would resume.
    const traced = { ...pause, pausedAt: new Date(10_000).toISOString(), provider: { pid: 300, command: 'codex' } };
    await atomicWriteJson(f.paths.paused, traced);
    f.list.processes = [...f.list.processes, { pid: 301, ppid: 300, name: 'node.exe', commandLine: 'node mcp-server', startedAt: 500 }];
    const dry = await repair(f, { dryRun: true, stopOrphans: true });
    expect(dry.steps).toEqual([expect.objectContaining({ state: 'pause', status: 'blocked' })]);
    // An unreadable process that is itself one of the leftovers to stop holds nothing back.
    f.list.processes = [{ pid: 301, ppid: 300, name: 'node.exe', commandLine: '', startedAt: 500, unreadable: true } as Proc];
    expect((await repair(f, { dryRun: true, stopOrphans: true })).steps).toEqual([expect.objectContaining({ state: 'pause', status: 'would-fix' })]);
  });
  it('checks a safety pause an earlier engine wrote for leftover processes, but resumes it only on a person\'s word', async () => {
    const dir = path.join(os.tmpdir(), `rove-review-context-repairlegacy${process.pid}`);
    dirs.push(dir);
    const f = await fixture(); await f.healthy();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: 111, repoRoot: f.repoRoot }));
    f.list.processes = [{ pid: 4242, ppid: 111, name: 'codex.exe', commandLine: `codex exec --cd "${dir}"`, startedAt: 10 }];
    // With no kind, the record a person typing this sentence would leave too.
    const pause = { pausedAt: new Date().toISOString(), reason: 'Provider process-tree cleanup could not be verified; inspect remaining provider processes before resuming.' };
    await atomicWriteJson(f.paths.paused, pause);
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'pause', status: 'blocked', next: STOP, processes: [expect.objectContaining({ pid: 4242 })] });
    // A dry run does not promise to fix what stopping them still leaves paused.
    const dry = (await repair(f, { dryRun: true, stopOrphans: true })).steps[0];
    expect(dry).toMatchObject({ state: 'pause', status: 'blocked' });
    expect(dry.detail).toContain('Once they are stopped, the pause stays');
    f.deps.stop.mockImplementation(async (targets) => { f.list.processes = []; return targets.map((t) => t.pid); });
    const report = await repair(f, { stopOrphans: true });
    expect(f.deps.stop.mock.calls[0][0].map((t) => t.pid)).toEqual([4242]);
    expect(report.steps[0]).toMatchObject({ state: 'pause', status: 'blocked', next: RESUME_IF_ASKED });
    expect(report.steps[0].detail).toContain('No process left by this repository\'s reviews remains');
    expect(await readJson(f.paths.paused)).toEqual(pause);
    expect((await repair(f, { dryRun: true })).steps[0]).toMatchObject({ state: 'pause', status: 'blocked', next: RESUME_IF_ASKED });
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
  it('never lifts a person\'s pause, even one whose reason reads like Sentinel\'s', async () => {
    for (const pause of [{ reason: 'Holding reviews during a release' },
      { reason: safetyPauseReason('ORPHANED_PROCESS_TREE'), kind: 'manual' },
      { reason: 'Automatic Sentinel update to 9.9.9', kind: 'manual' },
      // With no kind, as engines before 1.20.1 wrote every pause: Sentinel's openings, then a person's words.
      { reason: 'Automatic Sentinel update to 1.20.0 broke the hook; hold reviews' },
      { reason: 'Provider process-tree cleanup could not be verified; hold reviews until the build machine is checked' }]) {
      const f = await fixture(); await f.healthy();
      await atomicWriteJson(f.paths.paused, { pausedAt: new Date().toISOString(), ...pause });
      const report = await repair(f, { stopOrphans: true });
      expect(report.steps[0]).toMatchObject({ status: 'blocked', next: RESUME_IF_ASKED });
      expect(await readJson(f.paths.paused)).not.toBeNull();
    }
  });
  it('resumes a pause whose record cannot be read only on the word of the person who asked for the repair', async () => {
    const f = await fixture(); await f.healthy();
    await writeFile(f.paths.paused, '{');
    const report = await repair(f, { stopOrphans: true });
    expect(report.steps[0]).toMatchObject({ state: 'pause', status: 'blocked', next: RESUME_IF_ASKED });
    expect(formatRepair(report)).not.toContain('Next: Run: npx --no-install rove-sentinel resume');
    expect(await readFile(f.paths.paused, 'utf8')).toBe('{');
  });
  it('runs one repair at a time for a repository, and takes over from one whose process is gone or a reused PID', async () => {
    const f = await fixture(); await f.healthy({ activity: 'idle' });
    f.list.processes = [{ pid: process.pid, ppid: 1, name: 'node.exe', commandLine: 'node', startedAt: 5 }];
    const leases = path.join(f.paths.root, 'repairs');
    await mkdir(leases, { recursive: true });
    const other = path.join(leases, `${process.pid}-other.json`);
    await writeFile(other, JSON.stringify({ pid: process.pid, startedAt: 5 }));
    expect(await repair(f)).toMatchObject({ ok: false, steps: [expect.objectContaining({ state: 'repair', status: 'busy' })] });
    // The repair that stopped took its own lease back; an old lease of a live repair stays live.
    expect(await readdir(leases)).toEqual([`${process.pid}-other.json`]);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(other, old, old);
    expect((await repair(f)).ok).toBe(false);
    // The same PID, listed with another start time, is another process: its lease is stale.
    await writeFile(other, JSON.stringify({ pid: process.pid, startedAt: 4 }));
    expect(await repair(f)).toMatchObject({ ok: true, steps: [] });
    expect(await readdir(leases)).toEqual([]);
    await writeFile(other, JSON.stringify({ pid: DEAD }));
    expect(await repair(f)).toMatchObject({ ok: true, steps: [] });
    expect(await readdir(leases)).toEqual([]);
  });
  it('names the command for unreadable update settings, and the running processes that fill a store', async () => {
    const f = await fixture(); await f.healthy({ activity: 'idle' });
    f.deps.info = vi.fn(async () => ({ settingsError: 'Unexpected end of JSON input', automatic: null, phase: 'download-failed', blockedBy: [] }));
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'update-settings', status: 'blocked', next: 'Run: npx --no-install rove-sentinel updates --enable' });
    f.deps.info = vi.fn(async () => ({ automatic: true, phase: 'download-failed', blockedBy: [] }));
    f.deps.update.mockResolvedValue({ status: 'download-failed', error: 'Runtime storage is full: every installed version (1.18.0) is active or pending for a project, or used by a running process.' });
    await atomicWriteJson(path.join(f.deps.root, 'processes', 'live.json'), { pid: process.pid, version: '1.18.0' });
    const report = await repair(f);
    expect(report.steps[0].holders).toEqual([{ pid: process.pid, version: '1.18.0' }]);
    expect(formatRepair(report)).toContain(`PID ${process.pid}, uses 1.18.0`);
  });
  it('lifts the pause an update left with no activation running', async () => {
    const f = await fixture(); await f.healthy();
    await atomicWriteJson(f.paths.paused, { pausedAt: new Date().toISOString(), reason: 'Automatic Sentinel update to 1.20.1', kind: 'update' });
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'pause', status: 'fixed' });
    expect(await readJson(f.paths.paused)).toBeNull();
  });
  it('keeps the updater\'s reason with no kind, which a person may have typed, and lifts it only on that person\'s word', async () => {
    const f = await fixture(); await f.healthy();
    const pause = { pausedAt: new Date().toISOString(), reason: 'Automatic Sentinel update to 1.20.1' };
    await atomicWriteJson(f.paths.paused, pause);
    // While an earlier engine's activation runs, the pause is that activation's to lift.
    await atomicWriteJson(updateMarker(f.paths), { version: '1.20.1', pid: process.pid, startedAt: new Date().toISOString() });
    expect((await repair(f)).steps.filter((entry) => entry.state === 'pause')).toEqual([]);
    expect(await readJson(f.paths.paused)).toEqual(pause);
    await rm(updateMarker(f.paths), { force: true });
    const report = await repair(f, { stopOrphans: true });
    expect(report.steps[0]).toMatchObject({ state: 'pause', status: 'blocked', next: RESUME_IF_ASKED });
    expect(report.steps[0].detail).toContain('the record does not say which');
    expect(await readJson(f.paths.paused)).toEqual(pause);
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
  it('names a local installation\'s recorded launcher in the Next lines that run repair', async () => {
    const f = await fixture();
    await atomicWriteJson(f.paths.installation, { schemaVersion: 1, mode: 'local', hook: '/opt/hooks/pre-push', launcher: '/opt/tools/it\u2019s/launcher.mjs', node: '/opt/node/bin/node', config: null });
    const startedAt = Date.now() - 60_000;
    await atomicWriteJson(f.paths.lock, { pid: 888, ownerToken: 'hung-owner', startedAt: new Date(startedAt + 1_000).toISOString() });
    f.list.processes = [{ pid: 888, ppid: 1, name: 'node.exe', commandLine: `node cli.mjs watch --daemon --repo ${f.repoRoot}`, startedAt }];
    const report = await repair(f);
    // PowerShell ends a quoted string at a typographic apostrophe too: it is doubled.
    expect(report.steps[0].next).toBe(`& '/opt/node/bin/node' '/opt/tools/it\u2019\u2019s/launcher.mjs' repair --stop-orphans --repo '${f.repoRoot}'`);
  });
  it('names the watcher checkout in a local installation line for it', async () => {
    const f = await fixture();
    await atomicWriteJson(f.paths.installation, { schemaVersion: 1, mode: 'local', hook: '/opt/hooks/pre-push', launcher: '/opt/tools/launcher.mjs', node: '/opt/node/bin/node', config: null });
    await f.healthy({ gateVersion: '1.0.0', activity: 'idle', repoRoot: '/work/watcher-checkout' });
    const report = await repair(f);
    expect(report.steps[0].next).toBe("Run in /work/watcher-checkout: & '/opt/node/bin/node' '/opt/tools/launcher.mjs' repair --repo '/work/watcher-checkout'");
    // The checkout is not read back from the line, nor rewritten in it: a newline,
    // ': ' or the text of a command in its path changes nothing.
    const odd = '/work/a: b\nnpx --no-install rove-sentinel repair/watcher';
    await f.healthy({ gateVersion: '1.0.0', activity: 'idle', repoRoot: odd });
    const again = await repair(f);
    expect(again.steps[0].next).toBe(`Run in ${odd}: & '/opt/node/bin/node' '/opt/tools/launcher.mjs' repair --repo '${odd}'`);
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
    // Each listed checkout may select an engine before 1.20.1: the bootstrap reaches repair in any.
    expect(report.steps[0].next).toBe(`Run in each checkout listed: ${REPAIR_BOOTSTRAP}`);
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
  it('reports a scheduler that fails, rather than throwing', async () => {
    const f = await fixture();
    const run = vi.fn(async (_command, args) => { if (args[0] === '/Run') throw new Error('Access is denied.'); return { code: 0 }; });
    expect(await startWatcher(f.context, { platform: 'win32', run, clearError: async () => {} }))
      .toMatchObject({ started: false, reason: 'Access is denied.', next: NEXT });
  });
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

describe('rolling back an interrupted activation', () => {
  it('removes only the fence when the journal beside it is an earlier update\'s', async () => {
    const f = await fixture();
    await atomicWriteJson(path.join(f.paths.root, 'update-recovery.json'), { nextVersion: '1.19.0', previousCli: 'old-cli', previousPolicy: {}, previousState: {} });
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(f.paths.root, 'update-recovery.json'), old, old);
    await atomicWriteJson(updateMarker(f.paths), { version: '1.20.1', pid: DEAD, startedAt: new Date().toISOString() });
    const stop = vi.fn(async () => true); const run = vi.fn();
    expect(await rollBackInterruptedUpdate(f.context, { stop, run, root: f.deps.root, startedAt: async () => null }))
      .toMatchObject({ rolledBack: true, unchanged: true });
    expect(stop).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(await readJson(updateMarker(f.paths))).toBeNull();
  });
  it('trusts only the journal of its own fence, refuses an unreadable one, and keeps a person\'s pause', async () => {
    const f = await fixture();
    const fence = { version: '1.20.1', pid: DEAD, startedAt: '2026-11-19T00:00:00.000Z' };
    await atomicWriteJson(updateMarker(f.paths), fence);
    await atomicWriteJson(path.join(f.paths.root, 'update-recovery.json'), { nextVersion: '1.20.1', previousCli: 'old-cli',
      previousPolicy: {}, previousState: {}, fence: { pid: DEAD, startedAt: '2026-11-01T00:00:00.000Z' } });
    const stop = vi.fn(async () => true); const run = vi.fn();
    expect(await rollBackInterruptedUpdate(f.context, { stop, run, root: f.deps.root, startedAt: async () => null })).toMatchObject({ unchanged: true });
    expect(stop).not.toHaveBeenCalled();
    await atomicWriteJson(updateMarker(f.paths), fence);
    await writeFile(path.join(f.paths.root, 'update-recovery.json'), '{');
    await expect(rollBackInterruptedUpdate(f.context, { stop, run, root: f.deps.root, startedAt: async () => null })).rejects.toThrow('cannot be read');
    expect(await readJson(updateMarker(f.paths))).toEqual(fence);
    // The journal of this fence: rolled back, and a person's pause with an update-like reason stays.
    await atomicWriteJson(path.join(f.paths.root, 'update-recovery.json'), { nextVersion: '1.20.1', previousCli: 'old-cli',
      previousPolicy: {}, previousState: {}, fence: { pid: DEAD, startedAt: fence.startedAt } });
    const manual = { pausedAt: new Date().toISOString(), reason: 'Automatic Sentinel update to 1.20.1', kind: 'manual' };
    await atomicWriteJson(f.paths.paused, manual);
    const ok = vi.fn(async (_node, args) => ({ stdout: args.includes('--version') ? '1.20.0'
      : args.includes('status') ? JSON.stringify({ watcherRunning: true, heartbeat: { gateVersion: '1.20.0' } }) : '' }));
    expect(await rollBackInterruptedUpdate(f.context, { stop, run: ok, root: f.deps.root, startedAt: async () => null })).toMatchObject({ rolledBack: true, version: '1.20.0' });
    expect(await readJson(f.paths.paused)).toEqual(manual);
    // An earlier engine's pause records no kind, so a person may have written the updater's reason: it stays too.
    const legacy = { pausedAt: new Date().toISOString(), reason: 'Automatic Sentinel update to 1.20.1' };
    await atomicWriteJson(updateMarker(f.paths), fence);
    await atomicWriteJson(f.paths.paused, legacy);
    expect(await rollBackInterruptedUpdate(f.context, { stop, run: ok, root: f.deps.root, startedAt: async () => null })).toMatchObject({ rolledBack: true, version: '1.20.0' });
    expect(await readJson(f.paths.paused)).toEqual(legacy);
  });
  it('restores the recorded engine and policy, verifies its watcher, then removes the fence; the pause step lifts the update\'s pause', async () => {
    const f = await fixture();
    await atomicWriteJson(updateMarker(f.paths), { version: '1.20.1', pid: DEAD, startedAt: new Date().toISOString() });
    await atomicWriteJson(path.join(f.paths.root, 'update-recovery.json'), { nextVersion: '1.20.1', previousCli: 'old-cli',
      previousPolicy: { restored: true }, previousState: { activeVersion: '1.20.0' } });
    await atomicWriteJson(f.paths.paused, { pausedAt: new Date().toISOString(), reason: 'Automatic Sentinel update to 1.20.1', kind: 'update' });
    const stop = vi.fn(async () => true);
    const run = vi.fn(async (_node, args) => ({ stdout: args.includes('--version') ? '1.20.0'
      : args.includes('status') ? JSON.stringify({ watcherRunning: true, heartbeat: { gateVersion: '1.20.0' } }) : '' }));
    expect(await rollBackInterruptedUpdate(f.context, { stop, run, root: f.deps.root, startedAt: async () => null }))
      .toMatchObject({ rolledBack: true, version: '1.20.0', nextVersion: '1.20.1' });
    expect(stop).toHaveBeenCalledOnce();
    expect(await readJson(f.paths.policy)).toEqual({ restored: true });
    expect(await readJson(updateMarker(f.paths))).toBeNull();
    // The rollback removes no pause: only repair's pause step does, while it is the record it judged.
    expect(await readJson(f.paths.paused)).toMatchObject({ kind: 'update' });
    await f.healthy();
    expect((await repair(f)).steps[0]).toMatchObject({ state: 'pause', status: 'fixed' });
    expect(await readJson(f.paths.paused)).toBeNull();
  });
});
