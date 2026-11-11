import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeInstallTransaction, gateStatus } from '../install.mjs';
import {
  defaultHookPath,
  localHookLauncher,
  localHookPresent,
  localHookText,
  localLauncher,
  prepareLocalHook,
  readInstallation,
  removeInstallation,
  removeLocalHook,
  writeInstallation,
} from '../local.mjs';
import { readReviewPolicy, reviewPolicySnapshot } from '../context.mjs';
import { atomicWriteJson, ensureState, readJson } from '../storage.mjs';
import { initializeRepository } from '../init.mjs';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function repository(root: string) {
  const repoRoot = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  git(repoRoot, '-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-q', '--allow-empty', '-m', 'start');
  return repoRoot;
}

/** A Sentinel installed outside the repository: a launcher that records how the hook called it. */
async function outsideLauncher(root: string, folder = 'tools') {
  const directory = path.join(root, folder, 'rove-sentinel', 'scripts', 'review-gate');
  await mkdir(directory, { recursive: true });
  const launcher = path.join(directory, 'launcher.mjs');
  await writeFile(launcher, `import { writeFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(path.join(root, 'hook-call.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input }));
`);
  return launcher;
}

describe('the local pre-push hook', () => {
  it('calls the launcher by its path, and is recognized whatever the path holds', () => {
    for (const launcher of [
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\rove-sentinel\\scripts\\review-gate\\launcher.mjs',
      '/Users/me/.npm-global/lib/node_modules/rove-sentinel/scripts/review-gate/launcher.mjs',
      "/Users/me/it's here/launcher.mjs",
      '/Users/me/$HOME `x` "quoted"/launcher.mjs',
    ]) {
      const text = localHookText(launcher);
      expect(text.startsWith('#!/bin/sh\n')).toBe(true);
      expect(localHookLauncher(text)).toBe(launcher.replaceAll('\\', '/'));
      expect(localHookLauncher(text.replaceAll('\n', '\r\n'))).toBe(launcher.replaceAll('\\', '/'));
    }
  });

  it('refuses a launcher path a hook line cannot carry', () => {
    expect(() => localHookText('/Users/me/a\nb/launcher.mjs')).toThrow('cannot be written into a hook');
  });

  it('does not take the project hook, an edited hook or another hook for its own', () => {
    const ours = localHookText('/Users/me/tools/launcher.mjs');
    expect(localHookLauncher('#!/bin/sh\nset -eu\nroot=$(git rev-parse --show-toplevel)\nexec node "$root/.githooks/sentinel.mjs" pre-push "$@"\n')).toBeNull();
    expect(localHookLauncher(`${ours}make lint\n`)).toBeNull();
    expect(localHookLauncher(ours.replace('pre-push "$@"', 'pre-push "$@"; make lint'))).toBeNull();
    expect(localHookLauncher('#!/bin/sh\nmake lint\n')).toBeNull();
  });

  it('is run by Git on a push, with the remote, the ref updates and the checkout', async () => {
    const root = await temporary('rove-local-hook-run-');
    const repoRoot = await repository(root);
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(repoRoot, 'remote', 'add', 'origin', remote);
    const launcher = await outsideLauncher(root);
    const prepared = await prepareLocalHook({ repoRoot, launcher, hooksPath: '' });
    await writeFile(prepared.hookPath, prepared.hookText, { mode: 0o755 });

    git(repoRoot, 'push', '-q', 'origin', 'main');

    const call = JSON.parse(await readFile(path.join(root, 'hook-call.json'), 'utf8'));
    expect(call.args).toEqual(['pre-push', 'origin', remote]);
    expect(path.resolve(call.cwd).toLowerCase()).toBe(path.resolve(repoRoot).toLowerCase());
    expect(call.input).toContain('refs/heads/main');
    // Nothing of it is in the repository's files.
    expect(git(repoRoot, 'status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('');
  });

  it('goes in Git\'s own hooks folder, which every worktree of the repository shares', async () => {
    const root = await temporary('rove-local-hook-worktree-');
    const repoRoot = await repository(root);
    const worktree = path.join(root, 'linked');
    git(repoRoot, 'worktree', 'add', '-q', '--detach', worktree);
    const main = await defaultHookPath(repoRoot);
    expect(path.relative(path.join(repoRoot, '.git'), main)).toBe(path.join('hooks', 'pre-push'));
    expect(realpathSync.native(await defaultHookPath(worktree).then(path.dirname)).toLowerCase())
      .toBe(realpathSync.native(path.dirname(main)).toLowerCase());
  });
});

describe('preparing a local installation', () => {
  it('refuses while core.hooksPath would keep Git from running it, and says what to do', async () => {
    const root = await temporary('rove-local-prepare-');
    const repoRoot = await repository(root);
    const launcher = await outsideLauncher(root);
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '.githooks' }))
      .rejects.toThrow(/uninstall.*git config --unset core\.hooksPath/);
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '.husky' }))
      .rejects.toThrow(/core\.hooksPath=\.husky is set.*was preserved/);
  });

  it('preserves another pre-push hook, and replaces only its own', async () => {
    const root = await temporary('rove-local-prepare-');
    const repoRoot = await repository(root);
    const launcher = await outsideLauncher(root);
    const hookPath = await defaultHookPath(repoRoot);
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, '#!/bin/sh\nmake lint\n');
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '' })).rejects.toThrow('was preserved');
    expect(await readFile(hookPath, 'utf8')).toBe('#!/bin/sh\nmake lint\n');

    const earlier = localHookText('/Users/me/old/launcher.mjs');
    await writeFile(hookPath, earlier);
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '' }))
      .resolves.toMatchObject({ hookPath, previous: earlier, hookText: localHookText(launcher) });
  });

  it('runs only a Sentinel installed outside the reviewed repository and outside the managed engines', async () => {
    const root = await temporary('rove-local-launcher-');
    const repoRoot = await repository(root);
    const outside = await outsideLauncher(root);
    await expect(localLauncher(outside, { repoRoot, engineStore: path.join(root, 'engines') })).resolves.toBe(realpathSync.native(outside));

    const inside = await outsideLauncher(repoRoot, 'node_modules');
    await expect(localLauncher(inside, { repoRoot })).rejects.toThrow('a branch could change its own reviewer');
    const differentCase = process.platform === 'win32' ? inside.toUpperCase() : inside;
    await expect(localLauncher(differentCase, { repoRoot })).rejects.toThrow('inside');

    const engine = await outsideLauncher(path.join(root, 'engines', 'versions', '9.9.9'));
    await expect(localLauncher(engine, { repoRoot, engineStore: path.join(root, 'engines') })).rejects.toThrow('managed engine');

    await writeFile(path.join(root, 'other.mjs'), '');
    await expect(localLauncher(path.join(root, 'other.mjs'), { repoRoot })).rejects.toThrow('is not one');
    await expect(localLauncher(undefined, { repoRoot })).rejects.toThrow('install --local');
  });
});

describe('a local installation\'s policy', () => {
  it('reads a configuration file outside the repository, with its charter and lessons beside it', async () => {
    const root = await temporary('rove-local-policy-');
    const repoRoot = await repository(root);
    await writeFile(path.join(repoRoot, '.rove-sentinel.json'), '{ "providers": "codex" }');
    const settings = path.join(root, 'settings');
    await mkdir(settings);
    await writeFile(path.join(settings, 'sentinel.json'), '{ "providers": "claude", "lessons": "lessons.md" }');
    await writeFile(path.join(settings, 'lessons.md'), '# Lessons kept outside\n');

    const policy = await readReviewPolicy(repoRoot, { configFile: path.join(settings, 'sentinel.json') });
    expect(policy.config.providers).toBe('claude');
    expect(policy.lessons).toBe('# Lessons kept outside\n');
    expect(policy.charter).toMatch(/Rove Sentinel review charter/);
  });

  it('never reads the repository\'s configuration, and never takes a missing file for the defaults', async () => {
    const root = await temporary('rove-local-policy-');
    const repoRoot = await repository(root);
    await writeFile(path.join(repoRoot, '.rove-sentinel.json'), '{ "providers": "codex" }');
    const defaults = await readReviewPolicy(repoRoot, { defaults: true });
    expect(defaults.config.providers).toBeUndefined();
    expect(defaults.lessons).toBe('No project lessons configured.');
    await expect(readReviewPolicy(repoRoot, { configFile: path.join(root, 'missing.json') }))
      .rejects.toThrow(/missing\.json.*ENOENT/s);
  });
});

describe('the installation record', () => {
  it('reads what install wrote, and refuses anything else', async () => {
    const root = await temporary('rove-local-record-');
    const paths = await ensureState(root);
    await expect(readInstallation(paths)).resolves.toBeNull();
    await writeInstallation(paths, { mode: 'local', hook: '/repo/.git/hooks/pre-push', launcher: '/tools/launcher.mjs', config: null });
    await expect(readInstallation(paths)).resolves.toMatchObject({ schemaVersion: 1, mode: 'local', config: null });
    await atomicWriteJson(paths.installation, { schemaVersion: 1, mode: 'local' });
    await expect(readInstallation(paths)).rejects.toThrow('not one Sentinel wrote');
    await removeInstallation(paths);
    await expect(readInstallation(paths)).resolves.toBeNull();
  });
});

describe('installing and uninstalling locally', () => {
  async function fixture() {
    const root = await temporary('rove-local-install-');
    const repoRoot = await repository(root);
    const stateRoot = path.join(root, 'state');
    const paths = await ensureState(stateRoot);
    const launcher = await outsideLauncher(root);
    const localHook = await prepareLocalHook({ repoRoot, launcher, hooksPath: '' });
    const installation = { mode: 'local', hook: localHook.hookPath, launcher, config: null };
    const install = (startDetached: () => Promise<void>, overrides = {}) => executeInstallTransaction({
      context: { repoRoot, stateRoot, paths },
      plan: { platform: 'linux', unsupportedScheduler: true },
      policy: reviewPolicySnapshot({ charter: '# Rules', lessons: '# Lessons' }),
      currentHooks: '',
      start: true,
      github: false,
      installation,
      localHook,
      ...overrides,
    }, {
      git: vi.fn(async () => { throw new Error('a local installation runs no git config'); }),
      startDetached: vi.fn(startDetached),
      stop: vi.fn(async () => {}),
      waitHeartbeat: vi.fn(async () => ({ gateVersion: 'new' })),
    });
    return { root, repoRoot, paths, launcher, localHook, installation, install };
  }

  it('writes the hook and its record, and leaves core.hooksPath and the repository\'s files alone', async () => {
    const { repoRoot, paths, localHook, installation, install } = await fixture();
    await install(async () => {});
    expect(localHookLauncher(await readFile(localHook.hookPath, 'utf8'))).toBe(installation.launcher.replaceAll('\\', '/'));
    await expect(readInstallation(paths)).resolves.toMatchObject(installation);
    expect(await readJson(paths.watcherOptions)).toEqual({ github: false });
    expect(() => git(repoRoot, 'config', '--get', 'core.hooksPath')).toThrow();
    expect(git(repoRoot, 'status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('');
  });

  it('takes the hook and the record back when the watcher does not start', async () => {
    const { paths, localHook, install } = await fixture();
    await expect(install(async () => { throw new Error('spawn denied'); })).rejects.toThrow('spawn denied');
    await expect(access(localHook.hookPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readInstallation(paths)).resolves.toBeNull();
  });

  it('puts back its earlier hook when a reinstall fails', async () => {
    const { paths, localHook, install } = await fixture();
    const earlier = localHookText('/Users/me/old/launcher.mjs');
    await writeFile(localHook.hookPath, earlier);
    await writeInstallation(paths, { mode: 'local', hook: localHook.hookPath, launcher: '/Users/me/old/launcher.mjs', config: null });
    await expect(install(async () => { throw new Error('spawn denied'); }, { localHook: { ...localHook, previous: earlier } }))
      .rejects.toThrow('spawn denied');
    expect(await readFile(localHook.hookPath, 'utf8')).toBe(earlier);
    await expect(readInstallation(paths)).resolves.toMatchObject({ launcher: '/Users/me/old/launcher.mjs' });
  });

  it('records a project installation as one, and still configures its hooks path', async () => {
    const root = await temporary('rove-local-install-');
    const paths = await ensureState(path.join(root, 'state'));
    const gitCalls = vi.fn(async () => '');
    await executeInstallTransaction({
      context: { repoRoot: root, stateRoot: path.join(root, 'state'), paths },
      plan: { platform: 'linux', unsupportedScheduler: true },
      policy: { gateVersion: 'new' },
      currentHooks: '',
      start: true,
    }, {
      git: gitCalls,
      startDetached: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      waitHeartbeat: vi.fn(async () => ({ gateVersion: 'new' })),
    });
    expect(gitCalls.mock.calls.map((call) => call[1])).toEqual([['config', 'core.hooksPath', '.githooks']]);
    await expect(readInstallation(paths)).resolves.toEqual({ schemaVersion: 1, mode: 'project' });
  });

  it('removes only the hook it wrote', async () => {
    const { localHook, install } = await fixture();
    await install(async () => {});
    await expect(removeLocalHook(localHook.hookPath)).resolves.toBe('removed-local-hook');
    await expect(removeLocalHook(localHook.hookPath)).resolves.toBe('absent');
    await writeFile(localHook.hookPath, `${localHook.hookText}make lint\n`);
    await expect(removeLocalHook(localHook.hookPath)).resolves.toBe('manual');
    expect(await readFile(localHook.hookPath, 'utf8')).toContain('make lint');
  });

  it('is what status reports, and counts as installed while its hook is there', async () => {
    const { repoRoot, paths, localHook, install } = await fixture();
    await install(async () => {});
    const status = () => gateStatus({ repoRoot }, {
      createContext: async () => ({ repoRoot, stateRoot: paths.root, paths }),
      getHooksPath: async () => '',
      run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }),
      loadUserAccounts: async () => null,
    });
    const installed = await status();
    expect(installed.installation).toMatchObject({ mode: 'local', hook: localHook.hookPath, config: null });
    expect(installed.hookInstalled).toBe(true);
    expect(installed.watcher.state).toBe('stopped');
    await rm(localHook.hookPath);
    await expect(localHookPresent(localHook.hookPath)).resolves.toBe(false);
    const removed = await status();
    expect(removed.hookInstalled).toBe(false);
  });

  it('is never mistaken for the project hook by a project installation\'s files', async () => {
    const root = await temporary('rove-local-install-');
    const repoRoot = await repository(root);
    await initializeRepository(repoRoot);
    // The generated project hook is not a local one.
    expect(localHookLauncher(await readFile(path.join(repoRoot, '.githooks/pre-push'), 'utf8'))).toBeNull();
  });
});
