import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineCli, engineDirectory, makeStoreRoom, publishEngineState, repairEngine } from '../engine-store.mjs';
import { repairRepository } from '../repair.mjs';
import { REPAIR_BOOTSTRAP } from '../process.mjs';
import { atomicWriteJson, ensureState } from '../storage.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { GATE_VERSION } from '../constants.mjs';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'sentinel-reach-test-')); dirs.push(dir); return dir; }

async function readyCopy(root: string, version: string) {
  const directory = engineDirectory(version, root);
  await mkdir(path.dirname(engineCli(version, root)), { recursive: true });
  await writeFile(engineCli(version, root), '');
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ schemaVersion: 1, version }));
}

describe('which engine a repair runs on', () => {
  it('takes the newest of the launcher\'s own, the active one and every ready store copy, never one older than the active', async () => {
    const base = await temp();
    const root = path.join(base, 'engines');
    const paths = await ensureState(path.join(base, 'state'));
    // The launcher is newer than the active engine, which predates repair.
    await readyCopy(root, '1.18.0');
    await publishEngineState(paths, { activeVersion: '1.18.0' }, root);
    expect(await repairEngine(paths, 'bundled-cli', '1.20.1', root)).toBe('bundled-cli');
    // A ready store copy newer than both wins.
    await readyCopy(root, '1.21.0');
    expect(await repairEngine(paths, 'bundled-cli', '1.20.1', root)).toBe(engineCli('1.21.0', root));
    // A copy without its ready record is not a candidate.
    await mkdir(engineDirectory('1.22.0', root), { recursive: true });
    expect(await repairEngine(paths, 'bundled-cli', '1.20.1', root)).toBe(engineCli('1.21.0', root));
    // An older launcher never runs a repair for a newer active engine.
    await publishEngineState(paths, { activeVersion: '1.21.0' }, root);
    expect(await repairEngine(paths, 'bundled-cli', '1.20.1', root)).toBe(engineCli('1.21.0', root));
    await rm(engineDirectory('1.21.0', root), { recursive: true });
    await expect(repairEngine(paths, 'bundled-cli', '1.20.1', root)).rejects.toThrow('No copy of the active engine 1.21.0');
  });
  it('frees one slot of a full store for an older engine\'s download, keeping what projects need', async () => {
    const base = await temp();
    const root = path.join(base, 'engines');
    for (const version of ['1.15.0', '1.16.0', '1.17.0', '1.18.0', '1.19.0']) await readyCopy(root, version);
    const repo = path.join(base, 'checkout');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const paths = await ensureState(path.join(base, 'state'));
    await publishEngineState(paths, { repoRoot: repo, activeVersion: '1.18.0', previousVersion: '1.15.0', pendingVersion: '1.19.0' }, root);
    // What nothing keeps goes first, oldest first; the rollback copy only after.
    expect(await makeStoreRoom(root)).toEqual({ removed: ['1.16.0'] });
    expect((await readdir(path.join(root, 'versions'))).sort()).toEqual(['1.15.0', '1.17.0', '1.18.0', '1.19.0']);
    expect(await makeStoreRoom(root)).toEqual({ removed: [] });
    // A full store whose missing release has become ready since gives nothing.
    await readyCopy(root, '1.20.0');
    expect(await makeStoreRoom(root, { unlessReady: '1.20.0' })).toEqual({ removed: [] });
    expect((await readdir(path.join(root, 'versions'))).length).toBe(5);
  });
});

describe('the watcher a repair on a newer engine judges', () => {
  it('is judged by its engine version only, not by a policy snapshot only its own engine can read', async () => {
    const { watcherHolds } = await import('../automatic-updates.mjs');
    const base = await temp();
    const paths = await ensureState(path.join(base, 'state'));
    // A snapshot an older engine wrote, which this engine cannot check.
    await atomicWriteJson(paths.policy, { gateVersion: '1.18.0', charter: 'x', lessons: 'y', config: {}, policyDigest: 'older' });
    await atomicWriteJson(paths.lock, { ownerToken: 'owner-token', pid: process.pid });
    await atomicWriteJson(paths.heartbeat, { ownerToken: 'owner-token', pid: process.pid, at: new Date().toISOString(), gateVersion: '1.18.0', policyDigest: 'older' });
    expect(await watcherHolds(paths, { gateVersion: '1.18.0', startedAt: async () => null })).toEqual([]);
    expect((await watcherHolds(paths, { gateVersion: '1.19.0', startedAt: async () => null })).map((hold) => hold.kind)).toEqual(['outdated']);
  });
});

describe('a repair on a newer engine than the repository selects', () => {
  it('judges the watcher against the selected engine and updates through the repository\'s own command', async () => {
    const base = await temp();
    const paths = await ensureState(path.join(base, 'state'));
    const repoRoot = path.join(base, 'checkout');
    await mkdir(path.join(repoRoot, '.git'), { recursive: true });
    const context = { repoRoot, stateRoot: paths.root, paths };
    const policy = reviewPolicySnapshot({ charter: 'Charter', lessons: 'Lessons', config: {} });
    await atomicWriteJson(paths.policy, policy);
    await atomicWriteJson(paths.lock, { ownerToken: 'owner-token', pid: process.pid, startedAt: new Date().toISOString() });
    await atomicWriteJson(paths.heartbeat, { ownerToken: 'owner-token', pid: process.pid, at: new Date().toISOString(), repoRoot,
      gateVersion: '1.18.0', charterVersion: '1.0.0', policyDigest: 'computed-by-1.18.0', activity: 'idle' });
    const sentinel = vi.fn(async (_repo, args) => ({ stdout: args[0] === 'update' ? JSON.stringify({ status: 'updated', version: GATE_VERSION }) : '' }));
    const reinstall = vi.fn();
    const report = await repairRepository({ repoRoot }, {
      contextFor: async () => context, root: path.join(base, 'engines'), platform: 'win32', list: async () => [], waitMs: 0,
      selectedVersionOf: async () => '1.18.0', sentinel, reinstall, startedAt: async () => null,
      info: async () => ({ automatic: true, phase: 'download-failed', blockedBy: [] }),
    });
    // The watcher runs the selected 1.18.0: not outdated, and not reinstalled on this engine.
    expect(report.steps.map((entry) => entry.state)).toEqual(['update']);
    expect(reinstall).not.toHaveBeenCalled();
    expect(sentinel).toHaveBeenCalledWith(repoRoot, ['update']);
    expect(report.steps[0]).toMatchObject({ status: 'fixed' });
  });
});

describe('the way to repair from an engine before 1.20.1 is written down', () => {
  it('the runbook carries the exact bootstrap lines, and the agent instructions point to them', async () => {
    const { readFile } = await import('node:fs/promises');
    const runbook = await readFile('docs/troubleshooting.md', 'utf8');
    expect(runbook).toContain(REPAIR_BOOTSTRAP.windows);
    expect(runbook).toContain(REPAIR_BOOTSTRAP.macos);
    expect(runbook).toContain('### Repair on an engine before 1.20.1');
    const guide = await readFile('docs/multiple-projects.md', 'utf8');
    expect(guide).toContain('docs/troubleshooting.md#repair-on-an-engine-before-1201');
  });
  it('updates and status name it beside every hold', async () => {
    const { updateInformation } = await import('../automatic-updates.mjs');
    const base = await temp();
    const paths = await ensureState(path.join(base, 'state'));
    await publishEngineState(paths, { phase: 'waiting', pendingVersion: '99.0.0' }, path.join(base, 'engines'));
    const information = await updateInformation(paths, { holds: async () => [{ kind: 'stopped', since: null, reason: 'no watcher is running', action: 'x' }] });
    expect(information.repair).toEqual({ command: 'npx --no-install rove-sentinel repair', ifUnknownCommand: REPAIR_BOOTSTRAP });
  });
});

describe.runIf(process.platform === 'win32')('the bootstrap for an engine before 1.20.1', () => {
  // The published one-liner, pointed at a local server, with its last command
  // replaced: the verification is what is tested, not the repair it then runs.
  it('refuses an archive whose SHA-256 does not match, and runs one that does', async () => {
    const bad = await serveAsync(() => `${'0'.repeat(64)}  rove-sentinel-1.20.1.tgz\n`);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain('Checksum mismatch');
    expect(bad.stdout).not.toContain('VERIFIED');
    const ok = await serveAsync((digest) => `${digest}  rove-sentinel-1.20.1.tgz\n`);
    expect(ok.stdout).toContain('VERIFIED');
  }, 120_000);

  // The server answers while PowerShell runs, so PowerShell is spawned, not run synchronously.
  async function serveAsync(sums: (digest: string) => string) {
    const archive = Buffer.from('synthetic release archive');
    const digest = createHash('sha256').update(archive).digest('hex');
    const server = createServer((request, response) => {
      if (request.url?.endsWith('/rove-sentinel-1.20.1.tgz')) response.end(archive);
      else if (request.url?.endsWith('/SHA256SUMS')) response.end(sums(digest));
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const { port } = server.address() as { port: number };
    const command = REPAIR_BOOTSTRAP.windows
      .replace('https://github.com/jayyanez/rove-sentinel/releases/download', `http://localhost:${port}`)
      .replace(/npx --yes --package \$f -- rove-sentinel repair$/, "Write-Output 'VERIFIED'");
    const temporary = await temp();
    try {
      return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
          { env: { ...process.env, TEMP: temporary }, windowsHide: true });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    } finally { server.close(); }
  }
});
