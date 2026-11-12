import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './review-gate/process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Outside every repository: inside this checkout, the launcher resolved the
// source repository and ran the managed engine installed for it on this
// machine, so `--version` reported that engine instead of the package.
const scratch = await mkdtemp(path.join(os.tmpdir(), 'sentinel-package-smoke-'));
const run = (command, args, cwd = scratch, extra = {}) => runProcess(command, args, {
  cwd, timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024, ...extra,
});
const quotePowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;
const manager = (args, cwd = scratch) => process.platform === 'win32'
  ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& pnpm ${args.map(quotePowerShell).join(' ')}; exit $LASTEXITCODE`], cwd)
  : run('pnpm', args, cwd);
await writeFile(path.join(scratch, 'package.json'), '{"name":"sentinel-package-smoke","private":true,"type":"module"}\n');
await writeFile(path.join(scratch, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n");
await manager(['pack', '--pack-destination', scratch], root);
const archive = path.join(scratch, `${pkg.name}-${pkg.version}.tgz`);
await manager(['add', '--save-dev', '--ignore-scripts', archive]);
const cli = path.join(scratch, 'node_modules/rove-sentinel/scripts/review-gate/launcher.mjs');
assert.equal((await run(process.execPath, [cli, '--version'])).stdout.trim(), pkg.version);
assert.match((await run(process.execPath, [cli, '--help'])).stdout, /Rove Sentinel/);
await run('git', ['init', '-b', 'main']);
await run(process.execPath, [cli, 'init']);
assert.equal(JSON.parse((await run(process.execPath, [cli, 'update-check', '--no-update-check', '--json'])).stdout).status, 'disabled');
const hook = await readFile(path.join(scratch, '.githooks/pre-push'), 'utf8');
assert.match(hook, /sentinel\.mjs/);
assert.equal(JSON.parse((await run(process.execPath, [path.join(scratch, '.githooks/sentinel.mjs'), 'pre-push'], scratch, { input: '' })).stdout).reviewed, 0);
await writeFile(path.join(scratch, 'read-policy.mjs'), `import { readReviewPolicy } from './node_modules/rove-sentinel/scripts/review-gate/context.mjs';\nconsole.log(JSON.stringify(await readReviewPolicy(process.cwd())));\n`);
const policy = JSON.parse((await run(process.execPath, [path.join(scratch, 'read-policy.mjs')])).stdout);
assert.match(policy.charter, /Rove Sentinel review charter/);
assert.equal(policy.config.guiEvidence, 'none');
assert.equal(policy.config.clippy, false);

// A local installation (1.19.0): the package lives outside the repository it
// reviews, and Git's own pre-push hook calls its launcher by path. The hook
// written by the packaged module must reach the packaged launcher on a real
// push, and leave nothing in the repository's files.
const consumer = path.join(scratch, 'consumer');
const remote = path.join(scratch, 'consumer-remote.git');
await run('git', ['init', '-q', '--bare', remote]);
await run('git', ['init', '-q', '-b', 'main', consumer]);
const consumerGit = (args) => run('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.com', ...args], consumer);
await consumerGit(['commit', '-q', '--allow-empty', '-m', 'start']);
await consumerGit(['remote', 'add', 'origin', remote]);
await consumerGit(['push', '-q', 'origin', 'main', 'main:obsolete']);
await writeFile(path.join(scratch, 'write-local-hook.mjs'), `import { localLauncher, prepareLocalHook, writeLocalHook } from './node_modules/rove-sentinel/scripts/review-gate/local.mjs';
const [repoRoot, launcherPath] = process.argv.slice(2);
const launcher = await localLauncher(launcherPath, { repoRoot });
const hook = await prepareLocalHook({ repoRoot, launcher, hooksPath: '' });
await writeLocalHook(hook.hookPath, hook.hookText);
console.log(JSON.stringify(hook.hookPath));
`);
const localHook = JSON.parse((await run(process.execPath, [path.join(scratch, 'write-local-hook.mjs'), consumer, cli])).stdout);
assert.match(await readFile(localHook, 'utf8'), /launcher\.mjs' pre-push "\$@"/);
// A deletion needs no review, so the hook's launcher answers at once.
const pushed = await consumerGit(['push', 'origin', '--delete', 'obsolete']);
assert.match(`${pushed.stdout}${pushed.stderr}`, /"reviewed": 0/);
assert.equal((await consumerGit(['status', '--porcelain', '--untracked-files=all', '--ignored'])).stdout, '');
assert.match((await run(process.execPath, [cli, 'install', '--config', 'x.json', '--repo', consumer], scratch, { allowFailure: true })).stderr,
  /--config names a local installation/);

process.stdout.write(`Package smoke passed: ${pkg.name}@${pkg.version}. Evidence: ${scratch}\n`);
