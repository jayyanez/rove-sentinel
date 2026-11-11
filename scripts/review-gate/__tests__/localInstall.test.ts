import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertSameClone, executeInstallTransaction, gateStatus } from '../install.mjs';
import {
  assertPolicyOutside,
  defaultHookPath,
  localHookLauncher,
  localHookPresent,
  localHookText,
  localLauncher,
  localNode,
  prepareLocalHook,
  readInstallation,
  removeInstallation,
  removeLocalHook,
  repositoryRoots,
  restoreLocalHook,
  takeOwnHook,
  writeInstallation,
  writeLocalHook,
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
    await writeInstallation(paths, { mode: 'local', hook: '/repo/.git/hooks/pre-push', launcher: '/tools/launcher.mjs', node: process.execPath, config: null });
    await expect(readInstallation(paths)).resolves.toMatchObject({ schemaVersion: 1, mode: 'local', node: process.execPath, config: null });
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
    const installation = { mode: 'local', hook: localHook.hookPath, launcher, node: process.execPath, config: null };
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
    await writeInstallation(paths, { mode: 'local', hook: localHook.hookPath, launcher: '/Users/me/old/launcher.mjs', node: process.execPath, config: null });
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
    await expect(removeLocalHook(localHook.hookPath, localHook.hookText)).resolves.toBe('removed-local-hook');
    await expect(removeLocalHook(localHook.hookPath, localHook.hookText)).resolves.toBe('absent');
    await writeFile(localHook.hookPath, `${localHook.hookText}make lint\n`);
    await expect(removeLocalHook(localHook.hookPath, localHook.hookText)).resolves.toBe('manual');
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
    expect(installed.installation).toMatchObject({ mode: 'local', hook: localHook.hookPath, node: process.execPath, config: null });
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

describe('what a branch cannot reach (gate review of 78b9f7b)', () => {
  it('counts every worktree of the clone, and its Git directory, as the repository', async () => {
    const root = await temporary('rove-local-roots-');
    const repoRoot = await repository(root);
    const linked = path.join(root, 'linked');
    git(repoRoot, 'worktree', 'add', '-q', '--detach', linked);
    const roots = (await repositoryRoots(linked)).map((entry) => realpathSync.native(entry).toLowerCase());
    for (const expected of [repoRoot, linked, path.join(repoRoot, '.git')]) {
      expect(roots).toContain(realpathSync.native(expected).toLowerCase());
    }
  });

  it('refuses a launcher in another worktree of the clone, which runs the same hook', async () => {
    const root = await temporary('rove-local-roots-');
    const repoRoot = await repository(root);
    const linked = path.join(root, 'linked');
    git(repoRoot, 'worktree', 'add', '-q', '--detach', linked);
    const inLinked = await outsideLauncher(linked, 'node_modules');
    await expect(localLauncher(inLinked, { roots: await repositoryRoots(repoRoot) })).rejects.toThrow('a branch could change its own reviewer');
  });

  it('refuses a configuration file, or a charter or lessons it names, inside the repository', async () => {
    const root = await temporary('rove-local-policy-outside-');
    const repoRoot = await repository(root);
    const linked = path.join(root, 'linked');
    git(repoRoot, 'worktree', 'add', '-q', '--detach', linked);
    const roots = await repositoryRoots(repoRoot);
    const outside = path.join(root, 'settings', 'sentinel.json');
    expect(() => assertPolicyOutside({ configFile: path.join(repoRoot, 'sentinel.json'), config: {}, roots })).toThrow('could write the policy');
    expect(() => assertPolicyOutside({ configFile: path.join(linked, 'sentinel.json'), config: {}, roots })).toThrow('could write the policy');
    expect(() => assertPolicyOutside({ configFile: path.join(repoRoot, '.git', 'sentinel.json'), config: {}, roots })).toThrow('could write the policy');
    expect(() => assertPolicyOutside({ configFile: outside, config: { lessons: 'lessons.md' }, roots })).not.toThrow();
    expect(() => assertPolicyOutside({ configFile: null, config: {}, roots })).not.toThrow();
  });

  it('says plainly that a local installation cannot share the hook, instead of offering a call that would not install', async () => {
    const root = await temporary('rove-local-prepare-');
    const repoRoot = await repository(root);
    const launcher = await outsideLauncher(root);
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '.husky' })).rejects.toThrow(/cannot share the pre-push hook/);
    const hookPath = await defaultHookPath(repoRoot);
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, '#!/bin/sh\nmake lint\n');
    const refusal = await prepareLocalHook({ repoRoot, launcher, hooksPath: '' }).catch((error) => error.message);
    expect(refusal).toContain('cannot share the pre-push hook');
    expect(refusal).not.toContain('Add a call');
  });
});

describe('another clone of the same remote (gate review of 78b9f7b)', () => {
  async function twoClones() {
    const root = await temporary('rove-local-clones-');
    const first = await repository(root);
    const second = path.join(root, 'second');
    execFileSync('git', ['clone', '-q', first, second]);
    const firstHook = await defaultHookPath(first);
    await mkdir(path.dirname(firstHook), { recursive: true });
    // Executable, as the installer writes it: outside Windows, status counts only a hook Git runs.
    await writeFile(firstHook, localHookText('/Users/me/tools/launcher.mjs'), { mode: 0o755 });
    const installation = { mode: 'local', hook: firstHook, launcher: '/Users/me/tools/launcher.mjs', node: process.execPath, config: null };
    return { root, first, second, firstHook, installation };
  }

  it('may not replace or remove a local installation while the other clone\'s hook is there', async () => {
    const { second, firstHook, installation } = await twoClones();
    await expect(assertSameClone(installation, await defaultHookPath(second))).rejects.toThrow('from another clone');
    await expect(assertSameClone(installation, firstHook)).resolves.toBeUndefined();
    // A clone that was deleted no longer holds the installation.
    await rm(firstHook);
    await expect(assertSameClone(installation, await defaultHookPath(second))).resolves.toBeUndefined();
  });

  it('is not reported as this clone\'s hook in status', async () => {
    const { root, first, second, installation } = await twoClones();
    const paths = await ensureState(path.join(root, 'state'));
    await writeInstallation(paths, installation);
    const status = (repoRoot: string) => gateStatus({ repoRoot }, {
      createContext: async () => ({ repoRoot, stateRoot: paths.root, paths }),
      getHooksPath: async () => '',
      run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }),
      loadUserAccounts: async () => null,
    });
    expect(await status(first)).toMatchObject({ hookInstalled: true, installation: { thisClone: true } });
    expect(await status(second)).toMatchObject({ hookInstalled: false, installation: { thisClone: false } });
  });
});

describe('a hook written or removed meanwhile is never lost (gate review of 78b9f7b)', () => {
  async function hookFixture() {
    const root = await temporary('rove-local-race-');
    const repoRoot = await repository(root);
    const hookPath = await defaultHookPath(repoRoot);
    await mkdir(path.dirname(hookPath), { recursive: true });
    return { hookPath };
  }
  const ours = localHookText('/Users/me/tools/launcher.mjs');
  const theirs = '#!/bin/sh\nmake lint\n';

  it('does not overwrite a hook that appeared after the installation looked', async () => {
    const { hookPath } = await hookFixture();
    await writeFile(hookPath, theirs);
    await expect(writeLocalHook(hookPath, ours, null)).rejects.toThrow(/appeared at .* during the installation/);
    expect(await readFile(hookPath, 'utf8')).toBe(theirs);
  });

  it('does not replace a hook that changed after the installation looked', async () => {
    const { hookPath } = await hookFixture();
    await writeFile(hookPath, theirs);
    await expect(writeLocalHook(hookPath, ours, localHookText('/Users/me/old/launcher.mjs'))).rejects.toThrow('changed during the installation');
    expect(await readFile(hookPath, 'utf8')).toBe(theirs);
  });

  it('leaves a hook changed after the attempted write when rolling back', async () => {
    const { hookPath } = await hookFixture();
    await writeFile(hookPath, theirs);
    await restoreLocalHook(hookPath, ours, null);
    expect(await readFile(hookPath, 'utf8')).toBe(theirs);
    await writeFile(hookPath, ours);
    await restoreLocalHook(hookPath, ours, null);
    await expect(access(hookPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('puts a foreign hook back, and keeps it beside one written in the meantime', async () => {
    const { hookPath } = await hookFixture();
    await writeFile(hookPath, theirs);
    await expect(takeOwnHook(hookPath)).resolves.toEqual({ state: 'foreign' });
    expect(await readFile(hookPath, 'utf8')).toBe(theirs);
    // Another hook is written between the move and the check.
    const raced = await takeOwnHook(hookPath, (text) => {
      writeFileSync(hookPath, 'newer');
      return localHookLauncher(text) !== null;
    });
    expect(raced.state).toBe('foreign');
    expect(await readFile(hookPath, 'utf8')).toBe('newer');
    expect(await readFile(raced.kept as string, 'utf8')).toBe(theirs);
  });
});

describe('the gate review of e6fe65a', () => {
  it('puts the earlier hook back when the replacement could not be created', async () => {
    const root = await temporary('rove-local-restore-');
    const repoRoot = await repository(root);
    const hookPath = await defaultHookPath(repoRoot);
    await mkdir(path.dirname(hookPath), { recursive: true });
    const earlier = localHookText('/Users/me/old/launcher.mjs');
    const replacement = localHookText('/Users/me/new/launcher.mjs');
    // The write moved the earlier hook aside, then failed before creating its own.
    await expect(restoreLocalHook(hookPath, replacement, earlier)).resolves.toBeUndefined();
    expect(await readFile(hookPath, 'utf8')).toBe(earlier);
  });

  it('reads worktree paths that hold a newline whole', async () => {
    const listing = 'worktree /work/main\0HEAD abc\0branch refs/heads/main\0\0worktree /work/odd\nname\0HEAD def\0detached\0\0';
    const git = vi.fn(async (_cwd: string, args: string[]) => (args[0] === 'worktree'
      ? { code: 0, stdout: listing, stderr: '' }
      : { code: 0, stdout: '/work/main/.git\n', stderr: '' }));
    const roots = await repositoryRoots('/work/main', { git });
    expect(git.mock.calls[0][1]).toEqual(['worktree', 'list', '--porcelain', '-z']);
    expect(roots).toContain(path.resolve('/work/odd\nname'));
    expect(() => assertPolicyOutside({ configFile: '/work/odd\nname/sentinel.json', config: {}, roots, realPath: (target: string) => target }))
      .toThrow('could write the policy');
  });
});

describe('the gate review of a2640c5', () => {
  it('never leaves part of a hook, and a failed replacement is undone to the earlier hook', async () => {
    const root = await temporary('rove-local-partial-');
    const repoRoot = await repository(root);
    const hookPath = await defaultHookPath(repoRoot);
    await mkdir(path.dirname(hookPath), { recursive: true });
    const earlier = localHookText('/Users/me/old/launcher.mjs');
    const replacement = localHookText('/Users/me/new/launcher.mjs');
    await writeFile(hookPath, earlier);
    // The write stops after half the text, as a full disk would leave it.
    const partial = async (target: string, text: string, options: object) => {
      await writeFile(target, text.slice(0, text.length / 2), options);
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };
    await expect(writeLocalHook(hookPath, replacement, earlier, { write: partial })).rejects.toThrow('no space left');
    await expect(access(hookPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(path.dirname(hookPath))).filter((name) => name.includes('rove-sentinel'))).toEqual([]);

    await restoreLocalHook(hookPath, replacement, earlier);
    expect(await readFile(hookPath, 'utf8')).toBe(earlier);
  });
});

describe('the gate review of 79aea3d', () => {
  it('refuses, before anything changes, a hooks folder whose file system has no hard links', async () => {
    const root = await temporary('rove-local-links-');
    const repoRoot = await repository(root);
    const launcher = await outsideLauncher(root);
    const hookPath = await defaultHookPath(repoRoot);
    await mkdir(path.dirname(hookPath), { recursive: true });
    const earlier = localHookText('/Users/me/old/launcher.mjs');
    await writeFile(hookPath, earlier);
    const noLinks = async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '', linkFile: noLinks })).rejects.toThrow('needs hard links');
    expect(await readFile(hookPath, 'utf8')).toBe(earlier);
    expect((await readdir(path.dirname(hookPath))).filter((name) => name.includes('rove-sentinel'))).toEqual([]);
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '' })).resolves.toMatchObject({ previous: earlier });
  });
});

describe('the gate review of f21023f', () => {
  it('checks hard links without creating a hooks folder the clone does not have', async () => {
    const root = await temporary('rove-local-nohooks-');
    const repoRoot = await repository(root);
    await rm(path.join(repoRoot, '.git', 'hooks'), { recursive: true, force: true });
    const launcher = await outsideLauncher(root);
    await expect(prepareLocalHook({ repoRoot, launcher, hooksPath: '' })).resolves.toMatchObject({ previous: null });
    await expect(access(path.join(repoRoot, '.git', 'hooks'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(path.join(repoRoot, '.git'))).filter((name) => name.includes('rove-sentinel'))).toEqual([]);
  });
});

describe('the CodeRabbit review of 40d4055', () => {
  it('runs Node by its absolute path, never a node a repository puts first on PATH', async () => {
    const root = await temporary('rove-local-node-');
    const repoRoot = await repository(root);
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(repoRoot, 'remote', 'add', 'origin', remote);
    const launcher = await outsideLauncher(root);
    const prepared = await prepareLocalHook({ repoRoot, launcher, node: process.execPath, hooksPath: '' });
    expect(prepared.hookText).toContain(`exec '${process.execPath.replaceAll('\\', '/')}' `);
    await writeFile(prepared.hookPath, prepared.hookText, { mode: 0o755 });
    // A planted `node` first on PATH, as npm's node_modules/.bin would be.
    const planted = path.join(repoRoot, 'node_modules', '.bin');
    await mkdir(planted, { recursive: true });
    const marker = path.join(root, 'planted-ran');
    await writeFile(path.join(planted, 'node'), `#!/bin/sh\necho ran > '${marker.replaceAll('\\', '/')}'\nexit 0\n`, { mode: 0o755 });
    await writeFile(path.join(planted, 'node.cmd'), `@echo ran> "${marker}"\r\n`);
    execFileSync('git', ['push', '-q', 'origin', 'main'], {
      cwd: repoRoot, env: { ...process.env, PATH: `${planted}${path.delimiter}${process.env.PATH}` },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(path.join(root, 'hook-call.json'), 'utf8')).args[0]).toBe('pre-push');
  });

  it('refuses a Node inside the repository', async () => {
    const root = await temporary('rove-local-node-');
    const repoRoot = await repository(root);
    const roots = await repositoryRoots(repoRoot);
    expect(() => localNode(path.join(repoRoot, 'node_modules', '.bin', 'node.exe'), { roots })).toThrow('could change its own reviewer');
    expect(localNode(process.execPath, { roots })).toBe(realpathSync.native(process.execPath));
  });

  it('replaces or removes only the exact hook it wrote, never another local hook or an edited one', async () => {
    const root = await temporary('rove-local-exact-');
    const repoRoot = await repository(root);
    const hookPath = await defaultHookPath(repoRoot);
    await mkdir(path.dirname(hookPath), { recursive: true });
    const ours = localHookText('/Users/me/tools/launcher.mjs');
    const another = localHookText('/Users/me/other/launcher.mjs');
    // Another installation replaced the hook after this one read it.
    await writeFile(hookPath, another);
    await expect(writeLocalHook(hookPath, localHookText('/Users/me/new/launcher.mjs'), ours)).rejects.toThrow('changed during the installation');
    expect(await readFile(hookPath, 'utf8')).toBe(another);
    // Its launcher path edited by hand.
    await expect(removeLocalHook(hookPath, ours)).resolves.toBe('manual');
    expect(await readFile(hookPath, 'utf8')).toBe(another);
    await expect(removeLocalHook(hookPath, another)).resolves.toBe('removed-local-hook');
  });

  it('does not report a hook Git would not run, without its executable bit', async () => {
    const root = await temporary('rove-local-exec-');
    const hookPath = path.join(root, 'pre-push');
    const ours = localHookText('/Users/me/tools/launcher.mjs');
    await writeFile(hookPath, ours);
    const notExecutable = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    await expect(localHookPresent(hookPath, ours, { platform: 'linux', executable: notExecutable })).resolves.toBe(false);
    await expect(localHookPresent(hookPath, ours, { platform: 'linux', executable: async () => {} })).resolves.toBe(true);
    // Git for Windows does not read the bit.
    await expect(localHookPresent(hookPath, ours, { platform: 'win32', executable: notExecutable })).resolves.toBe(true);
    await expect(localHookPresent(hookPath, localHookText('/Users/me/other/launcher.mjs'), { platform: 'win32' })).resolves.toBe(false);
  });
});

describe('the gate review of e07f138', () => {
  it('counts another clone’s hook as its installation even without its executable bit', async () => {
    const root = await temporary('rove-local-clones-exec-');
    const first = await repository(root);
    const second = path.join(root, 'second');
    execFileSync('git', ['clone', '-q', first, second]);
    const firstHook = await defaultHookPath(first);
    await mkdir(path.dirname(firstHook), { recursive: true });
    const text = localHookText('/Users/me/tools/launcher.mjs');
    await writeFile(firstHook, text, { mode: 0o644 });
    await expect(localHookPresent(firstHook, null, { platform: 'linux', executable: async () => { throw new Error('denied'); }, runnable: false }))
      .resolves.toBe(true);
    const installation = { mode: 'local', hook: firstHook, launcher: '/Users/me/tools/launcher.mjs', node: process.execPath, config: null };
    await expect(assertSameClone(installation, await defaultHookPath(second))).rejects.toThrow('from another clone');
  });
});
