import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHARTER_VERSION, GATE_VERSION, LIMITS, TASK_PREFIX } from './constants.mjs';
import { detectSubscriptions } from './subscriptions.mjs';
import { modelSettings, validateModelClients } from './modelSettings.mjs';
import { readReviewPolicy, reviewPolicySnapshot } from './context.mjs';
import { detachedWatcherEnvironment, startDaemonDetached } from './daemon.mjs';
import { createGateContext } from './gate.mjs';
import { recoverStaleReviewResources, runGit } from './git.mjs';
import { processTreeCleanupFailureCode, runProcess } from './process.mjs';
import { hookCallsSentinel, uninstallGeneratedHook } from './init.mjs';
import {
  daemonOwnerIsHealthy,
  atomicWriteJson,
  clearDaemonError,
  clearTechnicalErrorOutcomes,
  hashText,
  isProcessAlive,
  pauseGate,
  readJson,
  readWatcherStartLog,
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

/**
 * The scheduled task's command. A logon "interactive only" task that runs a
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
 * `cmd.exe /c` would both expand it.
 */
export function windowsTaskRun(wrapperPath, systemRoot) {
  const command = path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
  const args = `--headless cmd.exe /d /c ${quoteWindows(wrapperPath)}`;
  const refusal = wrapperPath.includes('%')
    ? `The review watcher's state path contains "%", which Task Scheduler and cmd.exe would expand as an environment variable: ${wrapperPath}. Point LOCALAPPDATA at a path without "%" and rerun npx --no-install rove-sentinel install.`
    : null;
  return { command, args, refusal };
}

/**
 * The task, as `schtasks /Create /XML` takes it. `/SC ONLOGON` means any user's
 * logon, which only an administrator may register: an administrator's limited
 * token got "Access is denied", and an automatic update, which installs from
 * the watcher's limited token, could never have replaced it. A logon trigger
 * that names its own user needs no elevation to create, replace, run, end or
 * delete (measured from a limited token on Windows 11).
 *
 * The other settings are what `schtasks` leaves out of its defaults: a laptop's
 * watcher must start and go on when it runs on battery, and a watcher lives for
 * as long as the session, past the default 72-hour limit.
 */
export function windowsTaskXml({ user, command, args }) {
  const account = xmlEscape(user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${account}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${account}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * A task registered from an elevated shell belongs to administrators, whatever
 * its trigger: a limited token may run and end it, but neither replace nor delete
 * it, and an elevated install leaves it so (all measured). Only a task the
 * limited token registers itself stays its own, so the way out is to delete the
 * task once, as an administrator, and to install from the limited shell.
 */
export function windowsTaskRefusal(error, taskExisted, taskName) {
  if (!taskExisted || !/access is denied/i.test(error?.message || '')) return error;
  return new Error(`The review watcher's scheduled task was registered from an elevated shell, so this limited shell cannot replace it. From an elevated shell run schtasks /Delete /TN ${taskName} /F, then run npx --no-install rove-sentinel install from this shell, not the elevated one: the task is then your own, and no install or update needs elevation.`, { cause: error });
}

/** The account a task of this user's own logon names. */
function windowsAccount(environment) {
  const user = environment.USERNAME || os.userInfo().username;
  return environment.USERDOMAIN ? `${environment.USERDOMAIN}\\${user}` : user;
}

// Paths, never credentials: where the tools a review runs keep their settings.
const WATCHER_TOOL_SETTINGS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'CLAUDE_CODE_GIT_BASH_PATH'];
// The wrapper's `set "PATH=..."` is one cmd.exe line, of at most 8191 characters.
const WATCHER_PATH_MAX_CHARACTERS = 8000;

/**
 * The installing shell's PATH, for a scheduled watcher. A task starts with the
 * machine's and the user's stored environment, so tools a shell finds through a
 * profile or an activation script are missing there: without Git the watcher
 * stops before it can write down why. A package runner puts the checkout's
 * `node_modules\.bin` first, and a watcher reviews that checkout, so nothing of
 * the repository or of any `node_modules` is carried, however it is spelled:
 * Windows also finds programs through `D:/repo/bin` and `D:\other\..\repo\bin`.
 * Only an entry with a drive letter can be compared with the checkout: `\repo\bin`
 * means the current drive, and a network path may be a local folder.
 * A shell's PATH already holds the stored one, so this replaces it, and the
 * task's own is not appended: its length is not known here, and a line past
 * cmd.exe's limit would stop the wrapper before the watcher starts.
 */
export function watcherPath(pathValue, repoRoot) {
  const root = path.win32.resolve(repoRoot).toLowerCase();
  const seen = new Set();
  const kept = [];
  let length = 0;
  for (const raw of String(pathValue || '').split(';')) {
    const unquoted = raw.replaceAll('"', '').trim();
    if (!/^[a-z]:[\\/]/i.test(unquoted) || /[%\r\n]/.test(unquoted)) continue;
    const entry = path.win32.normalize(unquoted);
    const folded = entry.toLowerCase().replace(/\\+$/, '');
    if (seen.has(folded)) continue;
    if (folded === root || folded.startsWith(`${root}\\`) || /(^|\\)node_modules(\\|$)/.test(folded)) continue;
    if (length + entry.length + 1 > WATCHER_PATH_MAX_CHARACTERS) break;
    seen.add(folded);
    kept.push(entry);
    length += entry.length + 1;
  }
  return kept.join(';');
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
  environment = process.env,
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
    const toolSettings = WATCHER_TOOL_SETTINGS
      .filter((key) => environment[key] && !/["\r\n]/.test(environment[key]))
      .map((key) => `set ${quoteBatch(`${key}=${environment[key]}`)}\r\n`).join('');
    const carriedPath = watcherPath(environment.PATH ?? environment.Path, repoRoot);
    const toolPath = carriedPath ? `set "PATH=${carriedPath}"\r\n` : '';
    const startLogPath = path.win32.join(stateRoot, 'watcher-start.log');
    const wrapper = `@echo off\r\n${stateEnvironment}${toolSettings}${toolPath}set "ROVE_REVIEW_ALLOW_API_BILLING="\r\nset "ANTHROPIC_API_KEY="\r\nset "OPENAI_API_KEY="\r\n${[
      nodePath,
      cliPath,
      'watch',
      '--daemon',
      '--repo',
      repoRoot,
    ].map(quoteBatch).join(' ')} 2> ${quoteBatch(startLogPath)}\r\n`;
    const { command, args, refusal } = windowsTaskRun(wrapperPath, systemRoot);
    const taskXmlPath = path.win32.join(stateRoot, 'watch-task.xml');
    return {
      platform,
      taskName,
      wrapperPath,
      wrapper,
      taskXmlPath,
      taskXml: windowsTaskXml({ user: windowsAccount(environment), command, args }),
      // Uninstall and status still need the task name for such a path, so the
      // refusal is carried, and installGate enforces it before any change.
      installRefusal: refusal,
      create: {
        command: 'schtasks.exe',
        args: ['/Create', '/TN', taskName, '/XML', taskXmlPath, '/F'],
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
  { run = runProcess, env: sourceEnvironment = process.env, config = {} } = {},
) {
  const env = detachedWatcherEnvironment(sourceEnvironment);
  const probe = async (label, command, args) => {
    let result;
    try {
      result = await run(command, args, { cwd: repoRoot, env, timeoutMs: 30_000, allowFailure: true });
    } catch (error) {
      throw new Error(`${label} could not be launched: ${error?.message || String(error)}`, { cause: error });
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || 'no diagnostic output').trim().slice(0, 1_000);
      throw new Error(`${label} failed with exit ${result.code}: ${detail}`);
    }
    return (result.stdout || result.stderr).split(/\r?\n/).find(Boolean) || 'available';
  };
  const [subscriptions, git, gh] = await Promise.all([
    detectSubscriptions(repoRoot, { mode: config.providers ?? 'auto', run, env }),
    probe('Git version check', 'git', ['--version']),
    probe('GitHub CLI authentication check', 'gh', ['auth', 'status']),
  ]);
  validateModelClients(config, subscriptions);
  return {
    ...Object.fromEntries(subscriptions.selected.map((provider) => [provider, subscriptions.availability[provider].version])),
    git, gh, providers: subscriptions, models: modelSettings(config),
  };
}

export function heartbeatIsHealthy(
  heartbeat,
  repoRoot,
  maxAgeMs = 30_000,
  { isAlive = isProcessAlive, now = Date.now } = {},
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
    isAlive = isProcessAlive,
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

export async function installGate({ repoRoot = process.cwd(), dryRun = false, start = true, github, preservePolicy = false } = {}) {
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
  const policy = preservePolicy
    ? await policyForEngineUpgrade(context.paths)
    : reviewPolicySnapshot(await readReviewPolicy(context.repoRoot));
  const prerequisites = await verifyPrerequisites(context.repoRoot, { config: policy.config });
  if (dryRun) return { dryRun: true, hooksPath: '.githooks', prerequisites, plan };

  return await executeInstallTransaction({
    context,
    plan,
    policy,
    currentHooks: current,
    prerequisites,
    previousDaemonActive,
    start,
    github,
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
    // undefined keeps this machine's choice
    github,
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
  const [policyBefore, watcherOptionsBefore, artifactBefore] = await Promise.all([
    snapshotFile(context.paths.policy),
    snapshotFile(context.paths.watcherOptions),
    artifactPath ? snapshotFile(artifactPath) : Promise.resolve(null),
  ]);
  const configuredHooks = !currentHooks;
  let schedulerCreated = false;
  let schedulerReplaced = false;
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
    // pending while this process lives: the watcher started below honours it
    // at once, and it is gone if this install is killed (readWatcherGithub)
    if (github !== undefined) {
      const before = await readJson(context.paths.watcherOptions, null);
      await atomicWriteJson(context.paths.watcherOptions, { github: before?.github !== false, pending: { github, pid: process.pid, until: Date.now() + LIMITS.installPendingMs } });
    }
    if (configuredHooks) {
      await git(context.repoRoot, ['config', 'core.hooksPath', '.githooks']);
      hooksConfiguredByAttempt = true;
    }
    if (start) await clearDaemonError(context.paths);
    if (plan.platform === 'win32') {
      await mkdir(path.dirname(plan.wrapperPath), { recursive: true });
      await writeFile(plan.wrapperPath, plan.wrapper, { encoding: 'utf8', mode: 0o600 });
      // `schtasks /XML` takes the encoding its first line declares from the byte order mark.
      if (plan.taskXmlPath) await writeFile(plan.taskXmlPath, `\ufeff${plan.taskXml}`, { encoding: 'utf16le', mode: 0o600 });
      schedulerCreated = !schedulerWasInstalled;
      try {
        await run(plan.create.command, plan.create.args, { timeoutMs: 120_000 });
      } catch (error) {
        throw windowsTaskRefusal(error, schedulerWasInstalled, plan.taskName);
      }
      schedulerReplaced = schedulerWasInstalled;
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
    if (github !== undefined) await atomicWriteJson(context.paths.watcherOptions, { github });
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
    await attempt(() => restoreFile(context.paths.watcherOptions, watcherOptionsBefore, { storedJson: true }));
    if (artifactPath) await attempt(() => restoreFile(artifactPath, artifactBefore));

    if (
      plan.platform === 'win32' &&
      schedulerWasInstalled &&
      (schedulerReplaced || schedulerStoppedForReplacement)
    ) {
      // A refused replacement changed nothing, and would only be refused again.
      if (schedulerReplaced) {
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
      if (plan.taskXmlPath) await attempt('task definition removal', () => removeFile(plan.taskXmlPath, { force: true }));
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

/**
 * What a person needs to know of the watcher: `running`, `outdated` (running
 * another version or policy), `stopped`, `not-installed`, or `unknown` when the
 * scheduler could not be read and nothing else tells. A scheduler's task can
 * report success while its watcher refused to start, so this reads the watcher's
 * own records.
 */
export function watcherState({ running, compatible, heartbeat, lock, daemonError, startLog, installed, stateError, schedulerError }) {
  if (running) {
    return compatible
      ? { state: 'running', pid: heartbeat.pid }
      : { state: 'outdated', pid: heartbeat.pid, action: 'Run npx --no-install rove-sentinel install from your trusted checkout.' };
  }
  if (!installed && !lock && !heartbeat && !stateError) {
    return schedulerError ? { state: 'unknown', reason: schedulerError } : { state: 'not-installed' };
  }
  const silent = startLog ? `it stopped with: ${startLog}`
    : lock ? `no fresh heartbeat from the lock's PID ${lock.pid}` : 'no watcher is running';
  return {
    state: 'stopped',
    reason: daemonError?.message ?? (stateError ? `the watcher's state is unreadable: ${stateError}` : silent),
    ...(daemonError?.at ? { since: daemonError.at } : {}),
    action: 'Pushes wait for a review nobody runs. Fix the reason, then run npx --no-install rove-sentinel install from your trusted checkout.',
  };
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
    try {
      const result = await run(plan.query.command, plan.query.args, {
        allowFailure: true,
        timeoutMs: 30_000,
      });
      scheduler = { supported: true, installed: schedulerQueryInstalled(plan, result) };
    } catch (error) {
      if (processTreeCleanupFailureCode(error)) throw error;
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
    providerRequirement: installedPolicy ? installedPolicy.config.providers ?? 'auto' : null,
    models: installedPolicy ? modelSettings(installedPolicy.config) : null,
    reviewTiming,
    hookInstalled: hooksPathIsOurs(context.repoRoot, hooksPath),
    heartbeat,
    watcherHealthy: watcherPolicyCompatible && daemonOwnerIsHealthy(lock, heartbeat, {
      maxAgeMs: 30_000,
    }),
    watcher: watcherState({
      running: daemonOwnerIsHealthy(lock, heartbeat, { maxAgeMs: 30_000 }),
      compatible: watcherPolicyCompatible,
      heartbeat,
      lock,
      daemonError,
      startLog: await readWatcherStartLog(context.paths),
      stateError: lockState.error ?? heartbeatState.error,
      schedulerError: scheduler.error,
      // Linux has no supported scheduler, so the hook counts as well.
      installed: Boolean(scheduler.installed || await hookCallsSentinel(context.repoRoot)),
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

/**
 * The watcher, for `doctor`: it reports what it can, and a failure here never
 * costs the rest of its diagnosis.
 */
export async function watcherReport(repoRoot, { status = gateStatus } = {}) {
  try {
    const { watcher, scheduler } = await status({ repoRoot });
    return { watcher, scheduler };
  } catch (error) {
    if (processTreeCleanupFailureCode(error)) throw error;
    return { watcher: { state: 'unknown', reason: error?.message || String(error) }, scheduler: null };
  }
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
