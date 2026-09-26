import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.mjs';
import { atomicWriteJson, readJson, stateRootFor } from './storage.mjs';
import { RELEASE_REPOSITORY, releaseUrls, stableVersion } from './updates.mjs';

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

async function retainedVersions(root) {
  const keep = new Set();
  for (const folder of ['consumers', 'processes']) {
    const dir = path.join(root, folder);
    const entries = await readdir(dir).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      const file = path.join(dir, entry);
      const record = await readJson(file);
      if (!record) continue;
      if (folder === 'processes' && !processAlive(record.pid)) { await rm(file, { force: true }); continue; }
      for (const version of [record.version, record.activeVersion, record.previousVersion, record.pendingVersion]) {
        if (stableVersion(version)) keep.add(version);
      }
    }
  }
  return keep;
}

/** Shared per OS user; all repository watchers reuse the same verified immutable files. */
export async function ensureEngine(version, { root = engineRoot(), fetchImpl = globalThis.fetch,
  npm = runNpm, env = process.env, timeoutMs = 60_000, maxVersions = 5 } = {}) {
  const directory = engineDirectory(version, root);
  const ready = await readJson(path.join(directory, 'ready.json'));
  if (ready?.version === version && ready?.schemaVersion === 1 && existsSync(engineCli(version, root))) return directory;
  await mkdir(root, { recursive: true });
  const lockFile = path.join(root, 'download.lock');
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another or interrupted runtime download owns ${lockFile}; retry later or inspect its recorded PID.`);
    throw error;
  }
  const stage = path.join(root, 'staging');
  let createdStage = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, version }));
    await mkdir(path.join(root, 'versions'), { recursive: true });
    const versions = (await readdir(path.join(root, 'versions'))).filter(stableVersion);
    const retained = await retainedVersions(root);
    for (const previous of [...versions]) {
      if (versions.length < maxVersions) break;
      if (retained.has(previous)) continue;
      await rm(engineDirectory(previous, root), { recursive: true, force: true });
      versions.splice(versions.indexOf(previous), 1);
    }
    if (versions.length >= maxVersions) throw new Error('Runtime storage is full of versions retained by projects or running processes. Update or unregister inactive projects before retrying.');
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
    const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/(TOKEN|SECRET|KEY|PASSWORD|NODE_OPTIONS|NODE_PATH)/i.test(key)));
    // Local checksum-verified archive: npm never follows an unchecked release URL.
    await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--cache', path.join(stage, '.npm-cache'), archivePath],
      { cwd: stage, env: cleanEnv, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024 });
    const pkg = JSON.parse(await readFile(path.join(stage, 'node_modules/rove-sentinel/package.json'), 'utf8'));
    if (pkg.name !== 'rove-sentinel' || pkg.version !== version || pkg.sentinelEngineProtocol !== 1) {
      throw new Error('Downloaded package identity or engine protocol is unsupported.');
    }
    await stat(path.join(stage, 'node_modules/rove-sentinel/scripts/review-gate/cli.mjs'));
    await rm(path.join(stage, '.npm-cache'), { recursive: true, force: true });
    await rm(archivePath);
    await atomicWriteJson(path.join(stage, 'ready.json'), { schemaVersion: 1, version, sha256: digest, ...urls });
    await rename(stage, directory);
    return directory;
  } finally {
    await lock.close();
    // Only this lock owner created staging. A failed install leaves no selectable runtime.
    try { if (createdStage) await rm(stage, { recursive: true, force: true }); }
    finally { await rm(lockFile, { force: true }); }
  }
}
