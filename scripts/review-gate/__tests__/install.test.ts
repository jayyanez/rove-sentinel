import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CHARTER_VERSION, GATE_VERSION, LIMITS } from '../constants.mjs';
import {
  buildInstallPlan,
  windowsTaskRun,
  daemonSignalPid,
  executeUninstall,
  executeInstallTransaction,
  gateStatus,
  heartbeatIsHealthy,
  recoverStaleDaemonState,
  schedulerQueryInstalled,
  stopDaemon,
  verifyPrerequisites,
} from '../install.mjs';
import { atomicWriteJson, ensureState, readJson, writeDaemonError } from '../storage.mjs';

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
      repoRoot: 'D:\\Workspaces\\rove',
      stateRoot: 'C:\\state',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      home: 'C:\\Users\\me',
      uid: null,
    });
    expect(plan.taskName).toMatch(/^Rove-Shared-Review-Gate-[a-f0-9]{8}$/);
    expect(plan.create.command).toBe('schtasks.exe');
    expect(plan.create.args).toContain('ONLOGON');
    expect(plan.stop.args).toContain('/End');
    expect(plan.create.args.join(' ')).toContain('watch.cmd');
    expect(plan.create.args.join(' ').length).toBeLessThan(261);
    expect(plan.wrapper).toContain('"watch" "--daemon"');
    expect(plan.wrapper).toContain('set "ROVE_REVIEW_ALLOW_API_BILLING="');
    expect(plan.wrapper).toContain('set "ANTHROPIC_API_KEY="');
    expect(plan.wrapper).toContain('set "OPENAI_API_KEY="');
    expect(plan.create.args.join(' ')).not.toContain('powershell');
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
      repoRoot: 'D:\\Workspaces\\rove',
      stateRoot: 'C:\\Users\\me\\AppData\\Local\\Rove\\shared-review-gate\\e931f2b632fde04a',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      home: 'C:\\Users\\me',
      uid: null,
      systemRoot: 'C:\\WINDOWS',
    });
    const taskRun = plan.create.args[plan.create.args.indexOf('/TR') + 1];
    expect(taskRun).toBe('"C:\\WINDOWS\\System32\\conhost.exe" --headless cmd.exe /d /c "C:\\Users\\me\\AppData\\Local\\Rove\\shared-review-gate\\e931f2b632fde04a\\watch.cmd"');
    expect(taskRun.length).toBeLessThanOrEqual(261);
    expect(plan.installRefusal).toBeNull();
  });

  it('refuses, never falls back to a window, for a path the headless command cannot carry', () => {
    const longState = `C:\\${'deep\\'.repeat(40)}state`;
    const long = windowsTaskRun(`${longState}\\watch.cmd`, 'C:\\WINDOWS');
    expect(long.taskRun).toContain('--headless');
    expect(long.refusal).toMatch(/over schtasks' 261-character limit/);
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
      repoRoot: 'D:\\Workspaces\\rove',
      stateRoot: 'C:\\state',
      nodePath: 'C:\\node.exe',
      home: 'C:\\Users\\me',
      uid: null,
    });
    const git = vi.fn(async () => '');
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    await expect(executeUninstall({
      context: { repoRoot: 'D:\\Workspaces\\rove' },
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
