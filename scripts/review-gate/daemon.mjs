import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CHARTER_VERSION, GATE_VERSION, LIMITS } from './constants.mjs';
import { loadInstalledReviewPolicy } from './context.mjs';
import { createGateContext, runGate } from './gate.mjs';
import { recoverStaleReviewResources } from './git.mjs';
import { syncPullRequests } from './github.mjs';
import {
  blockNewProcessLaunches,
  processTreeCleanupFailureCode,
  terminateActiveProcesses,
} from './process.mjs';
import {
  acquireDaemonLock,
  clearDaemonError,
  claimNextRequest,
  completeRequest,
  hasQueuedRequests,
  pauseGate,
  recordEvent,
  readJson,
  readPause,
  removeStoredJson,
  recoverClaims,
  sleep,
  writeHeartbeat,
  writeDaemonError,
} from './storage.mjs';

export async function loadWatcherPolicy(context) {
  return await loadInstalledReviewPolicy(context.paths);
}

export async function pauseForUnrecoverableProviderTree(
  context,
  error,
  { pause = pauseGate } = {},
) {
  const cleanupCode = processTreeCleanupFailureCode(error);
  if (!cleanupCode) {
    return false;
  }
  await pause(
    context.paths,
    cleanupCode === 'ORPHANED_PROCESS_TREE'
      ? 'Windows provider parent exited before inherited pipes closed; inspect remaining provider processes before resuming.'
      : 'Provider process-tree cleanup could not be verified; inspect remaining provider processes before resuming.',
  );
  return true;
}

export async function runWithHeartbeat(
  context,
  details,
  work,
  {
    write = writeHeartbeat,
    intervalMs = LIMITS.heartbeatMs,
    requireInitialWrite = true,
  } = {},
) {
  const heartbeatDetails = {
    repoRoot: context.repoRoot,
    ownerToken: context.daemonOwnerToken,
    ...details,
    gateVersion: GATE_VERSION,
    charterVersion: CHARTER_VERSION,
    policyDigest: context.policy?.policyDigest,
  };
  try {
    await write(context.paths, heartbeatDetails);
  } catch (error) {
    if (requireInitialWrite) throw error;
  }
  let pendingHeartbeat = null;
  const heartbeat = setInterval(() => {
    if (pendingHeartbeat) return;
    const operation = write(context.paths, heartbeatDetails)
      .catch(() => {})
      .finally(() => {
        if (pendingHeartbeat === operation) pendingHeartbeat = null;
      });
    pendingHeartbeat = operation;
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await pendingHeartbeat;
  }
}

export function detachedWatcherEnvironment(source = process.env) {
  const env = { ...source };
  return scrubLongLivedWatcherEnvironment(env);
}

export function scrubLongLivedWatcherEnvironment(environment = process.env) {
  const env = environment;
  delete env.ROVE_REVIEW_ALLOW_API_BILLING;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

export async function startDaemonDetached(
  repoRoot,
  stateRoot,
  { spawnProcess = spawn, environment = process.env } = {},
) {
  const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const args = [cliPath, 'watch', '--daemon', '--repo', repoRoot];
  if (stateRoot) args.push('--state-root', stateRoot);
  const child = spawnProcess(process.execPath, args, {
    cwd: repoRoot,
    env: detachedWatcherEnvironment(environment),
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child.pid;
}

export async function waitForWatcherDelay(milliseconds, { signal, shouldStop }) {
  try {
    await sleep(milliseconds, { signal });
  } catch (error) {
    if (!shouldStop()) throw error;
  }
}

export async function pollDaemonStopRequest(
  context,
  stop,
  { read = readJson } = {},
) {
  const request = await read(context.paths.stopRequest).catch(() => null);
  if (
    request?.pid !== process.pid ||
    request?.ownerToken !== context.daemonOwnerToken
  ) return false;
  stop();
  return true;
}

function monitorDaemonStopRequests(context, stop, { intervalMs = 250 } = {}) {
  let pending = null;
  const poll = () => {
    if (pending) return;
    const operation = pollDaemonStopRequest(context, stop)
      .catch(() => false)
      .finally(() => {
        if (pending === operation) pending = null;
      });
    pending = operation;
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

export async function handleRequestFailure(
  context,
  claim,
  error,
  {
    complete = completeRequest,
    record = recordEvent,
    pause = pauseGate,
  } = {},
) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const cleanupCode = processTreeCleanupFailureCode(failure);
  const secondaryErrors = [];
  if (cleanupCode) {
    try {
      await pauseForUnrecoverableProviderTree(context, failure, { pause });
    } catch (pauseError) {
      secondaryErrors.push(`automatic pause failed: ${pauseError?.message || String(pauseError)}`);
    }
  }
  try {
    await complete(context.paths, claim, {
      status: 'error',
      error: failure.message,
      reportId: failure.reportId || null,
    });
  } catch (persistenceError) {
    secondaryErrors.push(`request completion failed: ${persistenceError?.message || String(persistenceError)}`);
  }
  try {
    await record(context.paths, {
      type: 'request-error',
      requestId: claim.request?.id,
      message: failure.message,
    });
  } catch (persistenceError) {
    secondaryErrors.push(`error event persistence failed: ${persistenceError?.message || String(persistenceError)}`);
  }
  if (secondaryErrors.length) {
    failure.message = `${failure.message} Secondary failure(s): ${secondaryErrors.join(' | ')}`;
  }
  if (cleanupCode) throw failure;
  if (secondaryErrors.length) throw failure;
}

async function processOne(context, progress) {
  const claim = await claimNextRequest(context.paths);
  if (!claim) return false;
  return await runWithHeartbeat(
    context,
    { activity: 'review', requestId: claim.request?.id },
    async () => {
      try {
        if (claim.request?.type !== 'gate' || !claim.request.options) {
          throw new Error('Unsupported or malformed review-gate request.');
        }
        const requestContext = await createGateContext(
          claim.request.options.repoRoot || context.repoRoot,
          { stateRoot: context.stateRoot },
        );
        if (requestContext.repository !== context.repository) {
          throw new Error('Queued review checkout does not belong to the daemon repository identity.');
        }
        const result = await runGate({
          ...claim.request.options,
          repoRoot: requestContext.repoRoot,
          stateRoot: context.stateRoot,
          policy: context.policy,
          progress,
        });
        await completeRequest(context.paths, claim, { status: result.status, result });
      } catch (error) {
        await handleRequestFailure(context, claim, error);
      }
      return true;
    },
  );
}

export async function drainQueuedRequests(
  context,
  progress,
  {
    shouldStop = () => false,
    processRequest = processOne,
    readPaused = readPause,
    heartbeat = writeHeartbeat,
  } = {},
) {
  let paused = await readPaused(context.paths);
  while (!shouldStop() && !paused && await processRequest(context, progress)) {
    await heartbeat(context.paths, {
      repoRoot: context.repoRoot,
      ownerToken: context.daemonOwnerToken,
      gateVersion: GATE_VERSION,
      charterVersion: CHARTER_VERSION,
      policyDigest: context.policy?.policyDigest,
      activity: 'review',
    });
    paused = await readPaused(context.paths);
  }
  return paused;
}

export async function runWatcher({
  repoRoot = process.cwd(),
  stateRoot,
  once = false,
  github = true,
  progress = () => {},
  recoverResources = recoverStaleReviewResources,
  recoverQueuedClaims = recoverClaims,
  pause = pauseGate,
} = {}) {
  // A watcher is long-lived even when started manually in the foreground.
  // One-shot API-billing authority must never survive into later reviews.
  scrubLongLivedWatcherEnvironment(process.env);
  const context = await createGateContext(repoRoot, { stateRoot });
  try {
    context.policy = await loadWatcherPolicy(context);
    await clearDaemonError(context.paths);
    const lock = await acquireDaemonLock(context.paths);
    if (!lock) return { alreadyRunning: true, stateRoot: context.stateRoot };
    context.daemonOwnerToken = lock.ownerToken;

    let stopped = false;
    let nextGithubAt = 0;
    let githubBackoffMs = LIMITS.githubPollMs;
    let watcherBackoffMs = LIMITS.queuePollMs;
    let watcherDelayDetails = { activity: 'idle' };
    let stopTermination = null;
    let releaseProcessLaunchBlock = null;
    const stopController = new AbortController();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopController.abort(new Error('Shared review watcher stopping.'));
      releaseProcessLaunchBlock = blockNewProcessLaunches();
      stopTermination = terminateActiveProcesses();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const stopMonitoring = monitorDaemonStopRequests(context, stop);

    try {
      await recoverResources(context.repoRoot);
      await recoverQueuedClaims(context.paths);
      do {
        try {
          await writeHeartbeat(context.paths, {
            repoRoot: context.repoRoot,
            ownerToken: context.daemonOwnerToken,
            gateVersion: GATE_VERSION,
            charterVersion: CHARTER_VERSION,
            policyDigest: context.policy.policyDigest,
          });
          const paused = await drainQueuedRequests(context, progress, {
            shouldStop: () => stopped,
          });
          if (paused) {
            await writeHeartbeat(context.paths, {
              repoRoot: context.repoRoot,
              ownerToken: context.daemonOwnerToken,
              gateVersion: GATE_VERSION,
              charterVersion: CHARTER_VERSION,
              policyDigest: context.policy.policyDigest,
              activity: 'paused',
            });
          } else if (github && Date.now() >= nextGithubAt) {
            try {
              await runWithHeartbeat(
                context,
                { activity: 'github-review' },
                () => syncPullRequests({
                  context,
                  runGate: (options) => runGate({ ...options, policy: context.policy }),
                  progress,
                  shouldStop: () => stopped,
                  shouldYield: async () => (
                    Boolean(await readPause(context.paths)) ||
                    await hasQueuedRequests(context.paths)
                  ),
                }),
              );
              githubBackoffMs = LIMITS.githubPollMs;
            } catch (error) {
              await recordEvent(context.paths, {
                type: 'github-error',
                message: error?.message || String(error),
              });
              githubBackoffMs = Math.min(githubBackoffMs * 2, LIMITS.githubMaxBackoffMs);
              progress(`GitHub watcher error; retrying in ${Math.round(githubBackoffMs / 1000)}s: ${error.message}`);
            }
            nextGithubAt = Date.now() + githubBackoffMs;
          }
          watcherBackoffMs = LIMITS.queuePollMs;
          watcherDelayDetails = { activity: 'idle' };
        } catch (error) {
          if (once) throw error;
          const message = (error?.message || String(error)).slice(0, 2000);
          watcherBackoffMs = Math.min(
            Math.max(LIMITS.queuePollMs, watcherBackoffMs * 2),
            LIMITS.githubMaxBackoffMs,
          );
          await recordEvent(context.paths, {
            type: 'watcher-loop-error',
            message,
          }).catch(() => {});
          await writeHeartbeat(context.paths, {
            repoRoot: context.repoRoot,
            ownerToken: context.daemonOwnerToken,
            gateVersion: GATE_VERSION,
            charterVersion: CHARTER_VERSION,
            policyDigest: context.policy.policyDigest,
            activity: 'error',
            error: message,
          }).catch(() => {});
          watcherDelayDetails = { activity: 'error', error: message };
          progress(`Shared review watcher loop error; retrying in ${Math.round(watcherBackoffMs / 1000)}s: ${message}`);
        }
        if (!once && !stopped) {
          await runWithHeartbeat(
            context,
            watcherDelayDetails,
            () => waitForWatcherDelay(watcherBackoffMs, {
              signal: stopController.signal,
              shouldStop: () => stopped,
            }),
            { requireInitialWrite: false },
          );
        }
      } while (!once && !stopped);
      return { alreadyRunning: false, stopped, stateRoot: context.stateRoot };
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await stopMonitoring();
      await stopTermination;
      try {
        await Promise.all([
          removeStoredJson(context.paths.heartbeat),
          removeStoredJson(context.paths.stopRequest),
        ]);
      } finally {
        try {
          await lock.release();
        } finally {
          releaseProcessLaunchBlock?.();
        }
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await pauseForUnrecoverableProviderTree(context, failure, { pause }).catch((pauseError) => {
      failure.message = `${failure.message} Automatic pause also failed: ${pauseError?.message || String(pauseError)}`;
    });
    await writeDaemonError(context.paths, failure).catch(() => {});
    throw failure;
  }
}
