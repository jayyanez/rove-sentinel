import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

// Set only in the detached child: the log that receives its exit marker.
export const DETACHED_LOG_ENV = 'ROVE_REVIEW_GATE_DETACHED_LOG';
export const EXIT_MARKER_PREFIX = '[review-gate] exit';

/**
 * The gate arguments without the flags that only the launching process reads:
 * `--detach`, `--log <path>` and a bare `--` separator (pnpm passes it through
 * literally on some hosts).
 */
export function stripDetachFlags(args) {
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--detach' || value === '--') continue;
    if (value === '--log') {
      index += 1;
      continue;
    }
    kept.push(value);
  }
  return kept;
}

/**
 * `<repo>/output/review-gate-<UTC stamp with ms>-<launcher pid>.log` — the
 * worktree's ignored task-log folder. The pid keeps two launches in the same
 * millisecond apart; the default log is also created exclusively.
 */
export function defaultDetachLogPath(repoRoot, now = new Date(), launcherPid = process.pid) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '-').replace('T', '-');
  return path.join(repoRoot, 'output', `review-gate-${stamp}-${launcherPid}.log`);
}

/**
 * Start `node cli.mjs gate …` as a detached background process with no
 * console window, stdout and stderr appended to `logPath`, and return at once.
 *
 * Why this exists: a long gate outlives an agent tool call, and the ad hoc
 * way to detach it on Windows — `Start-Process cmd.exe "/c npx --no-install rove-sentinel gate …"`
 * — opens a new console window (a Windows Terminal window when that is the
 * default terminal) that takes the foreground from whatever the user is
 * typing into, then closes again (measured 2026-09-22). `detached` gives the
 * child no console at all, and every process the gate starts goes through
 * `runProcess` with `windowsHide`, so none of them shows a window either.
 */
export async function startDetachedGate({
  cliPath,
  args,
  cwd,
  logPath,
  // A caller-chosen --log may be appended to on purpose; the default name is
  // unique, so it is created exclusively and never shared with another run.
  exclusive = false,
  env = process.env,
  spawnProcess = spawn,
}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, exclusive ? 'wx' : 'a');
  try {
    const child = spawnProcess(process.execPath, [cliPath, 'gate', ...stripDetachFlags(args)], {
      cwd,
      env: { ...env, [DETACHED_LOG_ENV]: logPath },
      detached: true,
      shell: false,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { pid: child.pid, log: logPath };
  } finally {
    closeSync(fd);
  }
}

/**
 * In the detached child: append the final exit code to its log, so a caller
 * polling the log can tell "finished" from "still running" and read the
 * verdict from the same file. Synchronous because it runs on process `exit`.
 */
export function appendDetachedExitMarker(logPath, code) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `\n${EXIT_MARKER_PREFIX} ${code}\n`);
  } catch {
    // The log vanished (its worktree was removed): nothing left to tell.
  }
}
