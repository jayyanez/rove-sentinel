import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  nextGithubStreak,
  runWithHeartbeat,
  scrubLongLivedWatcherEnvironment,
  startDaemonDetached,
  waitForWatcherDelay,
} from '../daemon.mjs';
import { CHARTER_VERSION, GATE_VERSION } from '../constants.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { atomicWriteJson, ensureState, readGithubStreak, readJson, sleep, writeGithubFailure } from '../storage.mjs';

describe('a watcher whose GitHub polls keep failing', () => {
  it('counts a poll that rejected without a reason as a failure', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-github-noreason-'));
    const paths = await ensureState(stateRoot);
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));
    try {
      await runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true,
        syncPulls: () => Promise.reject(undefined),
        recoverResources: async () => {}, recoverQueuedClaims: async () => {},
      });
      expect(await readJson(paths.githubFailure)).toMatchObject({ count: 1, message: 'The GitHub poll failed without a reason.' });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps count of the failures in a row, the first one\'s time and the last reason, until a poll succeeds', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-github-failure-'));
    const paths = await ensureState(stateRoot);
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));
    const poll = (syncPulls: () => Promise<void>) => runWatcher({
      repoRoot: process.cwd(), stateRoot, once: true, syncPulls,
      recoverResources: async () => {}, recoverQueuedClaims: async () => {},
    });
    try {
      await poll(async () => { throw new Error('Could not start gh: spawn gh ENOENT'); });
      const first = await readJson(paths.githubFailure);
      expect(first).toMatchObject({ count: 1, message: 'Could not start gh: spawn gh ENOENT' });
      await poll(async () => { throw new Error('a later reason'); });
      expect(await readJson(paths.githubFailure)).toMatchObject({ count: 2, since: first.since, message: 'a later reason' });
      await poll(async () => {});
      expect(await readJson(paths.githubFailure)).toBeNull();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('a watcher whose events folder cannot be written', () => {
  it('still records the GitHub failure, and with its own reason', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-github-events-'));
    const paths = await ensureState(stateRoot);
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));
    try {
      await runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true,
        // The events folder breaks while the poll runs (a file now stands
        // where it was), so the watcher's own event write fails.
        syncPulls: async () => {
          await rm(paths.events, { recursive: true, force: true });
          await writeFile(paths.events, 'not a folder');
          throw new Error('GitHub refused the comment');
        },
        recoverResources: async () => {}, recoverQueuedClaims: async () => {},
      });
      expect(await readJson(paths.githubFailure)).toMatchObject({ count: 1, message: 'GitHub refused the comment' });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('a watcher whose GitHub failure record cannot be written or removed', () => {
  async function watcherState() {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-github-record-'));
    const paths = await ensureState(stateRoot);
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));
    // A folder stands where the failure record is: writing or removing it fails.
    await mkdir(paths.githubFailure, { recursive: true });
    return { stateRoot, paths };
  }
  const githubErrors = async (paths: { events: string }) => (await Promise.all((await readdir(paths.events))
    .map(async (name) => JSON.parse(await readFile(path.join(paths.events, name), 'utf8')))))
    .filter((event: { type?: string }) => event.type === 'github-error');

  it('keeps a poll that succeeded a success', async () => {
    const { stateRoot, paths } = await watcherState();
    try {
      await runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true, syncPulls: async () => {},
        recoverResources: async () => {}, recoverQueuedClaims: async () => {},
      });
      expect(await githubErrors(paths)).toEqual([]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps a poll that failed a GitHub error, not a storage one', async () => {
    const { stateRoot, paths } = await watcherState();
    const progress: string[] = [];
    try {
      await runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true, progress: (line: string) => progress.push(line),
        syncPulls: async () => { throw new Error('GitHub refused the comment'); },
        recoverResources: async () => {}, recoverQueuedClaims: async () => {},
      });
      expect((await githubErrors(paths)).map((event: { message: string }) => event.message)).toEqual(['GitHub refused the comment']);
      // The backoff was set: the watcher says when it retries.
      expect(progress.some((line) => /^GitHub watcher error; retrying in \d+s: GitHub refused the comment$/.test(line))).toBe(true);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('the GitHub failure streak a watcher keeps', () => {
  const at = new Date('2026-01-01T10:00:00.000Z');
  it('counts each failure since the first, and ends with a success', () => {
    expect(nextGithubStreak(null, true, at)).toEqual({ count: 1, since: '2026-01-01T10:00:00.000Z' });
    expect(nextGithubStreak({ count: 2, since: '2026-01-01T09:00:00.000Z' }, true, at)).toEqual({ count: 3, since: '2026-01-01T09:00:00.000Z' });
    expect(nextGithubStreak({ count: 2, since: '2026-01-01T09:00:00.000Z' }, false, at)).toBeNull();
    // A record a success could not remove is no longer the streak: the next
    // failure starts again from the streak the success ended.
    expect(nextGithubStreak(nextGithubStreak({ count: 5, since: 'old' }, false, at), true, at)).toEqual({ count: 1, since: '2026-01-01T10:00:00.000Z' });
  });

  it('keeps a failure whose record could not be written in the next write', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-github-streak-'));
    const paths = await ensureState(stateRoot);
    try {
      // The first failure's write fails; the watcher's own count goes on.
      await mkdir(paths.githubFailure, { recursive: true });
      let streak = nextGithubStreak(null, true, new Date('2026-01-01T10:00:00.000Z'));
      await expect(writeGithubFailure(paths, new Error('first'), streak)).rejects.toThrow();
      await rm(paths.githubFailure, { recursive: true, force: true });
      streak = nextGithubStreak(streak, true, new Date('2026-01-01T10:05:00.000Z'));
      await writeGithubFailure(paths, new Error('second'), streak, new Date('2026-01-01T10:05:00.000Z'));
      expect(await readJson(paths.githubFailure)).toMatchObject({ count: 2, since: '2026-01-01T10:00:00.000Z', message: 'second' });
      expect(await readGithubStreak(paths)).toEqual({ count: 2, since: '2026-01-01T10:00:00.000Z' });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('reads no streak from a missing or malformed record, and an unknown one from a record it cannot read', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-github-streak-read-'));
    const paths = await ensureState(stateRoot);
    try {
      expect(await readGithubStreak(paths)).toBeNull();
      await atomicWriteJson(paths.githubFailure, { schemaVersion: 1, count: 'two' });
      expect(await readGithubStreak(paths)).toBeNull();
      // Corrupt text is no record: the next write replaces it.
      await writeFile(paths.githubFailure, '{ "count": 3,');
      expect(await readGithubStreak(paths)).toBeNull();
      // A record that cannot be read is unknown, and the watcher leaves it.
      await rm(paths.githubFailure, { force: true });
      await mkdir(paths.githubFailure, { recursive: true });
      expect(await readGithubStreak(paths)).toBeUndefined();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe('a computer whose watcher leaves GitHub alone', () => {
  async function pollsGitHub(options?: { github: boolean; pending?: { github: boolean; pid: number; until: number } }) {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-no-github-'));
    const paths = await ensureState(stateRoot);
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));
    if (options) await atomicWriteJson(paths.watcherOptions, options);
    const syncPulls = vi.fn(async () => {});
    try {
      await runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true, syncPulls,
        recoverResources: async () => {}, recoverQueuedClaims: async () => {},
      });
      return syncPulls.mock.calls.length > 0;
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }

  it('reviews no pull request once installed with --no-github, whoever starts it', async () => {
    expect(await pollsGitHub({ github: false })).toBe(false);
  });

  it('stops a synchronization under way once the choice is made', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-no-github-'));
    const paths = await ensureState(stateRoot);
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));
    const yields: boolean[] = [];
    const syncPulls = vi.fn(async ({ shouldYield }: { shouldYield: () => Promise<boolean> }) => {
      yields.push(await shouldYield());
      await atomicWriteJson(paths.watcherOptions, { github: false });
      yields.push(await shouldYield());
    });
    try {
      await runWatcher({
        repoRoot: process.cwd(), stateRoot, once: true, syncPulls,
        recoverResources: async () => {}, recoverQueuedClaims: async () => {},
      });
      expect(yields).toEqual([false, true]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('polls GitHub by default, and after installing again without the flag', async () => {
    expect(await pollsGitHub()).toBe(true);
    expect(await pollsGitHub({ github: true })).toBe(true);
  });

  it('honours an install under way from the first poll, and forgets one that was killed', async () => {
    const until = Date.now() + 60_000;
    expect(await pollsGitHub({ github: true, pending: { github: false, pid: process.pid, until } })).toBe(false);
    // a live process past the time an install can last has reused the id
    expect(await pollsGitHub({ github: true, pending: { github: false, pid: process.pid, until: Date.now() - 1 } })).toBe(true);
    // an id no process can hold: a finished child's id can be reused at once
    const dead = 2 ** 31 - 2;
    expect(await pollsGitHub({ github: true, pending: { github: false, pid: dead, until } })).toBe(true);
    expect(await pollsGitHub({ github: false, pending: { github: true, pid: dead, until } })).toBe(false);
  });
});

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
      expect.stringContaining('Run: npx --no-install rove-sentinel repair'),
      expect.objectContaining({ kind: 'provider-cleanup' }),
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
      expect.objectContaining({ kind: 'provider-cleanup' }),
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
        expect.objectContaining({ kind: 'provider-cleanup' }),
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
