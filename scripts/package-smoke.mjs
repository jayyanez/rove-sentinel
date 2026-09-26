import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './review-gate/process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const { mkdir } = await import('node:fs/promises');
await mkdir(path.join(root, 'output'), { recursive: true });
const scratch = await mkdtemp(path.join(root, 'output/package-smoke-'));
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
process.stdout.write(`Package smoke passed: ${pkg.name}@${pkg.version}. Evidence: ${scratch}\n`);
