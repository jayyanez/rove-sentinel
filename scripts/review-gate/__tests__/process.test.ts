import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  blockNewProcessLaunches,
  providerCleanupFailureDetail,
  providerCleanupFailureLatched,
  resetProviderCleanupLatch,
  runProcess,
  terminateActiveProcesses,
  terminateProcessTree,
} from '../process.mjs';
import { LIMITS } from '../constants.mjs';

describe('bounded review subprocesses', () => {
  it('captures a successful bounded result', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      timeoutMs: 5_000,
      maxOutputBytes: 100,
    });
    expect(result).toMatchObject({ code: 0, stdout: 'ok' });
  });

  it('fails closed when a missing command also receives standard input', async () => {
    await expect(runProcess('rove-command-that-does-not-exist', [], {
      input: 'payload',
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ name: 'ProcessError' });
  });

  it('waits for inherited stdout pipes to close before resolving', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("late"), 100)'], {
        stdio: ['ignore', 'inherit', 'ignore'],
      });
      process.stdout.write('early');
    `;
    const result = await runProcess(process.execPath, ['-e', script], {
      timeoutMs: 5_000,
      maxOutputBytes: 100,
    });
    expect(result.stdout).toBe('earlylate');
  });

  it('does not treat large stderr as an output-limit failure', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stderr.write("y".repeat(1000)); process.stdout.write("ok")'],
      {
        timeoutMs: 5_000,
        maxOutputBytes: 100,
      },
    );
    expect(result).toMatchObject({ code: 0, stdout: 'ok' });
    expect(result.stderr.length).toBeGreaterThan(100);
  });

  it('attaches captured stdout to timeout errors so providers can salvage JSON', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.stdout.write("{\\"ok\\":true}"); setTimeout(() => {}, 30000)'], {
        // Include Node startup on a contended Windows CI host. The child
        // deliberately outlives this budget, so timeout capture is still tested.
        timeoutMs: 5_000,
        maxOutputBytes: 1000,
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      result: { stdout: '{"ok":true}' },
    });
  });

  it('terminates output that exceeds the configured bound', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], {
        timeoutMs: 5_000,
        maxOutputBytes: 100,
        outputLimitMessage: 'Split this oversized review input.',
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT', message: 'Split this oversized review input.' });
  });

  it('surfaces bounded stderr on failure', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.stderr.write("actionable failure"); process.exit(3)'], {
        timeoutMs: 5_000,
        maxOutputBytes: 100,
      }),
    ).rejects.toThrow('actionable failure');
  });

  it('terminates active provider trees when the watcher is asked to stop', async () => {
    const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 60_000,
      maxOutputBytes: 100,
    });
    const rejected = expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await terminateActiveProcesses();
    await rejected;
  });

  it('rejects processes launched after watcher shutdown begins', async () => {
    const release = blockNewProcessLaunches();
    try {
      await expect(runProcess(process.execPath, ['-e', 'process.exit(0)']))
        .rejects.toMatchObject({ code: 'TERMINATED' });
      await expect(runProcess(process.execPath, ['-e', 'process.exit(0)'], {
        allowDuringShutdown: true,
      })).resolves.toMatchObject({ code: 0 });
    } finally {
      release();
    }
    await expect(runProcess(process.execPath, ['-e', 'process.exit(0)']))
      .resolves.toMatchObject({ code: 0 });
  });

  it('rejects an active Windows run even when its exited parent tree cannot be recovered', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-process-test-'));
    const marker = path.join(root, 'processes.json');
    let descendantPid;
    try {
      const script = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
          detached: true,
          stdio: ['ignore', 'inherit', 'ignore'],
        });
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ parentPid: process.pid, descendantPid: child.pid }));
        child.unref();
      `;
      const pending = runProcess(process.execPath, ['-e', script], {
        timeoutMs: 60_000,
        maxOutputBytes: 100,
      });
      let processes;
      await vi.waitFor(async () => {
        processes = JSON.parse(await readFile(marker, 'utf8'));
        expect(() => process.kill(processes.parentPid, 0)).toThrow();
      }, { timeout: 5_000, interval: 25 });
      descendantPid = processes.descendantPid;

      await terminateActiveProcesses();

      await expect(pending).rejects.toThrow('exited before its inherited pipes closed');
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('escalates a POSIX process group that ignores SIGTERM to SIGKILL', async () => {
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() };
    const killProcess = vi.fn();
    const waitForExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await terminateProcessTree(child, {
      platform: 'linux',
      killProcess,
      waitForExit,
      graceMs: 1,
    });

    expect(killProcess.mock.calls).toEqual([
      [-123, 'SIGTERM'],
      [-123, 'SIGKILL'],
    ]);
    expect(waitForExit).toHaveBeenCalledTimes(2);
  });

  it('still terminates a POSIX process group after the direct child has exited', async () => {
    const child = { pid: 123, exitCode: 0, signalCode: null, kill: vi.fn() };
    const killProcess = vi.fn();
    const waitForExit = vi.fn().mockResolvedValue(true);

    await terminateProcessTree(child, {
      platform: 'linux', killProcess, waitForExit, graceMs: 1,
    });

    expect(killProcess).toHaveBeenCalledWith(-123, 'SIGTERM');
    expect(waitForExit).toHaveBeenCalledOnce();
  });

  it('fails closed when Windows taskkill reports a nonzero exit', async () => {
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() };
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnProcess = vi.fn(() => killer);
    const pending = terminateProcessTree(child, {
      platform: 'win32',
      spawnProcess,
      waitForNaturalClose: vi.fn(async () => false),
      waitForWindowsExit: vi.fn(async () => false),
      isWindowsProcessAlive: vi.fn(() => true),
      graceMs: 100,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    killer.emit('exit', 5, null);

    await expect(pending).rejects.toThrow('taskkill failed');
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('fails closed instead of claiming Windows can kill a tree after its parent exited', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: 0, signalCode: null, kill: vi.fn(),
    });
    const spawnProcess = vi.fn();

    await expect(terminateProcessTree(child, {
      platform: 'win32', spawnProcess, graceMs: 100,
    })).rejects.toMatchObject({ code: 'ORPHANED_PROCESS_TREE' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('accepts a normal Windows exit-to-close transition before declaring an orphan', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: 0, signalCode: null, kill: vi.fn(),
    });
    const spawnProcess = vi.fn();
    const pending = terminateProcessTree(child, {
      platform: 'win32',
      spawnProcess,
      isWindowsProcessAlive: vi.fn(() => false),
      graceMs: 100,
    });
    setTimeout(() => child.emit('close', 0, null), 0);

    await expect(pending).resolves.toBeUndefined();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('gives taskkill its own time to end a busy provider tree, separate from the exit grace', async () => {
    // A timed-out Codex tree took taskkill longer than the 2-second grace on a
    // loaded host, and the cleanup fence then closed the whole gate (1.11.1).
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() };
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnProcess = vi.fn(() => killer);
    const pending = terminateProcessTree(child, {
      platform: 'win32',
      spawnProcess,
      waitForNaturalClose: vi.fn(async () => false),
      waitForWindowsExit: vi.fn(async () => true),
      isWindowsProcessAlive: vi.fn(() => true),
      graceMs: 20,
      taskkillTimeoutMs: 2_000,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 150));
    killer.emit('exit', 0, null);
    await expect(pending).resolves.toBeUndefined();
    expect(killer.kill).not.toHaveBeenCalled();
    expect(LIMITS.taskkillTimeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  it('still fails closed when taskkill outlasts its own bound', async () => {
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() };
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    await expect(terminateProcessTree(child, {
      platform: 'win32',
      spawnProcess: vi.fn(() => killer),
      waitForNaturalClose: vi.fn(async () => false),
      isWindowsProcessAlive: vi.fn(() => true),
      graceMs: 20,
      taskkillTimeoutMs: 50,
    })).rejects.toThrow('taskkill timed out');
    expect(killer.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('verifies the Windows provider process exited after taskkill succeeds', async () => {
    const child = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() };
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const waitForWindowsExit = vi.fn(async () => false);
    const spawnProcess = vi.fn(() => killer);
    const pending = terminateProcessTree(child, {
      platform: 'win32',
      spawnProcess,
      waitForNaturalClose: vi.fn(async () => false),
      waitForWindowsExit,
      isWindowsProcessAlive: vi.fn(() => true),
      graceMs: 100,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    killer.emit('exit', 0, null);

    await expect(pending).rejects.toThrow('remained alive');
    expect(waitForWindowsExit).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('treats Windows EPERM as a still-live process after taskkill', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123, exitCode: null, signalCode: null, kill: vi.fn(),
    });
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const accessDenied = Object.assign(new Error('access denied'), { code: 'EPERM' });
    const killProcess = vi.fn(() => { throw accessDenied; });
    const spawnProcess = vi.fn(() => killer);
    const pending = terminateProcessTree(child, {
      platform: 'win32',
      spawnProcess,
      waitForNaturalClose: vi.fn(async () => false),
      isWindowsProcessAlive: vi.fn(() => true),
      killProcess,
      graceMs: 100,
    });
    const rejection = expect(pending).rejects.toThrow('remained alive');
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    killer.emit('exit', 0, null);

    await rejection;
  });
});

describe('provider cleanup latch (PR #519)', () => {
  const overflowingChild = [process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))']] as const;
  const failingTerminate = async () => {
    throw Object.assign(new Error('Provider process 4242 exited before its inherited pipes closed.'), {
      code: 'ORPHANED_PROCESS_TREE',
    });
  };

  it('latches on a cleanup failure and names the process that raised it', async () => {
    resetProviderCleanupLatch();
    try {
      await expect(runProcess(...overflowingChild, {
        timeoutMs: 5_000,
        maxOutputBytes: 100,
        terminateTree: failingTerminate,
      })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
      expect(providerCleanupFailureLatched()).toBe(true);
      expect(providerCleanupFailureDetail()).toContain(process.execPath);
      expect(providerCleanupFailureDetail()).toMatch(/\(pid \d+\): Provider process 4242 exited/);
    } finally {
      resetProviderCleanupLatch();
    }
  });

  it('leaves the fence down for a best-effort read-only sweep, with the same rejection', async () => {
    resetProviderCleanupLatch();
    await expect(runProcess(...overflowingChild, {
      timeoutMs: 5_000,
      maxOutputBytes: 100,
      terminateTree: failingTerminate,
      latchCleanupFailure: false,
    })).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      terminationError: { code: 'ORPHANED_PROCESS_TREE' },
    });
    expect(providerCleanupFailureLatched()).toBe(false);
    expect(providerCleanupFailureDetail()).toBeNull();
  });

  it('keeps the FIRST latching process when several cleanups fail', async () => {
    const { latchProviderCleanupFailure } = await import('../process.mjs');
    resetProviderCleanupLatch();
    try {
      latchProviderCleanupFailure({ command: 'codex', pid: 11, reason: 'first' });
      latchProviderCleanupFailure({ command: 'claude', pid: 22, reason: 'second' });
      expect(providerCleanupFailureDetail()).toBe('codex (pid 11): first');
    } finally {
      resetProviderCleanupLatch();
    }
  });
});
