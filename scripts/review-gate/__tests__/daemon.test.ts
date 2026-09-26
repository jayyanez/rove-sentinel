import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  detachedWatcherEnvironment,
  drainQueuedRequests,
  handleRequestFailure,
  loadWatcherPolicy,
  pauseForUnrecoverableProviderTree,
  pollDaemonStopRequest,
  runWatcher,
  runWithHeartbeat,
  scrubLongLivedWatcherEnvironment,
  startDaemonDetached,
  waitForWatcherDelay,
} from '../daemon.mjs';
import { CHARTER_VERSION, GATE_VERSION } from '../constants.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { atomicWriteJson, ensureState, readJson, sleep } from '../storage.mjs';

describe('review watcher heartbeat coverage', () => {
  it('keeps the pause acknowledgement visible during the idle wait for updater handoff', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-pause-ack-'));
    const paths = await ensureState(stateRoot);
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: 'None' }));
    await atomicWriteJson(paths.paused, { reason: 'Updater handoff in progress' });
    const pending = runWatcher({ repoRoot: process.cwd(), stateRoot, github: false,
      recoverResources: async () => {}, recoverQueuedClaims: async () => {} });
    try {
      const deadline = Date.now() + 5000;
      while (!await readJson(paths.heartbeat) && Date.now() < deadline) await sleep(20);
      await sleep(150);
      expect(await readJson(paths.heartbeat)).toMatchObject({ activity: 'paused' });
    } finally {
      const owner = await readJson(paths.lock);
      if (owner) await atomicWriteJson(paths.stopRequest, { pid: owner.pid, ownerToken: owner.ownerToken });
      await pending;
      await rm(stateRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it('pauses an unverified tree before request-state persistence can fail', async () => {
    const calls: string[] = [];
    const pause = vi.fn(async () => { calls.push('pause'); });
    const complete = vi.fn(async () => {
      calls.push('complete');
      throw new Error('state volume full');
    });
    const record = vi.fn(async () => { calls.push('record'); });
    const error = Object.assign(new Error('provider termination failed'), {
      code: 'TERMINATED',
      terminationError: { code: 'PROCESS_TREE_CLEANUP_FAILED' },
    });

    await expect(handleRequestFailure(
      { paths: {} },
      { request: { id: 'request-1' } },
      error,
      { pause, complete, record },
    )).rejects.toBe(error);

    expect(calls).toEqual(['pause', 'complete', 'record']);
    expect(error.message).toContain('state volume full');
  });

  it('accepts only a stop request for the current PID and owner token', async () => {
    const stop = vi.fn();
    const context = {
      daemonOwnerToken: 'current-owner',
      paths: { stopRequest: 'stop-request' },
    };

    await expect(pollDaemonStopRequest(context, stop, {
      read: async () => ({ pid: process.pid, ownerToken: 'other-owner' }),
    })).resolves.toBe(false);
    await expect(pollDaemonStopRequest(context, stop, {
      read: async () => ({ pid: process.pid, ownerToken: 'current-owner' }),
    })).resolves.toBe(true);

    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not persist one-shot API billing authority in a detached watcher', () => {
    expect(detachedWatcherEnvironment({
      ROVE_REVIEW_ALLOW_API_BILLING: '1',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: 'openai-key',
      PATH: 'safe-path',
    })).toEqual({ PATH: 'safe-path' });
  });

  it('strips one-shot API billing authority from an in-process watcher environment', () => {
    const environment = {
      ROVE_REVIEW_ALLOW_API_BILLING: '1',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: 'openai-key',
      PATH: 'safe-path',
    };

    expect(scrubLongLivedWatcherEnvironment(environment)).toEqual({ PATH: 'safe-path' });
    expect(environment).toEqual({ PATH: 'safe-path' });
  });

  it('scrubs the real inherited environment before a foreground watcher can review', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-daemon-test-'));
    const previous = {
      override: process.env.ROVE_REVIEW_ALLOW_API_BILLING,
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    };
    process.env.ROVE_REVIEW_ALLOW_API_BILLING = '1';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    try {
      await expect(runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true, github: false,
      })).rejects.toThrow('has no installed policy snapshot');
      expect(process.env.ROVE_REVIEW_ALLOW_API_BILLING).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries({
        ROVE_REVIEW_ALLOW_API_BILLING: previous.override,
        ANTHROPIC_API_KEY: previous.anthropic,
        OPENAI_API_KEY: previous.openai,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('reports detached watcher spawn failure without an unhandled error event', async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn() });
    const pending = startDaemonDetached('C:\\repo', 'C:\\state', {
      spawnProcess: () => child,
    });
    const failure = new Error('spawn denied');
    child.emit('error', failure);

    await expect(pending).rejects.toBe(failure);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('pauses automatic work after an unrecoverable Windows provider orphan', async () => {
    const pause = vi.fn(async () => {});
    const context = { paths: {} };

    await expect(pauseForUnrecoverableProviderTree(
      context,
      Object.assign(new Error('orphan'), { code: 'ORPHANED_PROCESS_TREE' }),
      { pause },
    )).resolves.toBe(true);
    expect(pause).toHaveBeenCalledWith(
      context.paths,
      expect.stringContaining('inspect remaining provider processes'),
    );
  });

  it('pauses automatic work after any unverified provider cleanup', async () => {
    const pause = vi.fn(async () => {});
    const context = { paths: {} };

    await expect(pauseForUnrecoverableProviderTree(
      context,
      Object.assign(new Error('review timed out while cleanup failed'), {
        code: 'TIMEOUT',
        terminationError: { code: 'PROCESS_TREE_CLEANUP_FAILED' },
      }),
      { pause },
    )).resolves.toBe(true);
    expect(pause).toHaveBeenCalledWith(
      context.paths,
      expect.stringContaining('cleanup could not be verified'),
    );
  });

  it('interrupts a long watcher backoff during controlled shutdown', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopping'));
    await expect(waitForWatcherDelay(60_000, {
      signal: controller.signal,
      shouldStop: () => true,
    })).resolves.toBeUndefined();

    await expect(waitForWatcherDelay(60_000, {
      signal: controller.signal,
      shouldStop: () => false,
    })).rejects.toThrow('stopping');
  });

  it('refreshes the heartbeat throughout a long operation', async () => {
    let resolveThirdWrite: () => void = () => {};
    const thirdWrite = new Promise<void>((resolve) => { resolveThirdWrite = resolve; });
    const write = vi.fn(async () => {
      if (write.mock.calls.length >= 3) resolveThirdWrite();
    });
    const context = {
      repoRoot: 'C:\\repo',
      daemonOwnerToken: 'owner',
      paths: {},
      policy: { policyDigest: 'd'.repeat(64) },
    };

    await runWithHeartbeat(
      context,
      { activity: 'github-review' },
      () => thirdWrite,
      { write, intervalMs: 5 },
    );

    expect(write.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(write).toHaveBeenLastCalledWith(context.paths, {
      repoRoot: context.repoRoot,
      ownerToken: context.daemonOwnerToken,
      gateVersion: GATE_VERSION,
      charterVersion: CHARTER_VERSION,
      policyDigest: context.policy.policyDigest,
      activity: 'github-review',
    });
  });

  it('joins an in-flight heartbeat write before the operation tears down', async () => {
    let releaseHeartbeat: () => void = () => {};
    const delayedHeartbeat = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    let beginWork: () => void = () => {};
    const workStarted = new Promise<void>((resolve) => { beginWork = resolve; });
    const write = vi.fn(async () => {
      if (write.mock.calls.length === 1) return;
      beginWork();
      await delayedHeartbeat;
    });
    const context = {
      repoRoot: 'C:\\repo',
      daemonOwnerToken: 'owner',
      paths: {},
      policy: { policyDigest: 'd'.repeat(64) },
    };
    const pending = runWithHeartbeat(
      context,
      { activity: 'review' },
      async () => {
        await workStarted;
        return 'done';
      },
      { write, intervalMs: 5 },
    );
    let settled = false;
    void pending.finally(() => { settled = true; });
    await workStarted;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
    releaseHeartbeat();
    await expect(pending).resolves.toBe('done');
  });

  it('keeps a retry backoff alive when its initial diagnostic heartbeat cannot be written', async () => {
    const work = vi.fn(async () => 'retried');
    const result = await runWithHeartbeat(
      {
        repoRoot: 'C:\\repo',
        daemonOwnerToken: 'owner',
        paths: {},
        policy: { policyDigest: 'd'.repeat(64) },
      },
      { activity: 'error', error: 'heartbeat storage unavailable' },
      work,
      {
        write: vi.fn(async () => { throw new Error('disk unavailable'); }),
        requireInitialWrite: false,
      },
    );

    expect(result).toBe('retried');
    expect(work).toHaveBeenCalledOnce();
  });
});

describe('review watcher queue control', () => {
  it('pauses when startup recovery has an unverified process-tree cleanup', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-daemon-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await atomicWriteJson(paths.policy, reviewPolicySnapshot({
        charter: '# Installed charter\n', lessons: '# Installed lessons\n',
      }));
      const pause = vi.fn(async () => {});
      const error = Object.assign(new Error('startup git cleanup timed out'), {
        code: 'TIMEOUT',
        terminationError: { code: 'PROCESS_TREE_CLEANUP_FAILED' },
      });

      await expect(runWatcher({
        repoRoot: process.cwd(),
        stateRoot,
        once: true,
        github: false,
        recoverResources: async () => { throw error; },
        recoverQueuedClaims: vi.fn(async () => {}),
        pause,
      })).rejects.toBe(error);

      expect(pause).toHaveBeenCalledWith(
        paths,
        expect.stringContaining('cleanup could not be verified'),
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('persists a reused-PID lock failure that happens after policy load', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-daemon-test-'));
    try {
      const paths = await ensureState(stateRoot);
      await atomicWriteJson(paths.policy, reviewPolicySnapshot({
        charter: '# Installed charter\n', lessons: '# Installed lessons\n',
      }));
      await atomicWriteJson(paths.lock, {
        pid: process.pid,
        ownerToken: 'stale-owner',
        startedAt: new Date().toISOString(),
      });

      await expect(runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true, github: false,
      })).rejects.toThrow('possibly reused PID');
      await expect(readJson(paths.daemonError)).resolves.toMatchObject({
        message: expect.stringContaining('possibly reused PID'),
      });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('re-reads pause state before starting the next queued review', async () => {
    const context = {
      repoRoot: 'C:\\repo', daemonOwnerToken: 'owner', paths: {},
    };
    let paused = false;
    const processRequest = vi.fn(async () => {
      paused = true;
      return true;
    });

    await expect(drainQueuedRequests(context, () => {}, {
      processRequest,
      readPaused: async () => paused ? { reason: 'operator pause' } : null,
      heartbeat: vi.fn(async () => {}),
    })).resolves.toEqual({ reason: 'operator pause' });

    expect(processRequest).toHaveBeenCalledTimes(1);
  });

  it('loads installed policy without reading the mutable owner checkout', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-daemon-test-'));
    try {
      const paths = await ensureState(stateRoot);
      const snapshot = reviewPolicySnapshot({
        charter: '# Installed charter\n',
        lessons: '# Installed lessons\n',
      });
      await atomicWriteJson(paths.policy, snapshot);

      await expect(loadWatcherPolicy({
        repoRoot: path.join(stateRoot, 'missing-checkout'),
        paths,
      })).resolves.toMatchObject(snapshot);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
