// Explicit Windows acceptance: creates isolated local fixture repositories and scheduled tasks.
// Requires authenticated provider CLIs, but runs no paid reviews and publishes nothing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from './review-gate/process.mjs';
import { automaticUpdate } from './review-gate/automatic-updates.mjs';
import { createGateContext } from './review-gate/gate.mjs';
import { acquireReviewLease } from './review-gate/maintenance.mjs';
import { engineCli, engineRoot, runNpm } from './review-gate/engine-store.mjs';
import { readJson, atomicWriteJson } from './review-gate/storage.mjs';

if (process.platform !== 'win32') throw new Error('This live scheduler acceptance targets Windows.');
const source = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(source, 'output'), { recursive: true });
const scratch = await mkdtemp(path.join(source, 'output', 'rt-'));
const originalLocal = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = path.join(scratch, 'local');
const env = { ...process.env, ROVE_SENTINEL_UPDATE_NOTIFICATIONS: '0' };
const isolatedEnv = { ...env, ROVE_SENTINEL_AUTO_UPDATE: '0' };
const run = (command, args, cwd = scratch, options = {}) => runProcess(command, args, {
  cwd, env: isolatedEnv, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024, ...options,
});
const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
const current = pkg.version;
const parts = current.split('.').map(Number);
const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const bad = `${parts[0]}.${parts[1]}.${parts[2] + 2}`;
const archives = new Map();
async function build(version) {
  const dir = path.join(scratch, `build-${version}`);
  await mkdir(path.join(dir, 'scripts/review-gate'), { recursive: true });
  for (const file of await readdir(path.join(source, 'scripts/review-gate'))) {
    if (file.endsWith('.mjs')) await cp(path.join(source, 'scripts/review-gate', file), path.join(dir, 'scripts/review-gate', file));
  }
  await cp(path.join(source, 'templates'), path.join(dir, 'templates'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version }));
  const constants = path.join(dir, 'scripts/review-gate/constants.mjs');
  await writeFile(constants, (await readFile(constants, 'utf8')).replace(`GATE_VERSION = '${current}'`, `GATE_VERSION = '${version}'`));
  const charter = path.join(dir, 'templates/charter.md');
  await writeFile(charter, (await readFile(charter, 'utf8')).replace(`**Gate version:** ${current}`, `**Gate version:** ${version}`));
  await runNpm(['pack', '--ignore-scripts', '--pack-destination', scratch], { cwd: dir, env: isolatedEnv, timeoutMs: 120_000 });
  const archive = path.join(scratch, `rove-sentinel-${version}.tgz`);
  archives.set(version, await readFile(archive));
  return archive;
}
const baseArchive = await build(current);
await build(next);
await build(bad);
let downloads = 0;
const fetchImpl = async (url) => {
  downloads++;
  const version = url.match(/\/v(\d+\.\d+\.\d+)\//)?.[1];
  const archive = archives.get(version);
  assert(archive, `Unexpected fixture download ${url}`);
  return new Response(url.endsWith('SHA256SUMS')
    ? `${createHash('sha256').update(archive).digest('hex')}  rove-sentinel-${version}.tgz\n` : archive);
};
const { ensureEngine } = await import('./review-gate/engine-store.mjs');
const ensure = (version, options) => ensureEngine(version, { ...options, fetchImpl, env: isolatedEnv });
const fixtures = [];
let releaseReview;
const results = { current, next, sharedDownloads: 0, checks: [] };
try {
  for (const name of ['a', 'b']) {
    const repoRoot = path.join(scratch, name);
    await mkdir(repoRoot);
    await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ name: `sentinel-fixture-${name}`, private: true, type: 'module' }));
    await runNpm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', baseArchive], { cwd: repoRoot, env: isolatedEnv, timeoutMs: 120_000 });
    await run('git', ['init', '-b', 'main'], repoRoot);
    await writeFile(path.join(repoRoot, '.gitignore'), 'node_modules/\n');
    const cli = path.join(repoRoot, 'node_modules/rove-sentinel/scripts/review-gate/cli.mjs');
    const launcher = path.join(repoRoot, 'node_modules/rove-sentinel/scripts/review-gate/launcher.mjs');
    await run(process.execPath, [cli, 'init'], repoRoot);
    await writeFile(path.join(repoRoot, 'rules.md'), 'Fixture policy frozen at installation.\n');
    const config = JSON.parse(await readFile(path.join(repoRoot, '.rove-sentinel.json'), 'utf8'));
    config.charter = 'rules.md';
    await writeFile(path.join(repoRoot, '.rove-sentinel.json'), JSON.stringify(config));
    await run('git', ['add', '.'], repoRoot);
    await run('git', ['-c', 'user.name=Sentinel Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initialize synthetic consumer'], repoRoot);
    const context = await createGateContext(repoRoot);
    fixtures.push({ repoRoot, cli, launcher, context });
    await run(process.execPath, [cli, 'install'], repoRoot);
    await atomicWriteJson(path.join(context.paths.root, 'engine.json'), { schemaVersion: 1, lastAttempt: Date.now() });
    await atomicWriteJson(path.join(context.paths.root, 'update-settings.json'), { schemaVersion: 1, enabled: true });
    await writeFile(path.join(repoRoot, 'rules.md'), 'Unapproved working-tree policy; must never be installed by the updater.\n');
  }
  const [a, b] = fixtures;
  const options = { ensure, check: async () => ({ status: 'available', latestVersion: next }),
    notify: async () => {}, env: { ...env, ROVE_SENTINEL_AUTO_UPDATE: '1' }, version: current };
  releaseReview = await acquireReviewLease(a.context.paths);
  const waiting = await automaticUpdate({ repoRoot: a.repoRoot }, { ...options, cliPath: a.cli });
  assert.equal(waiting.status, 'waiting');
  const upgradedB = await automaticUpdate({ repoRoot: b.repoRoot }, { ...options, cliPath: b.cli });
  assert.equal(upgradedB.status, 'updated', JSON.stringify(upgradedB));
  assert.equal(downloads, 2, 'Two projects must reuse one checksum/archive download.');
  results.sharedDownloads = downloads;
  results.checks.push('busy project waits while second project activates the shared runtime');
  await releaseReview(); releaseReview = null;
  const upgradedA = await automaticUpdate({ repoRoot: a.repoRoot }, { ...options, cliPath: a.cli });
  assert.equal(upgradedA.status, 'updated', JSON.stringify(upgradedA));
  for (const fixture of fixtures) {
    assert.equal((await run(process.execPath, [fixture.launcher, '--version'], fixture.repoRoot)).stdout.trim(), next);
    assert.equal((await readJson(fixture.context.paths.policy)).charter, 'Fixture policy frozen at installation.\n');
    assert.equal((await run('git', ['diff', '--name-only', '--', 'package.json', 'package-lock.json'], fixture.repoRoot)).stdout.trim(), '');
  }
  results.checks.push('existing pinned launchers select the new runtime without editing project dependencies');
  results.checks.push('unapproved working-tree policy is excluded from automatic activation');
  const nextInstall = await import(pathToFileURL(path.join(engineRoot(), 'versions', next, 'node_modules/rove-sentinel/scripts/review-gate/install.mjs')).href);
  const rollback = await automaticUpdate({ repoRoot: a.repoRoot }, { ...options, version: next, cliPath: engineCli(next),
    status: nextInstall.gateStatus, check: async () => ({ status: 'available', latestVersion: bad }),
    run: async (command, args, runOptions) => {
      if (args[0] === engineCli(bad) && args.includes('install')) throw new Error('Injected replacement startup failure');
      return runProcess(command, args, runOptions);
    },
  });
  assert.equal(rollback.status, 'failed', JSON.stringify(rollback));
  const restored = await nextInstall.gateStatus({ repoRoot: a.repoRoot });
  assert.equal(restored.watcherHealthy, true);
  assert.equal(restored.heartbeat.gateVersion, next);
  results.checks.push('real scheduler restores previous healthy watcher after injected replacement failure');
  await writeFile(path.join(scratch, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Live runtime acceptance passed. Evidence: ${scratch}`);
} finally {
  await releaseReview?.();
  const failures = [];
  for (const fixture of fixtures.reverse()) {
    try { await run(process.execPath, [fixture.launcher, 'uninstall'], fixture.repoRoot); }
    catch (error) { failures.push(`${fixture.repoRoot}: ${error.message}`); }
  }
  if (originalLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = originalLocal;
  if (failures.length) throw new Error(`Fixture cleanup incomplete: ${failures.join(' | ')}`);
}
