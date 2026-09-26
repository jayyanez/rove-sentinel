import { spawn } from 'node:child_process';

import { LIMITS } from './constants.mjs';

const activeChildren = new Map();
let processLaunchBlocks = 0;

export class ProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProcessError';
    Object.assign(this, details);
  }
}

export function processTreeCleanupFailureCode(error) {
  if (
    error?.code === 'ORPHANED_PROCESS_TREE' ||
    error?.terminationError?.code === 'ORPHANED_PROCESS_TREE'
  ) return 'ORPHANED_PROCESS_TREE';
  if (
    error?.code === 'PROCESS_TREE_CLEANUP_FAILED' ||
    error?.terminationError
  ) return 'PROCESS_TREE_CLEANUP_FAILED';
  return null;
}

export function blockNewProcessLaunches() {
  processLaunchBlocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    processLaunchBlocks = Math.max(0, processLaunchBlocks - 1);
  };
}

/** Whether the shutdown fence is up. Queued reviewer lanes consult this so
 *  they drain instead of spawning tasks that would each fail (and retry)
 *  against the launch block. */
export function newProcessLaunchesBlocked() {
  return processLaunchBlocks > 0;
}

// Latched at the exact moment a provider process-tree cleanup fails, BEFORE
// the rejection unwinds to any caller. Reviewer lanes consult it before
// dequeuing, which closes the race where a sibling lane finishes and pulls a
// new task while the failure is still propagating toward the pool's local
// halt flag. Reset at the start of each review run: the cross-run policy
// (watcher pause until operator recovery) is handled by the daemon, and a
// sticky latch would make every later review in a resumed watcher fail.
// The first latch records WHICH process raised it: a launch refusal that
// cannot name its cause sends the operator hunting (PR #519 lost two rounds to
// a refusal whose origin had been swallowed three frames earlier).
let providerCleanupFailure = null;

export function latchProviderCleanupFailure({ command, pid, reason } = {}) {
  providerCleanupFailure ??= {
    command: command ? String(command) : 'unknown process',
    pid: Number.isInteger(pid) ? pid : null,
    reason: reason ? String(reason) : 'process-tree cleanup failed',
  };
}

export function providerCleanupFailureLatched() {
  return providerCleanupFailure !== null;
}

/** One line naming the process whose cleanup raised the latch, or null. */
export function providerCleanupFailureDetail() {
  if (!providerCleanupFailure) return null;
  const { command, pid, reason } = providerCleanupFailure;
  return `${command}${pid === null ? '' : ` (pid ${pid})`}: ${reason}`;
}

export function resetProviderCleanupLatch() {
  providerCleanupFailure = null;
}

export function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  if (env.ROVE_REVIEW_ALLOW_API_BILLING !== '1') {
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  return env;
}

async function waitForPosixTreeExit(child, pid, timeoutMs, killProcess = process.kill) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let groupAlive = false;
    try {
      killProcess(-pid, 0);
      groupAlive = true;
    } catch {
      groupAlive = false;
    }
    const childAlive = child.exitCode === null && child.signalCode == null;
    if (!groupAlive && !childAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForWindowsProcessExit(_child, pid, timeoutMs, killProcess = process.kill) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let processAlive = false;
    try {
      killProcess(pid, 0);
      processAlive = true;
    } catch (error) {
      processAlive = error?.code === 'EPERM';
    }
    if (!processAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function windowsProcessIsAlive(pid, killProcess = process.kill) {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForChildClose(child, timeoutMs) {
  return await new Promise((resolve) => {
    let finished = false;
    const finish = (closed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

function killChildBestEffort(child) {
  if (child.exitCode !== null) return;
  try {
    child.kill();
  } catch {}
}

function releaseChildHandles(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref?.();
  activeChildren.delete(child);
}

export async function terminateProcessTree(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    killProcess = process.kill,
    waitForExit = waitForPosixTreeExit,
    waitForWindowsExit = waitForWindowsProcessExit,
    waitForNaturalClose = waitForChildClose,
    isWindowsProcessAlive = windowsProcessIsAlive,
    graceMs = 2_000,
  } = {},
  ) {
  if (!child.pid) return;
  if (platform === 'win32') {
    const throwOrphanedTree = () => {
      const error = new Error(`Provider process ${child.pid} exited before its inherited pipes closed. Windows can no longer identify that process tree by the recorded parent PID; stop the watcher and inspect remaining provider processes before retrying.`);
      error.code = 'ORPHANED_PROCESS_TREE';
      throw error;
    };
    // `exit` precedes `close` for a normal piped child. Give both an already-
    // exited child and a still-running child the same bounded chance to prove
    // inherited stdio closed before classifying the tree or invoking taskkill.
    if (await waitForNaturalClose(
      child,
      Math.min(graceMs, 100),
    )) return;
    if (child.exitCode !== null || !isWindowsProcessAlive(child.pid, killProcess)) {
      throwOrphanedTree();
    }
    try {
      await new Promise((resolve, reject) => {
        const killer = spawnProcess(
          'taskkill.exe',
          ['/pid', String(child.pid), '/t', '/f'],
          { stdio: 'ignore', windowsHide: true },
        );
        let finished = false;
        const finish = (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => {
          try {
            killer.kill();
          } catch {}
          finish(new Error(`taskkill timed out while terminating provider process tree ${child.pid}.`));
        }, graceMs);
        killer.once('error', (error) => {
          finish(new Error(`Could not start taskkill for provider process tree ${child.pid}: ${error.message}`));
        });
        killer.once('exit', (code, signal) => {
          if (code === 0) finish();
          else finish(new Error(`taskkill failed for provider process tree ${child.pid} with ${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}.`));
        });
      });
    } catch (error) {
      killChildBestEffort(child);
      throw error;
    }
    if (!await waitForWindowsExit(child, child.pid, graceMs, killProcess)) {
      killChildBestEffort(child);
      throw new Error(`Provider process ${child.pid} remained alive after taskkill reported success.`);
    }
    return;
  }
  const send = (signal) => {
    try {
      killProcess(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  send('SIGTERM');
  if (await waitForExit(child, child.pid, graceMs, killProcess)) return;
  send('SIGKILL');
  if (!await waitForExit(child, child.pid, graceMs, killProcess)) {
    throw new Error(`Provider process tree ${child.pid} did not exit after SIGTERM and SIGKILL.`);
  }
}

export async function terminateActiveProcesses() {
  await Promise.allSettled(
    [...activeChildren.values()].map((terminate) => terminate()),
  );
}

export async function runProcess(
  command,
  args,
  {
    cwd,
    env = process.env,
    input,
    timeoutMs = 60_000,
    maxOutputBytes = LIMITS.maxProcessOutputBytes,
    maxStderrBytes = LIMITS.maxProcessStderrBytes,
    allowFailure = false,
    allowDuringShutdown = false,
    outputLimitMessage,
    // Return stdout as a Buffer instead of a UTF-8 string (binary-safe reads
    // such as `git cat-file -p` of an image blob).
    binary = false,
    // A cleanup failure normally latches the provider launch fence (§5): an
    // unverified PROVIDER tree may still be acting. Best-effort read-only
    // evidence sweeps opt out — a `git grep` that outran its output bound and
    // exited before its pipes drained is not a provider tree, and latching on
    // it skipped every reviewer of the run (PR #519). The rejection itself is
    // unchanged; only the run-wide fence is left alone.
    latchCleanupFailure = true,
    // Test seam: the process-tree terminator the error paths call.
    terminateTree = terminateProcessTree,
  } = {},
) {
  if (processLaunchBlocks > 0 && !allowDuringShutdown) {
    throw new ProcessError(`Shared review watcher stopped before launching ${command}.`, {
      code: 'TERMINATED',
      command,
    });
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let overflowed = false;
    let timedOut = false;

    const decodeStdout = () => (binary ? Buffer.concat(stdout) : Buffer.concat(stdout).toString('utf8'));
    const snapshot = () => ({
      stdout: decodeStdout(),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });

    const finishError = async (message, details) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let terminationError;
      try {
        await terminateTree(child);
      } catch (error) {
        terminationError = error;
        if (latchCleanupFailure) {
          latchProviderCleanupFailure({ command, pid: child.pid, reason: error?.message });
        }
        releaseChildHandles(child);
      }
      reject(new ProcessError(
        terminationError
          ? `${message}. Process-tree cleanup also failed: ${terminationError.message}`
          : message,
        { result: snapshot(), ...details, terminationError },
      ));
    };

    const captureStdout = (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        overflowed = true;
        void finishError(outputLimitMessage || `${command} exceeded its ${maxOutputBytes}-byte output limit`, {
          code: 'OUTPUT_LIMIT',
          command,
        });
        return;
      }
      stdout.push(chunk);
    };

    const captureStderr = (chunk) => {
      if (settled) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > maxStderrBytes && stderr.length > 1) {
        const dropped = stderr.shift();
        stderrBytes -= dropped.length;
      }
    };

    child.stdout.on('data', captureStdout);
    child.stderr.on('data', captureStderr);
    child.stdin?.once('error', (error) => {
      void finishError(`Could not write input to ${command}: ${error.message}`, {
        code: 'STDIN_ERROR',
        command,
        cause: error,
      });
    });
    child.once('error', (error) => {
      activeChildren.delete(child);
      void finishError(`Could not start ${command}: ${error.message}`, {
        code: 'SPAWN_ERROR',
        command,
        cause: error,
      });
    });
    child.once('close', (code, signal) => {
      activeChildren.delete(child);
      if (settled || overflowed || timedOut) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        signal,
        stdout: decodeStdout(),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (result.code !== 0 && !allowFailure) {
        const detail = String(result.stderr || result.stdout).trim().slice(0, 2000);
        reject(
          new ProcessError(`${command} exited with code ${result.code}${detail ? `: ${detail}` : ''}`, {
            code: 'NON_ZERO_EXIT',
            command,
            result,
          }),
        );
        return;
      }
      resolve(result);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void finishError(`${command} exceeded its ${timeoutMs}ms time limit`, {
        code: 'TIMEOUT',
        command,
      });
    }, timeoutMs);
    timer.unref?.();
    activeChildren.set(child, () => finishError(`Shared review watcher stopped ${command}.`, {
      code: 'TERMINATED',
      command,
    }));

    if (!child.stdin) {
      void finishError(`Could not open standard input for ${command}.`, {
        code: 'STDIN_ERROR',
        command,
      });
    } else if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
