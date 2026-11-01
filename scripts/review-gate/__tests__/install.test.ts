import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CHARTER_VERSION, GATE_VERSION, LIMITS } from '../constants.mjs';
import {
  buildInstallPlan,
  watcherPath,
  windowsTaskRun,
  daemonSignalPid,
  executeUninstall,
  executeInstallTransaction,
  gateStatus,
  watcherReport,
  watcherState,
  heartbeatIsHealthy,
  recoverStaleDaemonState,
  schedulerQueryInstalled,
  stopDaemon,
  verifyPrerequisites,
} from '../install.mjs';
import { atomicWriteJson, ensureState, readJson, writeDaemonError } from '../storage.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { hookCallsSentinel, initializeRepository, uninstallGeneratedHook } from '../init.mjs';

describe('what a person is told of the watcher', () => {
  const heartbeat = { pid: 12 };
  const lock = { pid: 12 };
  const installed = true;

  it('says it runs, or runs another version', () => {
    expect(watcherState({ running: true, compatible: true, heartbeat, lock, installed })).toEqual({ state: 'running', pid: 12 });
    expect(watcherState({ running: true, compatible: false, heartbeat, lock, installed })).toMatchObject({ state: 'outdated', action: expect.stringContaining('install') });
  });

  it('says it is stopped when the scheduler reports it installed but nothing runs', () => {
    expect(watcherState({ running: false, installed })).toMatchObject({ state: 'stopped', reason: 'no watcher is running', action: expect.stringContaining('install') });
  });

  it('gives the watcher\'s own refusal as the reason', () => {
    const daemonError = { at: '2026-11-01T00:00:00.000Z', message: 'Review daemon lock names live PID 12' };
    expect(watcherState({ running: false, lock, daemonError, installed })).toMatchObject({ state: 'stopped', reason: daemonError.message, since: daemonError.at });
  });

  it('names a lock with no fresh heartbeat', () => {
    expect(watcherState({ running: false, lock, installed }).reason).toContain('PID 12');
  });

  it('says so when no watcher was ever installed', () => {
    expect(watcherState({ running: false, installed: false })).toEqual({ state: 'not-installed' });
  });

  it('does not call a watcher stopped for an old refusal once it is uninstalled', () => {
    expect(watcherState({ running: false, installed: false, daemonError: { message: 'old refusal' } })).toEqual({ state: 'not-installed' });
  });

  it('calls unreadable state what it is, even with nothing else recorded', () => {
    const watcher = watcherState({ running: false, installed: false, stateError: 'Unexpected end of JSON input' });
    expect(watcher).toMatchObject({ state: 'stopped', reason: expect.stringContaining('unreadable: Unexpected end of JSON input') });
    expect(watcherState({ running: false, installed, stateError: 'bad', daemonError: { message: 'its own refusal' } }).reason).toBe('its own refusal');
  });

  it('does not claim to know when the scheduler could not be read', () => {
    expect(watcherState({ running: false, installed: false, schedulerError: 'launchctl failed' })).toEqual({ state: 'unknown', reason: 'launchctl failed' });
    expect(watcherState({ running: false, installed, schedulerError: 'launchctl failed' }).state).toBe('stopped');
  });

  it('keeps doctor going when the watcher cannot be read', async () => {
    const scheduler = { supported: true, installed: null, error: 'query failed' };
    await expect(watcherReport('C:\\repo', { status: async () => ({ watcher: { state: 'stopped' }, scheduler }) as never }))
      .resolves.toEqual({ watcher: { state: 'stopped' }, scheduler });
    await expect(watcherReport('C:\\repo', { status: async () => { throw new Error('no state'); } }))
      .resolves.toEqual({ watcher: { state: 'unknown', reason: 'no state' }, scheduler: null });
    const orphan = Object.assign(new Error('tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    await expect(watcherReport('C:\\repo', { status: async () => { throw orphan; } })).rejects.toBe(orphan);
  });

  describe('reading the repository', () => {
    const missingService = async () => ({ code: 1, stdout: '', stderr: process.platform === 'darwin'
      ? 'Could not find service' : 'ERROR: The system cannot find the file specified.' });

    async function installedRepository() {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-watcher-state-'));
      execFileSync('git', ['init', '-q'], { cwd: repoRoot });
      await initializeRepository(repoRoot);
      const stateRoot = path.join(repoRoot, '.state');
      const paths = await ensureState(stateRoot);
      await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Rules', lessons: '# Lessons' }));
      const status = async () => (await gateStatus({ repoRoot }, {
        createContext: async () => ({ repoRoot, stateRoot, paths }),
        getHooksPath: async () => '.githooks',
        run: missingService,
      })).watcher;
      return { repoRoot, status, paths, stateRoot };
    }

    it('counts the generated hook as installed, and not after uninstall', async () => {
      const { repoRoot, status } = await installedRepository();
      try {
        await expect(hookCallsSentinel(repoRoot)).resolves.toBe(true);
        await expect(status()).resolves.toMatchObject({ state: 'stopped' });

        await expect(uninstallGeneratedHook(repoRoot)).resolves.toBe('removed-generated-hook');

        await expect(hookCallsSentinel(repoRoot)).resolves.toBe(false);
        await expect(status()).resolves.toEqual({ state: 'not-installed' });
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    });

    it('reports a corrupt lock as unreadable state', async () => {
      const { paths, status } = await installedRepository();
      await writeFile(paths.lock, '{ not json');
      await expect(status()).resolves.toMatchObject({ state: 'stopped', reason: expect.stringContaining('unreadable') });
    });

    it.skipIf(process.platform === 'linux')('survives a scheduler that cannot even be started, and says so apart', async () => {
      const { repoRoot, paths, stateRoot } = await installedRepository();
      const status = await gateStatus({ repoRoot }, {
        createContext: async () => ({ repoRoot, stateRoot, paths }),
        getHooksPath: async () => '.githooks',
        run: async () => { throw Object.assign(new Error('spawn launchctl ENOENT'), { code: 'ENOENT' }); },
      });
      expect(status.scheduler).toMatchObject({ installed: null, error: expect.stringContaining('ENOENT') });
      expect(status.watcher.state).toBe('stopped');
    });

    it('warns of a stopped watcher before a doctor check fails, and still exits with the error', async () => {
      const { repoRoot } = await installedRepository();
      const home = await mkdtemp(path.join(os.tmpdir(), 'rove-review-doctor-home-'));
      await writeFile(path.join(repoRoot, '.rove-sentinel.json'), '{ "typo": true }');
      const cli = path.resolve('scripts/review-gate/cli.mjs');
      const run = spawnSync(process.execPath, [cli, 'doctor', '--project-config', '--no-update-check'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, ROVE_SENTINEL_UPDATE_NOTIFICATIONS: '0', ROVE_SENTINEL_UPDATE_CHECK: '0' },
      });
      expect(run.stderr).toContain('The review watcher is stopped');
      expect(run.stderr).toContain('Unknown Sentinel configuration key');
      expect(run.status).not.toBe(0);
    });

    it.each([
      ['the generated adapter', 'exec node "$root/.githooks/sentinel.mjs" pre-push "$@"', true],
      ['the command', 'npx --no-install rove-sentinel pre-push "$@"', true],
      ['the launcher in a repository of its own', 'exec node "$root/scripts/review-gate/launcher.mjs" pre-push "$@"', true],
      ['a comment', '# Sentinel was removed\nmake lint', false],
      ['a commented call', '# npx rove-sentinel pre-push\nmake lint', false],
      ['a comment after a command', 'make lint # rove-sentinel comes back later', false],
      ['a passing mention', 'echo "Sentinel is gone"', false],
    ])('reads %s in a hook', async (_what, line, calls) => {
      const { repoRoot } = await installedRepository();
      await writeFile(path.join(repoRoot, '.githooks/pre-push'), `#!/bin/sh\nset -eu\n${line}\n`);
      await expect(hookCallsSentinel(repoRoot)).resolves.toBe(calls);
    });

    it('recognizes the hook this repository uses', async () => {
      await expect(hookCallsSentinel(process.cwd())).resolves.toBe(true);
    });

    it('counts a project\'s own hook only while it calls Sentinel', async () => {
      const { repoRoot, status } = await installedRepository();
      try {
        await writeFile(path.join(repoRoot, '.githooks/pre-push'), '#!/bin/sh\nnpx --no-install rove-sentinel pre-push "$@"\n');
        await expect(status()).resolves.toMatchObject({ state: 'stopped' });
        await writeFile(path.join(repoRoot, '.githooks/pre-push'), '#!/bin/sh\nmake lint\n');
        await expect(status()).resolves.toEqual({ state: 'not-installed' });
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('review-gate native installer plans', () => {
  it('names the provider when its authentication output is not valid JSON', async () => {
    const run = vi.fn(async (command, args) => ({
      code: 0,
      stdout: command === 'claude' && args[0] === 'auth'
        ? 'authentication status changed format'
        : command === 'codex' && args[0] === 'login'
          ? 'Logged in using ChatGPT'
          : `${command} available`,
      stderr: '',
    }));

    await expect(verifyPrerequisites('C:\\repo', {
      run,
      config: { providers: 'both' },
      env: {
        ROVE_REVIEW_ALLOW_API_BILLING: '1',
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: 'openai-key',
      },
    }))
      .rejects.toThrow('Claude Code authentication status returned invalid JSON');
    expect(run).toHaveBeenCalledTimes(6);
    for (const call of run.mock.calls) {
      expect(call[2]).toMatchObject({ allowFailure: true, env: {} });
    }
  });

  it('surfaces a tailored prerequisite failure instead of a generic process error', async () => {
    const run = vi.fn(async (command) => ({
      code: command === 'gh' ? 1 : 0,
      stdout: command === 'claude' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'Logged in using ChatGPT',
      stderr: command === 'gh' ? 'not logged in' : '',
    }));

    await expect(verifyPrerequisites('C:\\repo', { run, env: {} }))
      .rejects.toThrow('GitHub CLI authentication check failed with exit 1: not logged in');
  });

  it('does not certify API-only provider auth for an installed subscription watcher', async () => {
    const run = vi.fn(async (command, args) => ({
      code: 0,
      stdout: command === 'claude' && args[0] === 'auth'
        ? '{"loggedIn":true,"authMethod":"api_key"}'
        : command === 'codex' && args[0] === 'login'
          ? 'Logged in using API key'
          : `${command} available`,
      stderr: '',
    }));

    await expect(verifyPrerequisites('C:\\repo', {
      run,
      config: { providers: 'both' },
      env: {
        ROVE_REVIEW_ALLOW_API_BILLING: '1',
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: 'openai-key',
      },
    })).rejects.toThrow('Claude Code is not authenticated through a Claude subscription');
  });

  it('builds a repository-specific Windows logon task without a shell', () => {
    const plan = buildInstallPlan({
      platform: 'win32',
      repoRoot: 'D:\\projects\\example',
      stateRoot: 'C:\\state',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      home: 'C:\\Users\\me',
      uid: null,
    });
    expect(plan.taskName).toMatch(/^Rove-Shared-Review-Gate-[a-f0-9]{8}$/);
    expect(plan.create.command).toBe('schtasks.exe');
    expect(plan.create.args).toEqual(['/Create', '/TN', plan.taskName, '/XML', 'C:\\state\\watch-task.xml', '/F']);
    expect(plan.stop.args).toContain('/End');
    expect(plan.taskXml).toContain('watch.cmd');
    expect(plan.wrapper).toContain('"watch" "--daemon"');
    expect(plan.wrapper).toContain('set "ROVE_REVIEW_ALLOW_API_BILLING="');
    expect(plan.wrapper).toContain('set "ANTHROPIC_API_KEY="');
    expect(plan.wrapper).toContain('set "OPENAI_API_KEY="');
    expect(plan.taskXml).not.toContain('powershell');
  });

  it('registers the task for its own user\'s logon, which needs no administrator', () => {
    const plan = buildInstallPlan({
      platform: 'win32', repoRoot: 'D:\\project', stateRoot: 'C:\\state', nodePath: 'C:\\node.exe', systemRoot: 'C:\\WINDOWS',
      environment: { USERDOMAIN: 'EXAMPLE', USERNAME: 'me & you' },
    });
    expect(plan.create.args).not.toContain('ONLOGON');
    expect(plan.taskXml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>EXAMPLE\\me &amp; you<\/UserId>\s*<\/LogonTrigger>/);
    expect(plan.taskXml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('keeps a laptop\'s watcher running on battery and past the scheduler\'s default time limit', () => {
    const plan = buildInstallPlan({ platform: 'win32', repoRoot: 'D:\\project', stateRoot: 'C:\\state', nodePath: 'C:\\node.exe' });
    expect(plan.taskXml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(plan.taskXml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(plan.taskXml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  it('writes the task definition where the plan names it, marked as the UTF-16 it declares', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-task-xml-'));
    try {
      const paths = await ensureState(stateRoot);
      const plan = { ...buildInstallPlan({ platform: 'win32', repoRoot: 'D:\\project', stateRoot, nodePath: 'C:\\node.exe' }),
        wrapperPath: path.join(stateRoot, 'watch.cmd'), taskXmlPath: path.join(stateRoot, 'watch-task.xml') };
      await executeInstallTransaction({
        context: { paths, repoRoot: stateRoot, stateRoot }, plan, policy: { policyDigest: 'p' }, currentHooks: '.githooks', start: false,
      }, { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' })) });
      const bytes = await readFile(plan.taskXmlPath);
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      expect(bytes.subarray(2).toString('utf16le')).toBe(plan.taskXml);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('carries the tools the installing shell found into the scheduled watcher, and never a credential', () => {
    const plan = buildInstallPlan({
      platform: 'win32', repoRoot: 'D:\\project', stateRoot: 'C:\\state', nodePath: 'C:\\node.exe',
      environment: {
        PATH: 'C:\\tools\\git\\cmd;C:\\Windows',
        CLAUDE_CONFIG_DIR: 'C:\\tools\\home\\claude',
        CODEX_HOME: 'C:\\tools\\home\\codex',
        GH_CONFIG_DIR: 'C:\\tools\\home\\gh',
        GIT_CONFIG_GLOBAL: 'C:\\tools\\home\\gitconfig',
        GH_TOKEN: 'not-for-the-wrapper',
        ANTHROPIC_API_KEY: 'not-for-the-wrapper',
      },
    });
    expect(plan.wrapper).toContain('set "PATH=C:\\tools\\git\\cmd;C:\\Windows;%PATH%"');
    expect(plan.wrapper).toContain('set "CLAUDE_CONFIG_DIR=C:\\tools\\home\\claude"');
    expect(plan.wrapper).toContain('set "CODEX_HOME=C:\\tools\\home\\codex"');
    expect(plan.wrapper).toContain('set "GH_CONFIG_DIR=C:\\tools\\home\\gh"');
    expect(plan.wrapper).toContain('set "GIT_CONFIG_GLOBAL=C:\\tools\\home\\gitconfig"');
    expect(plan.wrapper.indexOf('set "PATH=')).toBeLessThan(plan.wrapper.indexOf('"watch"'));
    expect(plan.wrapper).not.toContain('not-for-the-wrapper');
    expect(plan.wrapper).toContain('set "ANTHROPIC_API_KEY="');
  });

  it('carries nothing of the reviewed checkout, of a package runner or of an unusable entry', () => {
    expect(watcherPath([
      'D:\\project\\node_modules\\.bin',
      'D:\\Project\\scripts',
      'D:\\project',
      'C:\\other\\node_modules\\.bin',
      'C:\\pkg\\node_modules\\npm\\bin',
      '.',
      'relative\\bin',
      '%UNEXPANDED%\\bin',
      '"C:\\Program Files\\Git\\cmd"',
      '',
      'C:\\tools',
      'c:\\TOOLS\\',
      'D:\\project-two\\bin',
    ].join(';'), 'D:\\project')).toBe('C:\\Program Files\\Git\\cmd;C:\\tools;D:\\project-two\\bin');
  });

  it('bounds the carried PATH, keeping what the shell finds first, so the wrapper stays one cmd.exe line', () => {
    const entries = Array.from({ length: 200 }, (_, index) => `C:\\tools\\${String(index).padStart(3, '0')}\\${'x'.repeat(60)}`);
    const carried = watcherPath(entries.join(';'), 'D:\\project');
    expect(carried.length).toBeLessThanOrEqual(4096);
    expect(carried.startsWith(entries[0])).toBe(true);
    expect(carried).not.toContain(entries[199]);
  });

  it('keeps what a scheduled watcher prints, the one trace of a stop before its state folder is known', () => {
    const plan = buildInstallPlan({ platform: 'win32', repoRoot: 'D:\\project', stateRoot: 'C:\\state', nodePath: 'C:\\node.exe' });
    expect(plan.wrapper).toMatch(/"D:\\project" 2> "C:\\state\\watcher-start\.log"\r\n$/);
  });

  it('tells a person what a stopped watcher last printed', () => {
    expect(watcherState({ running: false, installed: true, startLog: 'Could not start git: spawn git ENOENT' }))
      .toMatchObject({ state: 'stopped', reason: 'it stopped with: Could not start git: spawn git ENOENT' });
    expect(watcherState({ running: false, installed: true, startLog: 'old words', daemonError: { message: 'the recorded reason' } }).reason)
      .toBe('the recorded reason');
  });

  it('preserves the installed state location when Task Scheduler supplies a fresh environment', () => {
    const plan = buildInstallPlan({ platform: 'win32', repoRoot: 'D:\\project', stateRoot: 'D:\\custom-state',
      localAppData: 'D:\\custom-local', nodePath: 'C:\\node.exe', autoUpdate: '0', updateNotifications: '0' });
    expect(plan.wrapper).toContain('set "LOCALAPPDATA=D:\\custom-local"');
    expect(plan.wrapper.indexOf('set "LOCALAPPDATA=')).toBeLessThan(plan.wrapper.indexOf('"watch"'));
    expect(plan.wrapper).toContain('set "ROVE_SENTINEL_AUTO_UPDATE=0"');
    expect(plan.wrapper).toContain('set "ROVE_SENTINEL_UPDATE_NOTIFICATIONS=0"');
  });

  it('runs the Windows watcher task in a headless console, never a visible window', () => {
    const plan = buildInstallPlan({
      platform: 'win32',
      repoRoot: 'D:\\projects\\example',
      stateRoot: 'C:\\Users\\me\\AppData\\Local\\Rove\\shared-review-gate\\e931f2b632fde04a',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      home: 'C:\\Users\\me',
      uid: null,
      systemRoot: 'C:\\WINDOWS',
    });
    expect(plan.taskXml).toContain('<Command>C:\\WINDOWS\\System32\\conhost.exe</Command>');
    expect(plan.taskXml).toContain('<Arguments>--headless cmd.exe /d /c &quot;C:\\Users\\me\\AppData\\Local\\Rove\\shared-review-gate\\e931f2b632fde04a\\watch.cmd&quot;</Arguments>');
    expect(plan.installRefusal).toBeNull();
  });

  it('carries a long state path, which `schtasks /TR` could not', () => {
    const long = windowsTaskRun(`C:\\${'deep\\'.repeat(60)}state\\watch.cmd`, 'C:\\WINDOWS');
    expect(long.args).toContain('--headless');
    expect(long.refusal).toBeNull();
  });

  it('refuses, never falls back to a window, for a path the headless command cannot carry', () => {
    const percent = windowsTaskRun('C:\\Users\\me\\%CACHE%\\Rove\\watch.cmd', 'C:\\WINDOWS');
    expect(percent.refusal).toMatch(/contains "%"/);
  });

  it('refuses the install before any change when the plan carries a refusal', async () => {
    const plan = {
      ...buildInstallPlan({
        platform: 'win32', repoRoot: 'D:\\rove', stateRoot: 'C:\\state', systemRoot: 'C:\\WINDOWS',
      }),
      installRefusal: 'state path too long',
    };
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const git = vi.fn(async () => '');
    await expect(executeInstallTransaction({
      context: { repoRoot: 'D:\\rove', stateRoot: 'C:\\state', paths: {} },
      plan,
      policy: {},
      currentHooks: '',
    }, { run, git })).rejects.toThrow('state path too long');
    expect(run).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it('uses shared repository state rather than checkout path for scheduler identity', () => {
    const first = buildInstallPlan({
      platform: 'win32', repoRoot: 'D:\\first', stateRoot: 'C:\\shared-state',
    });
    const second = buildInstallPlan({
      platform: 'win32', repoRoot: 'D:\\second', stateRoot: 'C:\\shared-state',
    });

    expect(first.taskName).toBe(second.taskName);
    expect(first.wrapperPath).toBe(second.wrapperPath);
  });

  it('builds a bounded macOS launch agent with discarded stdio', () => {
    const plan = buildInstallPlan({
      platform: 'darwin',
      repoRoot: '/Users/me/rove',
      stateRoot: '/Users/me/state',
      nodePath: '/opt/homebrew/bin/node',
      home: '/Users/me',
      uid: 501,
    });
    expect(plan.plistPath).toContain('/Library/LaunchAgents/');
    expect(plan.plist).toContain('<string>/dev/null</string>');
    expect(plan.plist).toContain('<key>ROVE_REVIEW_ALLOW_API_BILLING</key><string></string>');
    expect(plan.plist).toContain('<key>ANTHROPIC_API_KEY</key><string></string>');
    expect(plan.plist).toContain('<key>OPENAI_API_KEY</key><string></string>');
    expect(plan.create.args).toContain('gui/501');
  });

  it('distinguishes a proven missing scheduler entry from an unknown query failure', () => {
    const plan = { platform: 'win32' };
    expect(schedulerQueryInstalled(plan, {
      code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.',
    })).toBe(false);
    expect(() => schedulerQueryInstalled(plan, {
      code: 5, stdout: '', stderr: 'ERROR: Access is denied.',
    })).toThrow('Could not determine');
  });

  it('never treats a stale heartbeat as authority to signal a reused PID', () => {
    const now = Date.parse('2026-08-03T12:01:01.000Z');
    const heartbeat = {
      pid: 123,
      ownerToken: 'owner',
      repoRoot: 'C:\\repo',
      gateVersion: GATE_VERSION,
      charterVersion: CHARTER_VERSION,
      at: '2026-08-03T12:00:00.000Z',
    };
    expect(heartbeatIsHealthy(
      heartbeat,
      'C:\\repo',
      60_000,
      { isAlive: () => true, now: () => now },
    )).toBe(false);
    expect(daemonSignalPid(
      heartbeat,
      { pid: 123, ownerToken: 'owner', startedAt: '2026-08-03T11:00:00.000Z' },
      'C:\\repo',
      { isAlive: () => true, now: () => now },
    )).toBeNull();
    expect(heartbeatIsHealthy(
      { ...heartbeat, at: '2026-08-03T12:01:02.000Z' },
      'C:\\repo',
      60_000,
      { isAlive: () => true, now: () => now },
    )).toBe(false);
    expect(heartbeatIsHealthy(
      { ...heartbeat, gateVersion: 'stale-version', at: '2026-08-03T12:01:00.000Z' },
      'C:\\repo',
      60_000,
      { isAlive: () => true, now: () => now },
    )).toBe(false);
  });

  it('preserves Windows registration and the hook when daemon shutdown fails', async () => {
    const plan = buildInstallPlan({
      platform: 'win32',
      repoRoot: 'D:\\projects\\example',
      stateRoot: 'C:\\state',
      nodePath: 'C:\\node.exe',
      home: 'C:\\Users\\me',
      uid: null,
    });
    const git = vi.fn(async () => '');
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await expect(executeUninstall({
      context: { repoRoot: 'D:\\projects\\example' },
      plan,
      removeHooks: true,
      run,
      stop: async () => { throw new Error('daemon still running'); },
      removeFile: vi.fn(async () => {}),
      git,
    })).rejects.toThrow('daemon still running');

    expect(git).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('requests graceful Windows shutdown without sending SIGTERM', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const ownerToken = 'current-owner';
      await atomicWriteJson(paths.lock, { pid: 123, ownerToken });
      await atomicWriteJson(paths.heartbeat, {
        pid: 123,
        ownerToken,
        repoRoot: process.cwd(),
        gateVersion: GATE_VERSION,
        charterVersion: CHARTER_VERSION,
        at: new Date().toISOString(),
      });
      const isAlive = vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      const kill = vi.fn();
      const writeStopRequest = vi.fn(async () => {});

      await stopDaemon({ repoRoot: process.cwd(), paths }, {
        platform: 'win32',
        kill,
        isAlive,
        writeStopRequest,
        delay: vi.fn(async () => {}),
      });

      expect(kill).not.toHaveBeenCalled();
      expect(writeStopRequest).toHaveBeenCalledWith(paths.stopRequest, expect.objectContaining({
        pid: 123,
        ownerToken,
      }));
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  describe('with an owner this process may not signal', () => {
    const denied = () => vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    async function ownerState(at: string) {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
      const paths = await ensureState(stateRoot);
      const owner = { pid: 4242, ownerToken: 'live-owner' };
      await atomicWriteJson(paths.lock, owner);
      await atomicWriteJson(paths.heartbeat, {
        ...owner, repoRoot: process.cwd(), gateVersion: GATE_VERSION, charterVersion: CHARTER_VERSION, at,
      });
      return { stateRoot, paths, owner };
    }
    const keeps = async (paths: { lock: string; heartbeat: string }, owner: object) => {
      await expect(readJson(paths.lock)).resolves.toMatchObject(owner);
      await expect(readJson(paths.heartbeat)).resolves.toMatchObject(owner);
    };

    it('keeps the state of an owner with a stale heartbeat', async () => {
      const { stateRoot, paths, owner } = await ownerState('2026-01-01T00:00:00.000Z');
      const kill = denied();
      try {
        await expect(stopDaemon({ repoRoot: process.cwd(), paths })).rejects.toThrow('Refusing to signal or unlock a live PID');
        await keeps(paths, owner);
      } finally {
        kill.mockRestore();
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it('keeps the state of a healthy owner that a signal cannot reach', async () => {
      const { stateRoot, paths, owner } = await ownerState(new Date().toISOString());
      const kill = denied();
      try {
        await expect(stopDaemon({ repoRoot: process.cwd(), paths }, { platform: 'linux' })).rejects.toThrow('operation not permitted');
        await keeps(paths, owner);
      } finally {
        kill.mockRestore();
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it('keeps the state of a healthy owner that does not answer a stop request', async () => {
      const { stateRoot, paths, owner } = await ownerState(new Date().toISOString());
      const kill = denied();
      try {
        await expect(stopDaemon({ repoRoot: process.cwd(), paths }, {
          platform: 'win32', writeStopRequest: async () => {}, delay: async () => {}, timeoutMs: 0,
        })).rejects.toThrow('did not stop');
        await keeps(paths, owner);
      } finally {
        kill.mockRestore();
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it('leaves an owner with a stale heartbeat to the person who runs recover', async () => {
      // A reused process id looks the same, and recover is the only way out of one.
      const { stateRoot, paths } = await ownerState('2026-01-01T00:00:00.000Z');
      const kill = denied();
      try {
        await expect(recoverStaleDaemonState({ repoRoot: process.cwd(), paths }, {
          reason: 'a stale watcher to recover', recoverResources: async () => 0,
        })).resolves.toMatchObject({ recovered: true, previousLockPid: 4242 });
        await expect(readJson(paths.lock)).resolves.toBeNull();
      } finally {
        kill.mockRestore();
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it('recovers through a claim whose result a power cut tore', async () => {
      const { stateRoot, paths } = await ownerState('2026-01-01T00:00:00.000Z');
      const kill = denied();
      try {
        await atomicWriteJson(path.join(paths.claims, 'request-1.json.12.owner.claim'), { id: 'request-1' });
        await writeFile(path.join(paths.results, 'request-1.json'), '{"status":"pa');
        await expect(recoverStaleDaemonState({ repoRoot: process.cwd(), paths }, {
          reason: 'a stale watcher to recover', recoverResources: async () => 0,
        })).resolves.toMatchObject({ recovered: true, claimsRecovered: 1 });
        await expect(readJson(path.join(paths.requests, 'request-1.json'))).resolves.toMatchObject({ id: 'request-1' });
      } finally {
        kill.mockRestore();
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it('refuses stale-state recovery of a healthy owner', async () => {
      const { stateRoot, paths, owner } = await ownerState(new Date().toISOString());
      const kill = denied();
      try {
        await expect(recoverStaleDaemonState({ repoRoot: process.cwd(), paths }, { reason: 'a stale watcher to recover' })).rejects.toThrow('is healthy');
        await keeps(paths, owner);
      } finally {
        kill.mockRestore();
        await rm(stateRoot, { recursive: true, force: true });
      }
    });
  });

  it('does not delete a replacement watcher lock during graceful shutdown', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await atomicWriteJson(paths.lock, { pid: 123, ownerToken: 'old-owner' });
      await atomicWriteJson(paths.heartbeat, {
        pid: 123,
        ownerToken: 'old-owner',
        repoRoot: process.cwd(),
        gateVersion: GATE_VERSION,
        charterVersion: CHARTER_VERSION,
        at: new Date().toISOString(),
      });
      const isAlive = vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      const replacement = { pid: 456, ownerToken: 'replacement-owner' };

      await expect(stopDaemon({ repoRoot: process.cwd(), paths }, {
        platform: 'win32',
        isAlive,
        writeStopRequest: async () => {
          await atomicWriteJson(paths.lock, replacement);
        },
        delay: vi.fn(async () => {}),
      })).rejects.toThrow('changed ownership');

      await expect(readJson(paths.lock)).resolves.toMatchObject(replacement);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('stops a same-checkout watcher before starting its versioned replacement', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const wrapperPath = path.join(stateRoot, 'watch.cmd');
      const plan = {
        platform: 'win32', wrapperPath, wrapper: 'new wrapper',
        query: { command: 'scheduler', args: ['query'] },
        stop: { command: 'scheduler', args: ['stop'] },
        create: { command: 'scheduler', args: ['create'] },
        start: { command: 'scheduler', args: ['start'] },
        remove: { command: 'scheduler', args: ['remove'] },
      };
      const calls: string[] = [];
      const run = vi.fn(async (_command, args) => {
        calls.push(args[0]);
        return { code: 0, stdout: '', stderr: '' };
      });
      const stop = vi.fn(async () => { calls.push('stop-daemon'); });

      await executeInstallTransaction({
        context: { repoRoot: 'C:\\repo', stateRoot, paths },
        plan,
        policy: { gateVersion: 'new' },
        currentHooks: '.githooks',
        previousDaemonActive: true,
        start: true,
      }, {
        run,
        stop,
        waitHeartbeat: async () => ({ gateVersion: 'new' }),
      });

      expect(calls).toEqual(['query', 'stop-daemon', 'stop', 'create', 'start']);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('does not end an existing Windows task when graceful watcher stop fails', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const wrapperPath = path.join(stateRoot, 'watch.cmd');
      const plan = {
        platform: 'win32', wrapperPath, wrapper: 'new wrapper',
        query: { command: 'scheduler', args: ['query'] },
        stop: { command: 'scheduler', args: ['stop'] },
        create: { command: 'scheduler', args: ['create'] },
        start: { command: 'scheduler', args: ['start'] },
        remove: { command: 'scheduler', args: ['remove'] },
      };
      const calls: string[] = [];
      const run = vi.fn(async (_command, args) => {
        calls.push(args[0]);
        return { code: 0, stdout: '', stderr: '' };
      });

      await expect(executeInstallTransaction({
        context: { repoRoot: 'C:\\repo', stateRoot, paths },
        plan,
        policy: { gateVersion: 'new' },
        currentHooks: '.githooks',
        previousDaemonActive: true,
        start: true,
      }, {
        run,
        stop: vi.fn(async () => { throw new Error('graceful stop failed'); }),
      })).rejects.toThrow('graceful stop failed');

      expect(calls).not.toContain('stop');
      expect(calls).not.toContain('start');
      expect(calls).toEqual(['query']);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('preserves an unknown live replacement when rollback cannot stop it', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const wrapperPath = path.join(stateRoot, 'watch.cmd');
      const plan = {
        platform: 'win32', wrapperPath, wrapper: 'new wrapper',
        query: { command: 'scheduler', args: ['query'] },
        stop: { command: 'scheduler', args: ['stop'] },
        create: { command: 'scheduler', args: ['create'] },
        start: { command: 'scheduler', args: ['start'] },
        remove: { command: 'scheduler', args: ['remove'] },
      };
      const calls: string[] = [];
      const run = vi.fn(async (_command, args) => {
        calls.push(args[0]);
        if (args[0] === 'query') {
          return {
            code: 1,
            stdout: '',
            stderr: 'ERROR: The system cannot find the file specified.',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      await expect(executeInstallTransaction({
        context: { repoRoot: 'C:\\repo', stateRoot, paths },
        plan,
        policy: { gateVersion: 'new' },
        currentHooks: '.githooks',
        start: true,
      }, {
        run,
        stop: vi.fn(async () => { throw new Error('replacement ownership unknown'); }),
        waitHeartbeat: vi.fn(async () => { throw new Error('replacement heartbeat invalid'); }),
      })).rejects.toThrow('scheduler registration, wrapper, policy, and hook were preserved');

      expect(calls).toEqual(['query', 'create', 'start']);
      await expect(readFile(paths.policy, 'utf8')).resolves.toContain('new');
      await expect(readFile(wrapperPath, 'utf8')).resolves.toBe('new wrapper');
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('restores pre-existing installer resources instead of deleting them on rollback', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const wrapperPath = path.join(stateRoot, 'watch.cmd');
      await writeFile(paths.policy, 'old policy\n');
      await writeFile(wrapperPath, 'old wrapper\n');
      const plan = {
        platform: 'win32', wrapperPath, wrapper: 'new wrapper',
        query: { command: 'scheduler', args: ['query'] },
        stop: { command: 'scheduler', args: ['stop'] },
        create: { command: 'scheduler', args: ['create'] },
        start: { command: 'scheduler', args: ['start'] },
        remove: { command: 'scheduler', args: ['remove'] },
      };
      const calls: string[] = [];
      const run = vi.fn(async (_command, args) => {
        calls.push(args[0]);
        return { code: 0, stdout: '', stderr: '' };
      });

      await expect(executeInstallTransaction({
        context: { repoRoot: 'C:\\repo', stateRoot, paths },
        plan,
        policy: { gateVersion: 'new' },
        currentHooks: '.githooks',
        previousDaemonActive: true,
        start: true,
      }, {
        run,
        stop: vi.fn(async () => {}),
        waitHeartbeat: async () => { throw new Error('new watcher never became healthy'); },
      })).rejects.toThrow('new watcher never became healthy');

      expect(calls).not.toContain('remove');
      expect(calls.filter((call) => call === 'create')).toHaveLength(2);
      expect(calls.filter((call) => call === 'start')).toHaveLength(2);
      expect(await readFile(paths.policy, 'utf8')).toBe('old policy\n');
      expect(await readFile(wrapperPath, 'utf8')).toBe('old wrapper\n');
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps the watcher\'s GitHub choice through a failed install and an engine update', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await atomicWriteJson(paths.watcherOptions, { github: false });
      const install = (github: boolean | undefined, fails: boolean) => executeInstallTransaction({
        context: { repoRoot: 'C:\\repo', stateRoot, paths },
        plan: { platform: 'linux', unsupportedScheduler: true },
        policy: { gateVersion: 'new' },
        currentHooks: '.githooks',
        start: true,
        github,
      }, {
        git: vi.fn(async () => ''),
        startDetached: vi.fn(async () => { if (fails) throw new Error('spawn denied'); }),
        stop: vi.fn(async () => {}),
        waitHeartbeat: vi.fn(async () => ({ gateVersion: 'new' })),
      });

      // a failed install leaves it as it was
      await expect(install(true, true)).rejects.toThrow('spawn denied');
      expect(await readJson(paths.watcherOptions)).toEqual({ github: false });
      // an engine update passes no choice, and keeps it
      await install(undefined, false);
      expect(await readJson(paths.watcherOptions)).toEqual({ github: false });
      // an install says what it wants
      await install(true, false);
      expect(await readJson(paths.watcherOptions)).toEqual({ github: true });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rolls back policy and hook setup when detached watcher spawn fails', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const git = vi.fn(async () => '');
      const startDetached = vi.fn(async () => { throw new Error('spawn denied'); });

      await expect(executeInstallTransaction({
        context: { repoRoot: 'C:\\repo', stateRoot, paths },
        plan: { platform: 'linux', unsupportedScheduler: true },
        policy: { gateVersion: 'new' },
        currentHooks: '',
        start: true,
      }, {
        git,
        startDetached,
        stop: vi.fn(async () => {}),
        waitHeartbeat: vi.fn(async () => ({ gateVersion: 'new' })),
      })).rejects.toThrow('spawn denied');

      expect(git.mock.calls.map((call) => call[1])).toEqual([
        ['config', 'core.hooksPath', '.githooks'],
        ['config', '--unset', 'core.hooksPath'],
      ]);
      await expect(access(paths.policy)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps an existing macOS login agent registered when reinstalling without start', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const plistPath = path.join(stateRoot, 'watch.plist');
      await atomicWriteJson(paths.policy, { policyDigest: 'same-policy' });
      await writeFile(plistPath, 'old plist\n');
      const plan = {
        platform: 'darwin', plistPath, plist: 'new plist',
        query: { command: 'launchctl', args: ['query'] },
        stop: { command: 'launchctl', args: ['stop'] },
        create: { command: 'launchctl', args: ['create'] },
        start: { command: 'launchctl', args: ['start'] },
        remove: { command: 'launchctl', args: ['remove'] },
      };
      const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
      const stop = vi.fn(async () => {});

      await executeInstallTransaction({
        context: { repoRoot: '/repo', stateRoot, paths },
        plan,
        policy: { gateVersion: 'new', policyDigest: 'same-policy' },
        currentHooks: '.githooks',
        previousDaemonActive: true,
        start: false,
      }, { run, stop });

      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith('launchctl', ['query'], expect.any(Object));
      expect(stop).not.toHaveBeenCalled();
      expect(await readFile(plistPath, 'utf8')).toBe('new plist');
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('refuses to swap policy under an active watcher during no-start reinstall', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await atomicWriteJson(paths.policy, { policyDigest: 'old-policy' });
      const git = vi.fn(async () => '');

      await expect(executeInstallTransaction({
        context: { repoRoot: '/repo', stateRoot, paths },
        plan: { platform: 'linux', unsupportedScheduler: true },
        policy: { policyDigest: 'new-policy' },
        currentHooks: '.githooks',
        previousDaemonActive: true,
        start: false,
      }, { git })).rejects.toThrow('Cannot replace the installed review policy with --no-start');

      expect(git).not.toHaveBeenCalled();
      await expect(readFile(paths.policy, 'utf8')).resolves.toContain('old-policy');
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('records that a fresh macOS no-start registration activates at next login', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const plistPath = path.join(stateRoot, 'watch.plist');
      const plan = {
        platform: 'darwin', plistPath, plist: 'new plist',
        query: { command: 'launchctl', args: ['query'] },
        stop: { command: 'launchctl', args: ['stop'] },
        create: { command: 'launchctl', args: ['create'] },
        start: { command: 'launchctl', args: ['start'] },
        remove: { command: 'launchctl', args: ['remove'] },
      };
      const run = vi.fn(async () => ({
        code: 113, stdout: '', stderr: 'Could not find service',
      }));

      const result = await executeInstallTransaction({
        context: { repoRoot: '/repo', stateRoot, paths },
        plan,
        policy: { gateVersion: 'new' },
        currentHooks: '.githooks',
        start: false,
      }, { run });

      expect(result.schedulerActivation).toBe('next-login');
      expect(run).toHaveBeenCalledTimes(1);
      await expect(readFile(plistPath, 'utf8')).resolves.toBe('new plist');
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'corrupt', 'installed'])('reports model settings only from a valid installed policy (%s)', async (policyState) => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const config = { providers: 'codex', models: {
        codex: { model: 'gpt-6-sol', effort: 'medium', maxEffort: 'high' },
      } };
      if (policyState === 'corrupt') await writeFile(paths.policy, '{');
      if (policyState === 'installed') await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Rules', lessons: '', config }));
      const status = await gateStatus({ repoRoot: 'C:\\repo' }, {
        createContext: async () => ({ repoRoot: 'C:\\repo', stateRoot, paths }),
        getHooksPath: async () => '.githooks',
        run: async () => ({ code: 1, stdout: '', stderr: process.platform === 'darwin'
          ? 'Could not find service' : 'ERROR: The system cannot find the file specified.' }),
      });
      if (policyState === 'installed') {
        expect(status.providerRequirement).toBe('codex');
        expect(status.models.codex).toEqual(config.models.codex);
        expect(status.installedPolicyError).toBeNull();
      } else {
        expect(status.providerRequirement).toBeNull();
        expect(status.models).toBeNull();
        expect(status.installedPolicyDigest).toBeNull();
        expect(Boolean(status.installedPolicyError)).toBe(policyState === 'corrupt');
      }
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('reports a persisted detached-watcher startup error in status', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await writeDaemonError(paths, new Error('installed policy version is stale'));
      const status = await gateStatus(
        { repoRoot: 'C:\\repo' },
        {
          createContext: async () => ({ repoRoot: 'C:\\repo', stateRoot, paths }),
          getHooksPath: async () => '.githooks',
          run: async () => ({
            code: 1,
            stdout: '',
            stderr: process.platform === 'darwin'
              ? 'Could not find service'
              : 'ERROR: The system cannot find the file specified.',
          }),
        },
      );

      expect(status.watcherStartupError?.message).toBe('installed policy version is stale');
      expect(status.watcherHealthy).toBe(false);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('reports corrupt persisted state without crashing review:status', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await writeFile(paths.heartbeat, '{');
      await writeFile(paths.lock, '{');
      await writeFile(paths.paused, '{');
      await writeFile(paths.queueSubmitLock, '{');

      const status = await gateStatus(
        { repoRoot: 'C:\\repo' },
        {
          createContext: async () => ({ repoRoot: 'C:\\repo', stateRoot, paths }),
          getHooksPath: async () => '.githooks',
          run: async () => ({
            code: 1,
            stdout: '',
            stderr: process.platform === 'darwin'
              ? 'Could not find service'
              : 'ERROR: The system cannot find the file specified.',
          }),
        },
      );

      expect(status.watcherHealthy).toBe(false);
      expect(status.persistedStateErrors).toMatchObject({
        heartbeat: expect.any(String),
        lock: expect.any(String),
        paused: expect.any(String),
        queueSubmitLock: expect.any(String),
      });
      expect(status.queue).toMatchObject({
        depth: 0,
        maxQueued: LIMITS.maxQueuedRequests,
        submissionOwner: null,
      });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('recovers a stale owner lock without signaling a possibly reused PID', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-install-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await atomicWriteJson(paths.lock, {
        pid: process.pid,
        ownerToken: 'old-owner',
        startedAt: '2026-08-03T10:00:00.000Z',
      });
      await atomicWriteJson(paths.heartbeat, {
        pid: process.pid,
        ownerToken: 'different-owner',
        repoRoot: 'C:\\repo',
        at: '2026-08-03T10:00:00.000Z',
      });
      const recoverResources = vi.fn(async () => 0);

      await expect(recoverStaleDaemonState({
        repoRoot: 'C:\\repo',
        paths,
      }, {
        reason: 'confirmed stale after host reboot',
        recoverResources,
      })).resolves.toMatchObject({
        recovered: true,
        previousLockPid: process.pid,
      });

      await expect(access(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(paths.heartbeat)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(recoverResources).toHaveBeenCalledWith('C:\\repo');
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
