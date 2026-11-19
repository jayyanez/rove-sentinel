import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GATE_VERSION } from './constants.mjs';
import { createGateContext } from './gate.mjs';
import { gateStatus, stopDaemon } from './install.mjs';
import { acquireUpdateLease, updateMarker } from './maintenance.mjs';
import { engineCli, engineRoot, engineStatePath, ensureEngine, publishEngineState } from './engine-store.mjs';
import { acquireDispositionLock, atomicWriteJson, daemonOwnerIsHealthy, pauseGate, readJson, removeStoredJson, sleep } from './storage.mjs';
import { runProcess } from './process.mjs';
import { checkForUpdates, compareVersions } from './updates.mjs';
import { longPauseMessage, notifyUpdate, updateMessage } from './update-notifications.mjs';

const DAY = 24 * 60 * 60 * 1000;
const RETRY = 10 * 60 * 1000;
const ownCli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const settingsPath = (paths) => path.join(paths.root, 'update-settings.json');
const enabled = async (paths, env) => env.ROVE_SENTINEL_AUTO_UPDATE !== '0'
  && (await readJson(settingsPath(paths)))?.enabled === true;

/** A pause older than this is reported by review commands even with no update waiting. */
export const LONG_PAUSE_MS = DAY;
// The pause an activation writes for itself, and clears, while it runs.
const UPDATE_PAUSE = 'Automatic Sentinel update to ';
const settle = (file) => readJson(file).then((value) => ({ value }), (error) => ({ error: error?.message || String(error) }));

/**
 * What keeps the watcher from acknowledging an idle pause, from its own records
 * (no scheduler query, nothing started): a pause somebody must lift, a watcher
 * that is not running, or state it cannot read. An activation waits for that
 * acknowledgement, so each of these keeps a downloaded release waiting for ever.
 * Safety pauses are deliberate: this reports them, it never lifts them.
 */
export async function watcherHolds(paths, { isAlive } = {}) {
  const [paused, lock, heartbeat, daemonError] = await Promise.all(
    [paths.paused, paths.lock, paths.heartbeat, paths.daemonError].map(settle));
  const unreadable = [paused, lock, heartbeat].find((entry) => entry.error);
  if (unreadable) {
    return [{ kind: 'unreadable', since: null, reason: `the watcher's state is unreadable: ${unreadable.error}`,
      action: 'Run npx --no-install rove-sentinel status, which names the record, and repair it.' }];
  }
  const holds = [];
  if (!daemonOwnerIsHealthy(lock.value, heartbeat.value, { maxAgeMs: 30_000, ...(isAlive ? { isAlive } : {}) })) {
    holds.push({ kind: 'stopped', since: daemonError.value?.at ?? heartbeat.value?.at ?? null,
      reason: daemonError.value?.message ?? (lock.value ? `no fresh heartbeat from the lock's PID ${lock.value.pid}` : 'no watcher is running'),
      action: 'Fix the reason, then run npx --no-install rove-sentinel install from your trusted checkout.' });
  }
  if (paused.value && !String(paused.value.reason ?? '').startsWith(UPDATE_PAUSE)) {
    holds.push({ kind: 'paused', since: paused.value.pausedAt ?? null, reason: String(paused.value.reason ?? 'no reason recorded'),
      action: 'Inspect the reason; once it is resolved, run npx --no-install rove-sentinel resume.' });
  }
  return holds;
}

export async function updateInformation(paths, { holds = watcherHolds } = {}) {
  const state = await readJson(engineStatePath(paths));
  const phase = state?.phase || 'idle';
  const pendingVersion = state?.pendingVersion || null;
  return { automatic: await enabled(paths, process.env),
    runningVersion: GATE_VERSION, activeVersion: state?.activeVersion || GATE_VERSION,
    pendingVersion, phase,
    lastAttempt: state?.lastAttempt || null, lastError: state?.lastError || null,
    // Why a downloaded release is not activating, when the watcher will not let it.
    blockedBy: phase === 'waiting' && pendingVersion ? await holds(paths) : [] };
}

/**
 * The lines review commands print about updates and the watcher: the update's
 * state, why it cannot activate, and a pause left longer than LONG_PAUSE_MS.
 */
export async function reviewNotices(paths, project, { now = Date.now(), holds = watcherHolds } = {}) {
  const information = await updateInformation(paths, { holds });
  const lines = [];
  const update = updateMessage(information, project);
  if (update) lines.push(update);
  if (!information.blockedBy.some((hold) => hold.kind === 'paused')) {
    const paused = await readJson(paths.paused).catch(() => null);
    const since = Date.parse(paused?.pausedAt);
    if (paused && !String(paused.reason ?? '').startsWith(UPDATE_PAUSE) && Number.isFinite(since) && now - since > LONG_PAUSE_MS) {
      lines.push(longPauseMessage(paused, project));
    }
  }
  return lines;
}

export async function configureAutomaticUpdates(context, value, { onlyIfMissing = false } = {}) {
  if (!onlyIfMissing || !await readJson(settingsPath(context.paths))) {
    await atomicWriteJson(settingsPath(context.paths), { schemaVersion: 1, enabled: value });
  }
  return updateInformation(context.paths);
}

/** The watcher schedules a separate, hidden worker and continues servicing reviews. */
export async function maybeStartUpdateWorker(context, { now = Date.now(), start = spawn,
  env = process.env, platform = process.platform, root = engineRoot() } = {}) {
  if (platform !== 'win32' || env.ROVE_SENTINEL_AUTO_UPDATE === '0') return false;
  const state = await readJson(engineStatePath(context.paths), {});
  const schedule = await readJson(path.join(context.paths.root, 'update-schedule.json'), {});
  const lastAttempt = Math.max(state.lastAttempt || 0, schedule.lastAttempt || 0);
  if (!await enabled(context.paths, env) || lastAttempt && now - lastAttempt < (state.phase === 'waiting' ? RETRY : DAY)) return false;
  await atomicWriteJson(path.join(context.paths.root, 'update-schedule.json'), { lastAttempt: now });
  const child = start(process.execPath, [ownCli, 'auto-update', '--repo', context.repoRoot], {
    cwd: context.repoRoot, env, detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
  return true;
}

/** Side-by-side installation. Existing runtime files and consumer pins are never edited. */
/** A live, compatible watcher. Failing GitHub polls hold no update back: it may be
 *  their fix. An engine before `watcherRunning` reports only `watcherHealthy`. */
const watcherAlive = (status) => status.watcherRunning ?? status.watcherHealthy;

export async function automaticUpdate({ repoRoot = process.cwd(), force = false } = {}, {
  contextFor = createGateContext, check = checkForUpdates, ensure = ensureEngine,
  status = gateStatus, stop = stopDaemon, run = runProcess,
  notify = notifyUpdate,
  root = engineRoot(), version = GATE_VERSION, cliPath = ownCli,
  platform = process.platform, env = process.env, pauseTimeoutMs = 30_000,
} = {}) {
  const context = await contextFor(repoRoot);
  const { paths } = context;
  let state = await readJson(engineStatePath(paths), {});
  if (!await enabled(paths, env)) return { status: 'disabled' };
  if (platform !== 'win32') return { status: 'unsupported' };
  const releaseWorker = await acquireDispositionLock(paths,
    { repository: context.repository, branch: 'sentinel-runtime-update' }, { maxHoldMs: Infinity });
  const save = async (patch) => {
    state = { ...state, repoRoot: context.repoRoot, ...patch };
    await publishEngineState(paths, state, root);
  };
  try {
    const discovery = await check({ installedVersion: version, enabled: true, force });
    await save({ lastAttempt: Date.now() });
    if (discovery.status !== 'available' || compareVersions(discovery.latestVersion, version) <= 0) return { status: discovery.status };
    const nextVersion = discovery.latestVersion;
    if (!force && state.failedVersion === nextVersion) return { status: 'failed', version: nextVersion, error: state.lastError };
    // Reserve the runtime globally before installation, so another project's collection cannot remove it.
    await save({ pendingVersion: nextVersion, phase: 'downloading', lastError: null });
    await ensure(nextVersion, { root });
    await save({ phase: 'waiting' });
    if (!await enabled(paths, env)) return { status: 'disabled' };
    await notify(context, state).catch(() => {});
    const before = await status({ repoRoot: context.repoRoot });
    if (!watcherAlive(before) || before.heartbeat?.repoRoot !== context.repoRoot || before.paused
      || before.queue?.depth !== 0 || before.queue?.submissionOwner
      || Object.values(before.persistedStateErrors || {}).some(Boolean)) return { status: 'waiting', version: nextVersion };
    const previousPolicy = await readJson(paths.policy);
    if (!previousPolicy) throw new Error('Installed policy disappeared before activation.');
    let releaseUpdate;
    try { releaseUpdate = await acquireUpdateLease(paths, { repoRoot: context.repoRoot, version: nextVersion }); }
    catch (error) { await save({ phase: 'waiting', lastError: error.message }); return { status: 'waiting', version: nextVersion }; }
    const previousState = { ...state };
    let pause = null;
    let stopped = false;
    let preserveFence = false;
    const exec = async (cli, args) => (await run(process.execPath, [cli, ...args, '--repo', context.repoRoot], {
      cwd: context.repoRoot, env, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024,
    })).stdout.trim();
    const clearPause = async () => {
      if (pause && JSON.stringify(await readJson(paths.paused)) === JSON.stringify(pause)) await removeStoredJson(paths.paused);
    };
    try {
      await atomicWriteJson(path.join(paths.root, 'update-recovery.json'), {
        repoRoot: context.repoRoot, previousState, previousPolicy, previousCli: cliPath, nextVersion,
      });
      pause = await pauseGate(paths, `Automatic Sentinel update to ${nextVersion}`);
      const deadline = Date.now() + pauseTimeoutMs;
      let acknowledged = false;
      while (Date.now() <= deadline) {
        const health = await status({ repoRoot: context.repoRoot });
        if (!watcherAlive(health) || health.heartbeat?.pid !== before.heartbeat.pid) throw new Error('Watcher ownership changed during update.');
        if (health.heartbeat.activity === 'paused') { acknowledged = true; break; }
        await sleep(250);
      }
      if (!acknowledged) {
        await clearPause();
        return { status: 'waiting', version: nextVersion };
      }
      await save({ phase: 'activating' });
      if (await stop(context) === false) throw new Error('The watcher moved to another checkout.');
      stopped = true;
      const nextCli = engineCli(nextVersion, root);
      if (await exec(nextCli, ['--version']) !== nextVersion) throw new Error('New engine reports the wrong version.');
      await exec(nextCli, ['install', '--preserve-policy']);
      const health = JSON.parse(await exec(nextCli, ['status', '--no-update-check']));
      if (!watcherAlive(health) || health.heartbeat?.gateVersion !== nextVersion || health.heartbeat?.repoRoot !== context.repoRoot) {
        throw new Error('New engine did not start a healthy watcher.');
      }
      // Publish only after health verification. New CLI invocations now choose the same runtime as the watcher.
      await save({ activeVersion: nextVersion, previousVersion: previousState.activeVersion || null,
        pendingVersion: null, phase: 'active', activatedAt: Date.now(), failedVersion: null, lastError: null });
      await clearPause();
      await notify(context, state).catch(() => {});
      return { status: 'updated', version: nextVersion };
    } catch (error) {
      try {
        if (stopped) {
          if (await stop(context) === false) throw new Error('Cannot stop a replacement watcher in another checkout.');
          await atomicWriteJson(paths.policy, previousPolicy);
          await exec(cliPath, ['install', '--preserve-policy']);
          const restored = JSON.parse(await exec(cliPath, ['status', '--no-update-check']));
          if (!watcherAlive(restored) || restored.heartbeat?.gateVersion !== version) throw new Error('Previous watcher did not recover.');
        }
        state = previousState;
        await save({ phase: 'failed', failedVersion: nextVersion, lastError: error.message });
        await clearPause();
      } catch (rollbackError) {
        preserveFence = true;
        await save({ phase: 'recovery-required', lastError: `${error.message} Recovery failed: ${rollbackError.message}. Inspect ${updateMarker(paths)} and update-recovery.json.` });
      }
      await notify(context, state).catch(() => {});
      return { status: preserveFence ? 'recovery-required' : 'failed', version: nextVersion, error: state.lastError };
    } finally { if (!preserveFence) await releaseUpdate(); }
  } catch (error) {
    await save({ phase: 'download-failed', lastError: error.message });
    return { status: 'download-failed', error: error.message };
  } finally { await releaseWorker(); }
}
