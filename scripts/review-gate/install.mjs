import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHARTER_VERSION, GATE_VERSION, LIMITS, TASK_PREFIX } from './constants.mjs';
import { readReviewPolicy, reviewPolicySnapshot } from './context.mjs';
import { detachedWatcherEnvironment, startDaemonDetached } from './daemon.mjs';
import { createGateContext } from './gate.mjs';
import { recoverStaleReviewResources, runGit } from './git.mjs';
import { runProcess } from './process.mjs';
import { uninstallGeneratedHook } from './init.mjs';
import {
  daemonOwnerIsHealthy,
  atomicWriteJson,
  clearDaemonError,
  clearTechnicalErrorOutcomes,
  hashText,
  pauseGate,
  readJson,
  reviewTimingSummary,
  removeStoredJson,
  recordEvent,
  recoverClaims,
  resumeGate,
  sleep,
  waitForDaemonHeartbeat,
} from './storage.mjs';

function quoteWindows(value) {
  if (value.includes('"')) throw new Error(`Unsupported quote in scheduled-task argument: ${value}`);
  return `"${value}"`;
}

// `schtasks /Create /TR` refuses a task-run value longer than this.
const SCHTASKS_MAX_TASK_RUN = 261;

/**
 * The scheduled task's command. An ONLOGON "interactive only" task that runs a
 * console program gets a console WINDOW — the watcher's `watch.cmd` kept one
 * open for the whole session, and every (re)start created a new one that took
 * the foreground from whatever the user was typing into (measured 2026-09-22
 * with Windows Terminal as the default terminal). `conhost.exe --headless`
 * (the ConPTY host, Windows 10 1809 and later) hosts the same console with no
 * window at all, and stays the task's process so the task still reads as
 * Running. Measured on Windows Server 2025: no window, no foreground change,
 * the script runs.
 *
 * There is no windowed fallback: a path this command cannot carry is an
 * install refusal, never a window. `%` is refused because Task Scheduler and
 * `cmd.exe /c` would both expand it; the length bound is `schtasks /TR`'s.
 */
export function windowsTaskRun(wrapperPath, systemRoot) {
  const conhost = path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
  const taskRun = `${quoteWindows(conhost)} --headless cmd.exe /d /c ${quoteWindows(wrapperPath)}`;
  let refusal = null;
  if (wrapperPath.includes('%')) {
    refusal = `The review watcher's state path contains "%", which Task Scheduler and cmd.exe would expand as an environment variable: ${wrapperPath}. Point LOCALAPPDATA at a path without "%" and rerun npx --no-install rove-sentinel install.`;
  } else if (taskRun.length > SCHTASKS_MAX_TASK_RUN) {
    refusal = `The review watcher's task command is ${taskRun.length} characters, over schtasks' ${SCHTASKS_MAX_TASK_RUN}-character limit, because its state path is too long: ${wrapperPath}. Point LOCALAPPDATA at a shorter path and rerun npx --no-install rove-sentinel install.`;
  }
  return { taskRun, refusal };
}

function quoteBatch(value) {
  if (value.includes('"')) throw new Error(`Unsupported quote in batch argument: ${value}`);
  return `"${value.replaceAll('%', '%%')}"`;
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildInstallPlan({
  platform,
  repoRoot,
  stateRoot,
  nodePath = process.execPath,
  home = os.homedir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  systemRoot = process.env.SystemRoot,
  localAppData = process.env.LOCALAPPDATA,
  autoUpdate = process.env.ROVE_SENTINEL_AUTO_UPDATE,
  updateNotifications = process.env.ROVE_SENTINEL_UPDATE_NOTIFICATIONS,
}) {
  const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const id = hashText(stateRoot.toLowerCase(), 8);
  const taskName = `${TASK_PREFIX}-${id}`;
  if (platform === 'win32') {
    const wrapperPath = path.win32.join(stateRoot, 'watch.cmd');
    const stateEnvironment = [
      ['LOCALAPPDATA', localAppData], ['ROVE_SENTINEL_AUTO_UPDATE', autoUpdate],
      ['ROVE_SENTINEL_UPDATE_NOTIFICATIONS', updateNotifications],
    ].filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `set ${quoteBatch(`${key}=${value}`)}\r\n`).join('');
    const wrapper = `@echo off\r\n${stateEnvironment}set "ROVE_REVIEW_ALLOW_API_BILLING="\r\nset "ANTHROPIC_API_KEY="\r\nset "OPENAI_API_KEY="\r\n${[
      nodePath,
      cliPath,
      'watch',
      '--daemon',
      '--repo',
      repoRoot,
    ].map(quoteBatch).join(' ')}\r\n`;
    const { taskRun, refusal } = windowsTaskRun(wrapperPath, systemRoot);
    return {
      platform,
      taskName,
      wrapperPath,
      wrapper,
      // Uninstall and status still need the task name for such a path, so the
      // refusal is carried, and installGate enforces it before any change.
      installRefusal: refusal,
      create: {
        command: 'schtasks.exe',
        args: ['/Create', '/TN', taskName, '/SC', 'ONLOGON', '/TR', taskRun, '/RL', 'LIMITED', '/F'],
      },
      start: { command: 'schtasks.exe', args: ['/Run', '/TN', taskName] },
      stop: { command: 'schtasks.exe', args: ['/End', '/TN', taskName] },
      query: { command: 'schtasks.exe', args: ['/Query', '/TN', taskName, '/FO', 'LIST'] },
      remove: { command: 'schtasks.exe', args: ['/Delete', '/TN', taskName, '/F'] },
    };
  }
  if (platform === 'darwin') {
    const label = `com.rove.shared-review-gate.${id}`;
    const plistPath = path.posix.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(nodePath)}</string><string>${xmlEscape(cliPath)}</string>
    <string>watch</string><string>--daemon</string><string>--repo</string><string>${xmlEscape(repoRoot)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(repoRoot)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>ROVE_REVIEW_ALLOW_API_BILLING</key><string></string>
    <key>ANTHROPIC_API_KEY</key><string></string>
    <key>OPENAI_API_KEY</key><string></string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
    return {
      platform,
      label,
      plistPath,
      plist,
      create: { command: 'launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] },
      start: { command: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] },
      stop: { command: 'launchctl', args: ['kill', 'SIGTERM', `gui/${uid}/${label}`] },
      query: { command: 'launchctl', args: ['print', `gui/${uid}/${label}`] },
      remove: { command: 'launchctl', args: ['bootout', `gui/${uid}/${label}`] },
    };
  }
  return { platform, taskName, unsupportedScheduler: true, stateRoot };
}

async function currentHooksPath(repoRoot) {
  const result = await runGit(repoRoot, ['config', '--get', 'core.hooksPath'], {
    allowFailure: true,
    result: true,
  });
  return result.code === 0 ? result.stdout.trim() : '';
}

export async function verifyPrerequisites(
  repoRoot,
  { run = runProcess, env: sourceEnvironment = process.env } = {},
) {
  const env = detachedWatcherEnvironment(sourceEnvironment);
  const probe = async (label, command, args) => {
    let result;
    try {
      result = await run(command, args, {
        cwd: repoRoot,
        env,
        timeoutMs: 30_000,
        allowFailure: true,
      });
    } catch (error) {
      throw new Error(`${label} could not be launched: ${error?.message || String(error)}`, {
        cause: error,
      });
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || 'no diagnostic output').trim().slice(0, 1_000);
      throw new Error(`${label} failed with exit ${result.code}: ${detail}`);
    }
    return result;
  };
  const [claudeVersion, codexVersion, gitVersion, github, claudeAuth, codexAuth] = await Promise.all([
    probe('Claude Code version check', 'claude', ['--version']),
    probe('Codex version check', 'codex', ['--version']),
    probe('Git version check', 'git', ['--version']),
    probe('GitHub CLI authentication check', 'gh', ['auth', 'status']),
    probe('Claude Code authentication check', 'claude', ['auth', 'status']),
    probe('Codex authentication check', 'codex', ['login', 'status']),
  ]);
  let claudeStatus;
  try {
    claudeStatus = JSON.parse(claudeAuth.stdout);
  } catch (error) {
    throw new Error('Claude Code authentication status returned invalid JSON. Run `claude auth status` and update Claude Code before retrying `npx --no-install rove-sentinel install`.', {
      cause: error,
    });
  }
  if (
    !claudeStatus ||
    typeof claudeStatus !== 'object' ||
    Array.isArray(claudeStatus) ||
    typeof claudeStatus.loggedIn !== 'boolean' ||
    typeof claudeStatus.authMethod !== 'string'
  ) {
    throw new Error('Claude Code authentication status returned an unexpected shape. Run `claude auth status` and update Claude Code before retrying `npx --no-install rove-sentinel install`.');
  }
  const codexAuthText = codexAuth.stdout || codexAuth.stderr;
  if (!claudeStatus.loggedIn) throw new Error('Claude Code is not authenticated.');
  if (claudeStatus.authMethod !== 'claude.ai') {
    throw new Error('Claude Code is not authenticated through a Claude subscription.');
  }
  if (!/logged in/i.test(codexAuthText)) throw new Error('Codex is not authenticated.');
  if (!/logged in using chatgpt/i.test(codexAuthText)) {
    throw new Error('Codex is not authenticated through ChatGPT.');
  }
  const firstLine = (result) =>
    (result.stdout || result.stderr).split(/\r?\n/).find(Boolean) || 'available';
  return {
    claude: `${firstLine(claudeVersion)}; Claude ${claudeStatus.subscriptionType || 'subscription'}`,
    codex: `${firstLine(codexVersion)}; ChatGPT`,
    git: firstLine(gitVersion),
    gh: firstLine(github),
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function heartbeatIsHealthy(
  heartbeat,
  repoRoot,
  maxAgeMs = 30_000,
  { isAlive = processIsAlive, now = Date.now } = {},
) {
  const ageMs = now() - Date.parse(heartbeat?.at);
  return Boolean(
    heartbeat?.repoRoot === repoRoot &&
    heartbeat?.gateVersion === GATE_VERSION &&
    heartbeat?.charterVersion === CHARTER_VERSION &&
    isAlive(heartbeat.pid) &&
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs <= maxAgeMs,
  );
}

export function daemonSignalPid(heartbeat, lock, repoRoot, options = {}) {
  return heartbeat?.repoRoot === repoRoot && daemonOwnerIsHealthy(lock, heartbeat, {
    ...options,
    maxAgeMs: 60_000,
  })
    ? heartbeat.pid
    : null;
}

export async function stopDaemon(
  context,
  {
    platform = process.platform,
    kill = process.kill,
    isAlive = processIsAlive,
    writeStopRequest = atomicWriteJson,
    delay = sleep,
    timeoutMs = 30_000,
  } = {},
) {
  const heartbeat = await readRequiredState(context.paths.heartbeat, 'watcher heartbeat');
  if (heartbeat?.repoRoot && heartbeat.repoRoot !== context.repoRoot) return false;
  const lock = await readRequiredState(context.paths.lock, 'watcher lock');
  const signalPid = daemonSignalPid(heartbeat, lock, context.repoRoot, { isAlive });
  if (!signalPid && (isAlive(heartbeat?.pid) || isAlive(lock?.pid))) {
    throw new Error('Refusing to signal or unlock a live PID without a fresh matching daemon owner heartbeat.');
  }
  if (signalPid) {
    if (platform === 'win32') {
      await writeStopRequest(context.paths.stopRequest, {
        pid: signalPid,
        ownerToken: lock.ownerToken,
        requestedAt: new Date().toISOString(),
      });
    } else {
      try {
        kill(signalPid, 'SIGTERM');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    const started = Date.now();
    while (isAlive(signalPid) && Date.now() - started < timeoutMs) {
      await delay(100);
    }
    if (isAlive(signalPid)) {
      throw new Error(`Review watcher process ${signalPid} did not stop.`);
    }
  }
  const currentLock = await readRequiredState(context.paths.lock, 'watcher lock');
  if (currentLock) {
    if (
      currentLock.pid !== lock?.pid ||
      currentLock.ownerToken !== lock?.ownerToken
    ) {
      throw new Error('The review watcher lock changed ownership during shutdown; preserving the replacement owner state.');
    }
    if (isAlive(currentLock.pid)) {
      throw new Error(`Review watcher process ${currentLock.pid} remains alive; preserving its mutual-exclusion lock.`);
    }
    // The old lock still excludes a replacement daemon. Remove its auxiliary
    // state first and the lock last, so no newly acquired owner can have its
    // heartbeat or stop request deleted by this shutdown.
    await Promise.all([
      removeStoredJson(context.paths.heartbeat),
      removeStoredJson(context.paths.stopRequest),
    ]);
    await rm(context.paths.lock, { force: true });
  }
  await recoverStaleReviewResources(context.repoRoot);
  return true;
}

async function assertNoOtherCheckoutDaemon(context) {
  const [heartbeat, lock] = await Promise.all([
    readRequiredState(context.paths.heartbeat, 'watcher heartbeat'),
    readRequiredState(context.paths.lock, 'watcher lock'),
  ]);
  const active = daemonOwnerIsHealthy(lock, heartbeat);
  if (active && heartbeat.repoRoot !== context.repoRoot) {
    throw new Error(`The shared review watcher is already running from another checkout: ${heartbeat.repoRoot}. Uninstall or stop it there before installing from ${context.repoRoot}.`);
  }
  return active;
}

async function readRequiredState(target, label) {
  try {
    return await readJson(target);
  } catch (error) {
    throw new Error(`The persisted ${label} at ${target} is unreadable: ${error?.message || String(error)} Inspect npx --no-install rove-sentinel status, then use npx --no-install rove-sentinel recover only after confirming the owner is stale.`);
  }
}

async function readStatusState(target) {
  try {
    return { value: await readJson(target), error: null };
  } catch (error) {
    return { value: null, error: error?.message || String(error) };
  }
}

async function snapshotFile(target) {
  try {
    return { existed: true, contents: await readFile(target) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { existed: false, contents: null };
    throw error;
  }
}

async function restoreFile(target, snapshot, { storedJson = false } = {}) {
  if (storedJson) await removeStoredJson(target);
  if (!snapshot.existed) {
    if (!storedJson) await rm(target, { force: true });
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, snapshot.contents, { mode: 0o600 });
}

export function schedulerQueryInstalled(plan, result) {
  if (result.code === 0) return true;
  const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  const provesAbsent = plan.platform === 'win32'
    ? /cannot find (?:the file specified|the task)|does not exist/i.test(detail)
    : plan.platform === 'darwin'
      ? /could not find service|service not found|no such process/i.test(detail)
      : false;
  if (provesAbsent) return false;
  throw new Error(`Could not determine whether the shared review scheduler registration already exists: ${detail || `exit ${result.code}`}`);
}

function hooksPathIsOurs(repoRoot, value) {
  if (!value) return false;
  if (value.replaceAll('\\', '/') === '.githooks') return true;
  return path.resolve(repoRoot, value) === path.join(repoRoot, '.githooks');
}

export async function installGate({ repoRoot = process.cwd(), dryRun = false, start = true, preservePolicy = false } = {}) {
  const context = await createGateContext(repoRoot);
  const previousDaemonActive = await assertNoOtherCheckoutDaemon(context);
  const hook = path.join(context.repoRoot, '.githooks', 'pre-push');
  await access(hook);
  const current = await currentHooksPath(context.repoRoot);
  if (!current) await assertDefaultHookAbsent(context.repoRoot);
  if (current && !hooksPathIsOurs(context.repoRoot, current)) {
    throw new Error(`Refusing to replace existing core.hooksPath=${current}. Integrate the Sentinel pre-push hook deliberately first.`);
  }
  const plan = buildInstallPlan({
    platform: process.platform,
    repoRoot: context.repoRoot,
    stateRoot: context.stateRoot,
  });
  if (plan.installRefusal) throw new Error(plan.installRefusal);
  const prerequisites = await verifyPrerequisites(context.repoRoot);
  const policy = preservePolicy
    ? await policyForEngineUpgrade(context.paths)
    : reviewPolicySnapshot(await readReviewPolicy(context.repoRoot));
  if (dryRun) return { dryRun: true, hooksPath: '.githooks', prerequisites, plan };

  return await executeInstallTransaction({
    context,
    plan,
    policy,
    currentHooks: current,
    prerequisites,
    previousDaemonActive,
    start,
  });
}

/** Upgrade executable/bundled policy only; a worktree cannot supply new project rules. */
export async function policyForEngineUpgrade(paths) {
  const previous = await readRequiredState(paths.policy, 'installed policy');
  if (previous?.schemaVersion !== 1 || typeof previous.charter !== 'string' || typeof previous.lessons !== 'string'
    || !previous.config || !previous.gateVersion || !previous.charterVersion) throw new Error('No valid installed policy to preserve.');
  const digest = hashText([
    `charter-version:${previous.charterVersion}`, `gate-version:${previous.gateVersion}`,
    previous.charter, previous.lessons, JSON.stringify(previous.config),
  ].join('\0'), 64);
  if (digest !== previous.policyDigest) throw new Error('Installed policy is corrupt; automatic upgrade refused.');
  const charter = previous.config.charter === null
    ? await readFile(new URL('../../templates/charter.md', import.meta.url), 'utf8') : previous.charter;
  return reviewPolicySnapshot({ charter, lessons: previous.lessons, config: previous.config });
}

export async function assertDefaultHookAbsent(repoRoot) {
  const hookPath = await runGit(repoRoot, ['rev-parse', '--git-path', 'hooks/pre-push']);
  const absolute = path.resolve(repoRoot, hookPath.trim());
  try {
    await access(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Existing Git pre-push hook at ${absolute} would be shadowed by .githooks. Integrate it before installing Sentinel.`);
}

export async function executeInstallTransaction(
  {
    context,
    plan,
    policy,
    currentHooks,
    prerequisites = {},
    previousDaemonActive = false,
    start = true,
  },
  {
    run = runProcess,
    git = runGit,
    stop = stopDaemon,
    startDetached = startDaemonDetached,
    waitHeartbeat = waitForDaemonHeartbeat,
  } = {},
) {
  // A task this command cannot express is refused before anything changes:
  // never a windowed watcher as a fallback.
  if (plan.installRefusal) throw new Error(plan.installRefusal);
  const schedulerWasInstalled = plan.unsupportedScheduler
    ? false
    : schedulerQueryInstalled(plan, await run(plan.query.command, plan.query.args, {
      allowFailure: true,
      timeoutMs: 30_000,
    }));
  if (!start && previousDaemonActive) {
    const installedPolicy = await readJson(context.paths.policy);
    if (!installedPolicy || installedPolicy.policyDigest !== policy.policyDigest) {
      throw new Error('Cannot replace the installed review policy with --no-start while a watcher is active. Re-run npx --no-install rove-sentinel install without --no-start so the watcher is replaced and verifies the new policy.');
    }
  }
  const artifactPath = plan.platform === 'win32'
    ? plan.wrapperPath
    : plan.platform === 'darwin'
      ? plan.plistPath
      : null;
  const [policyBefore, artifactBefore] = await Promise.all([
    snapshotFile(context.paths.policy),
    artifactPath ? snapshotFile(artifactPath) : Promise.resolve(null),
  ]);
  const configuredHooks = !currentHooks;
  let schedulerCreated = false;
  let schedulerCreateAttempted = false;
  let schedulerLoadedByAttempt = false;
  let schedulerRemovedForReplacement = false;
  let schedulerStoppedForReplacement = false;
  let daemonStartAttempted = false;
  let hooksConfiguredByAttempt = false;
  let previousDaemonStopped = false;

  try {
    if (start && plan.platform === 'darwin' && schedulerWasInstalled) {
      schedulerRemovedForReplacement = true;
      await run(plan.remove.command, plan.remove.args, { timeoutMs: 120_000 });
    }
    if (start && previousDaemonActive) {
      const stopped = await stop(context);
      if (stopped === false) {
        throw new Error('The existing review watcher belongs to a different checkout and was not stopped.');
      }
      previousDaemonStopped = true;
      if (plan.platform === 'win32') {
        await run(plan.stop.command, plan.stop.args, { allowFailure: true, timeoutMs: 30_000 });
        schedulerStoppedForReplacement = true;
      }
    }

    await atomicWriteJson(context.paths.policy, policy);
    if (configuredHooks) {
      await git(context.repoRoot, ['config', 'core.hooksPath', '.githooks']);
      hooksConfiguredByAttempt = true;
    }
    if (start) await clearDaemonError(context.paths);
    if (plan.platform === 'win32') {
      await mkdir(path.dirname(plan.wrapperPath), { recursive: true });
      await writeFile(plan.wrapperPath, plan.wrapper, { encoding: 'utf8', mode: 0o600 });
      schedulerCreated = !schedulerWasInstalled;
      schedulerCreateAttempted = true;
      await run(plan.create.command, plan.create.args, { timeoutMs: 120_000 });
      if (start) {
        daemonStartAttempted = true;
        await run(plan.start.command, plan.start.args, { timeoutMs: 120_000 });
      }
    } else if (plan.platform === 'darwin') {
      await mkdir(path.dirname(plan.plistPath), { recursive: true });
      await writeFile(plan.plistPath, plan.plist, { encoding: 'utf8', mode: 0o600 });
      if (start) {
        schedulerCreated = !schedulerWasInstalled;
        schedulerLoadedByAttempt = true;
        await run(plan.create.command, plan.create.args, { timeoutMs: 120_000 });
        daemonStartAttempted = true;
        await run(plan.start.command, plan.start.args, { timeoutMs: 120_000 });
      }
    } else if (start) {
      daemonStartAttempted = true;
      await startDetached(context.repoRoot, context.stateRoot);
    }
    const heartbeat = start ? await waitHeartbeat(context.paths, context.repoRoot, {
      policyDigest: policy.policyDigest,
    }) : null;
    return {
      dryRun: false,
      hooksPath: '.githooks',
      prerequisites,
      plan,
      stateRoot: context.stateRoot,
      heartbeat,
      replacedWatcher: previousDaemonStopped,
      schedulerActivation: plan.unsupportedScheduler
        ? start ? 'detached' : 'not-started'
        : plan.platform === 'darwin' && !start && !schedulerWasInstalled
          ? 'next-login'
          : start
            ? 'started'
            : 'registered',
    };
  } catch (error) {
    const rollbackErrors = [];
    const attempt = async (operation) => {
      try {
        await operation();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError?.message || String(rollbackError));
      }
    };

    let attemptedDaemonStopped = false;
    if (daemonStartAttempted) {
      try {
        attemptedDaemonStopped = await stop(context) !== false;
        if (!attemptedDaemonStopped) {
          rollbackErrors.push('The attempted watcher belongs to a different checkout and was not stopped.');
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError?.message || String(rollbackError));
      }
    }
    if (daemonStartAttempted && !attemptedDaemonStopped) {
      throw new Error(`${error?.message || String(error)} Rollback could not safely stop the attempted watcher, so its scheduler registration, wrapper, policy, and hook were preserved for inspection: ${rollbackErrors.join(' | ')}`, {
        cause: error,
      });
    }
    if (daemonStartAttempted && plan.platform === 'win32' && attemptedDaemonStopped) {
      await attempt(() => run(plan.stop.command, plan.stop.args, { allowFailure: true, timeoutMs: 30_000 }));
    } else if (daemonStartAttempted && plan.platform === 'darwin' && schedulerLoadedByAttempt) {
      await attempt(() => run(plan.remove.command, plan.remove.args, { allowFailure: true, timeoutMs: 30_000 }));
      schedulerLoadedByAttempt = false;
    }
    if (plan.platform === 'win32' && schedulerCreated) {
      await attempt(() => run(plan.remove.command, plan.remove.args, { allowFailure: true, timeoutMs: 30_000 }));
    } else if (plan.platform === 'darwin' && schedulerLoadedByAttempt) {
      await attempt(() => run(plan.remove.command, plan.remove.args, { allowFailure: true, timeoutMs: 30_000 }));
    }
    await attempt(() => restoreFile(context.paths.policy, policyBefore, { storedJson: true }));
    if (artifactPath) await attempt(() => restoreFile(artifactPath, artifactBefore));

    if (
      plan.platform === 'win32' &&
      schedulerWasInstalled &&
      (schedulerCreateAttempted || schedulerStoppedForReplacement)
    ) {
      if (schedulerCreateAttempted) {
        await attempt(() => run(plan.create.command, plan.create.args, { timeoutMs: 120_000 }));
      }
      if (previousDaemonStopped) {
        await attempt(() => run(plan.start.command, plan.start.args, { timeoutMs: 120_000 }));
      }
    } else if (plan.platform === 'darwin' && schedulerWasInstalled && schedulerRemovedForReplacement) {
      await attempt(() => run(plan.create.command, plan.create.args, { timeoutMs: 120_000 }));
      if (previousDaemonStopped) {
        await attempt(() => run(plan.start.command, plan.start.args, { timeoutMs: 120_000 }));
      }
    } else if (previousDaemonStopped && !schedulerWasInstalled) {
      await attempt(async () => { await startDetached(context.repoRoot, context.stateRoot); });
    }
    if (hooksConfiguredByAttempt) {
      await attempt(() => git(context.repoRoot, ['config', '--unset', 'core.hooksPath'], { allowFailure: true }));
    }
    if (rollbackErrors.length) {
      throw new Error(`${error?.message || String(error)} Rollback also failed: ${rollbackErrors.join(' | ')}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function uninstallGate({ repoRoot = process.cwd(), dryRun = false } = {}) {
  const context = await createGateContext(repoRoot);
  await assertNoOtherCheckoutDaemon(context);
  const plan = buildInstallPlan({
    platform: process.platform,
    repoRoot: context.repoRoot,
    stateRoot: context.stateRoot,
  });
  const current = await currentHooksPath(context.repoRoot);
  if (dryRun) return { dryRun: true, hooksPath: current, preserveHooksPath: true, plan };
  await executeUninstall({ context, plan, removeHooks: false });
  const hookCleanup = await uninstallGeneratedHook(context.repoRoot);
  return { dryRun: false, hookCleanup, preserveHooksPath: true, plan,
    ...(hookCleanup === 'manual' ? { next: 'Remove the Sentinel call from your custom pre-push hook before the next push; it was preserved.' } : {}),
  };
}

export async function executeUninstall({
  context,
  plan,
  removeHooks,
  run = runProcess,
  stop = stopDaemon,
  removeFile = rm,
  git = runGit,
}) {
  const errors = [];
  const attempt = async (label, operation) => {
    try {
      await operation();
      return true;
    } catch (error) {
      errors.push(`${label}: ${error?.message || String(error)}`);
      return false;
    }
  };
  const removeScheduler = async () => {
    const result = await run(plan.remove.command, plan.remove.args, {
      allowFailure: true,
      timeoutMs: 120_000,
    });
    if (result?.code !== 0) schedulerQueryInstalled(plan, result);
  };
  if (plan.platform === 'win32') {
    const watcherStopped = await attempt('watcher stop', () => stop(context));
    if (watcherStopped) {
      await attempt('scheduler stop', () => run(plan.stop.command, plan.stop.args, { allowFailure: true, timeoutMs: 120_000 }));
      await attempt('scheduler removal', removeScheduler);
      await attempt('wrapper removal', () => removeFile(plan.wrapperPath, { force: true }));
    }
  } else if (plan.platform === 'darwin') {
    await attempt('scheduler removal', removeScheduler);
    await attempt('watcher stop', () => stop(context));
    await attempt('launch-agent file removal', () => removeFile(plan.plistPath, { force: true }));
  } else {
    await attempt('watcher stop', () => stop(context));
  }
  if (removeHooks && errors.length === 0) {
    await attempt('Git hook removal', () => git(context.repoRoot, ['config', '--unset', 'core.hooksPath'], { allowFailure: true }));
  }
  if (errors.length) {
    const hookState = removeHooks ? 'the Git hook was preserved' : 'no owned Git hook was changed';
    throw new Error(`Shared review gate uninstall was incomplete; ${hookState}: ${errors.join(' | ')}`);
  }
}

export async function gateStatus(
  { repoRoot = process.cwd() } = {},
  {
    createContext = createGateContext,
    getHooksPath = currentHooksPath,
    run = runProcess,
  } = {},
) {
  const context = await createContext(repoRoot);
  const hooksPath = await getHooksPath(context.repoRoot);
  const [heartbeatState, lockState, daemonErrorState, pausedState, queueSubmitLockState] = await Promise.all([
    readStatusState(context.paths.heartbeat),
    readStatusState(context.paths.lock),
    readStatusState(context.paths.daemonError),
    readStatusState(context.paths.paused),
    readStatusState(context.paths.queueSubmitLock),
  ]);
  const heartbeat = heartbeatState.value;
  const lock = lockState.value;
  const daemonError = daemonErrorState.value;
  const paused = pausedState.value;
  let queueDepth = null;
  let queueReadError = null;
  try {
    queueDepth = (await readdir(context.paths.requests, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    ).length;
  } catch (error) {
    queueReadError = error?.message || String(error);
  }
  let installedPolicy = null;
  let installedPolicyError = null;
  try {
    const snapshot = await readJson(context.paths.policy);
    if (snapshot) installedPolicy = reviewPolicySnapshot(snapshot);
  } catch (error) {
    installedPolicyError = error?.message || String(error);
  }
  const plan = buildInstallPlan({
    platform: process.platform,
    repoRoot: context.repoRoot,
    stateRoot: context.stateRoot,
  });
  let scheduler = { supported: !plan.unsupportedScheduler, installed: false };
  if (!plan.unsupportedScheduler) {
    const result = await run(plan.query.command, plan.query.args, {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    try {
      scheduler = { supported: true, installed: schedulerQueryInstalled(plan, result) };
    } catch (error) {
      scheduler = {
        supported: true,
        installed: null,
        error: error?.message || String(error),
      };
    }
  }
  if (plan.platform === 'darwin') {
    scheduler.registrationFilePresent = await access(plan.plistPath)
      .then(() => true)
      .catch(() => false);
    if (!scheduler.installed && scheduler.registrationFilePresent) {
      scheduler.activation = 'next-login';
    }
  }
  const watcherVersionCompatible = Boolean(
    heartbeat?.gateVersion === GATE_VERSION &&
    heartbeat?.charterVersion === CHARTER_VERSION,
  );
  const watcherPolicyCompatible = Boolean(
    watcherVersionCompatible &&
    installedPolicy?.policyDigest &&
    heartbeat?.policyDigest === installedPolicy.policyDigest,
  );
  let reviewTiming = null;
  try {
    reviewTiming = await reviewTimingSummary(context.paths);
  } catch (error) {
    reviewTiming = { error: error?.message || String(error) };
  }
  return {
    repoRoot: context.repoRoot,
    stateRoot: context.stateRoot,
    hooksPath,
    reviewTiming,
    hookInstalled: hooksPathIsOurs(context.repoRoot, hooksPath),
    heartbeat,
    watcherHealthy: watcherPolicyCompatible && daemonOwnerIsHealthy(lock, heartbeat, {
      maxAgeMs: 30_000,
    }),
    watcherVersionCompatible,
    watcherPolicyCompatible,
    installedPolicyDigest: installedPolicy?.policyDigest ?? null,
    installedPolicyError,
    watcherStartupError: daemonError,
    paused,
    persistedStateErrors: {
      heartbeat: heartbeatState.error,
      lock: lockState.error,
      daemonError: daemonErrorState.error,
      paused: pausedState.error,
      queueSubmitLock: queueSubmitLockState.error,
      queue: queueReadError,
    },
    queue: {
      depth: queueDepth,
      maxQueued: LIMITS.maxQueuedRequests,
      submissionOwner: queueSubmitLockState.value,
    },
    scheduler,
  };
}

export async function pauseReviewGate({ repoRoot = process.cwd(), reason } = {}) {
  const context = await createGateContext(repoRoot);
  return await pauseGate(context.paths, reason);
}

export async function resumeReviewGate({ repoRoot = process.cwd() } = {}) {
  const context = await createGateContext(repoRoot);
  return { resumed: true, previous: await resumeGate(context.paths) };
}

export async function recoverStaleDaemonState(
  context,
  {
    reason,
    recoverResources = recoverStaleReviewResources,
  } = {},
) {
  const normalizedReason = String(reason || '').trim();
  if (normalizedReason.length < 12) {
    throw new Error('A stale-state recovery reason of at least 12 characters is required.');
  }
  const [lock, heartbeat] = await Promise.all([
    readJson(context.paths.lock).catch(() => null),
    readJson(context.paths.heartbeat).catch(() => null),
  ]);
  if (daemonOwnerIsHealthy(lock, heartbeat)) {
    throw new Error(`The shared review watcher is healthy at PID ${lock.pid}; use review:uninstall for a controlled stop instead of stale-state recovery.`);
  }
  await rm(context.paths.lock, { force: true });
  await rm(context.paths.queueSubmitLock, { force: true });
  await removeStoredJson(context.paths.heartbeat);
  const [technicalOutcomesCleared, claimsRecovered, resourcesRecovered] = await Promise.all([
    clearTechnicalErrorOutcomes(context.paths),
    recoverClaims(context.paths),
    recoverResources(context.repoRoot),
  ]);
  await recordEvent(context.paths, {
    type: 'stale-state-recovery',
    reason: normalizedReason,
    previousLockPid: lock?.pid ?? null,
    previousHeartbeatPid: heartbeat?.pid ?? null,
    technicalOutcomesCleared,
    claimsRecovered,
    resourcesRecovered,
  });
  return {
    recovered: true,
    previousLockPid: lock?.pid ?? null,
    previousHeartbeatPid: heartbeat?.pid ?? null,
    technicalOutcomesCleared,
    claimsRecovered,
    resourcesRecovered,
  };
}

export async function recoverReviewGate({ repoRoot = process.cwd(), reason } = {}) {
  const context = await createGateContext(repoRoot);
  return await recoverStaleDaemonState(context, { reason });
}
