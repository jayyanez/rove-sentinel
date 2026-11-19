import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { CHARTER_VERSION, GATE_VERSION } from './constants.mjs';
import { reviewPolicySnapshot } from './context.mjs';
import { createGateContext } from './gate.mjs';
import { gateStatus, stopDaemon } from './install.mjs';
import { acquireUpdateLease, processStartedAt, updateMarker } from './maintenance.mjs';
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
const settle = (read) => read().then((value) => ({ value }), (error) => ({ error: error?.message || String(error) }));
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

/**
 * Whether the activation that wrote an update marker still runs: its PID is
 * alive, and where the system reports a start time (Windows), that process
 * started before the marker was written, so a reused PID does not count.
 */
async function activationRuns(marker, { isAlive, startedAt }) {
  if (!marker || !isAlive(marker.pid)) return false;
  const written = Date.parse(marker.startedAt);
  const started = Number.isFinite(written) ? await startedAt(marker.pid) : null;
  return started === null || started <= written + 1000;
}

/**
 * The activation's own pause is no hold while the activation that wrote it
 * still runs. Any other pause, an update's left behind included, keeps a
 * release waiting. These reports are diagnostics; activation itself still
 * checks everything it checked before.
 */
async function liftsItself(paused, paths, probes) {
  if (!String(paused?.reason ?? '').startsWith(UPDATE_PAUSE)) return false;
  return activationRuns(await readJson(updateMarker(paths)).catch(() => null), probes);
}

/**
 * What keeps a downloaded release from activating, from the watcher's own
 * records (no scheduler query, nothing started). Activation waits for a live
 * watcher of this engine and installed policy to acknowledge an idle pause, with
 * every state record readable and no update fence left; each hold here keeps
 * it waiting for ever. Safety pauses are deliberate: this reports them and
 * never lifts them. Queued and running reviews are not holds: they finish.
 */
export async function watcherHolds(paths, { isAlive = processAlive, startedAt = processStartedAt, gateVersion = GATE_VERSION, charterVersion = CHARTER_VERSION } = {}) {
  const records = { paused: paths.paused, lock: paths.lock, heartbeat: paths.heartbeat, daemonError: paths.daemonError,
    githubFailure: paths.githubFailure, queueSubmitLock: paths.queueSubmitLock, policy: paths.policy, marker: updateMarker(paths) };
  const read = Object.fromEntries(await Promise.all(Object.entries(records).map(async ([name, file]) => [name, await settle(() => readJson(file))])));
  read.queue = await settle(() => readdir(paths.requests).catch((error) => { if (error.code === 'ENOENT') return []; throw error; }));
  let digest = null;
  if (read.policy.value) {
    try { digest = reviewPolicySnapshot(read.policy.value).policyDigest; }
    catch (error) { read.policy = { error: error?.message || String(error) }; }
  }
  const holds = [];
  const unreadable = Object.entries(read).filter(([, entry]) => entry.error);
  if (unreadable.length) {
    holds.push({ kind: 'unreadable', since: null,
      reason: unreadable.map(([name, entry]) => `${name}: ${entry.error}`).join('; '),
      action: 'Run npx --no-install rove-sentinel status, which names each record, and repair it.' });
  }
  const lock = read.lock.value;
  const heartbeat = read.heartbeat.value;
  if (!daemonOwnerIsHealthy(lock, heartbeat, { maxAgeMs: 30_000, isAlive })) {
    holds.push({ kind: 'stopped', since: read.daemonError.value?.at ?? heartbeat?.at ?? null,
      reason: read.daemonError.value?.message ?? (lock ? `no fresh heartbeat from the lock's PID ${lock.pid}` : 'no watcher is running'),
      action: 'Fix the reason, then run npx --no-install rove-sentinel install from your trusted checkout.' });
  } else if (!read.policy.error && (heartbeat.gateVersion !== gateVersion || heartbeat.charterVersion !== charterVersion || !digest || heartbeat.policyDigest !== digest)) {
    holds.push({ kind: 'outdated', since: null,
      reason: `it runs ${heartbeat.gateVersion ?? 'an unknown version'} with ${digest && heartbeat.policyDigest === digest ? 'the installed policy' : 'another policy than the installed one'}, and this engine is ${gateVersion}`,
      action: 'Run npx --no-install rove-sentinel install from your trusted checkout to restart it.' });
  }
  const paused = read.paused.value;
  if (paused && !await liftsItself(paused, paths, { isAlive, startedAt })) {
    holds.push({ kind: 'paused', since: paused.pausedAt ?? null, reason: String(paused.reason ?? 'no reason recorded'),
      action: String(paused.reason ?? '').startsWith(UPDATE_PAUSE)
        ? 'An interrupted update left this pause: follow Isolation and recovery in the updates guide before running npx --no-install rove-sentinel resume.'
        : 'Inspect the reason; once it is resolved, run npx --no-install rove-sentinel resume.' });
  }
  const submitter = read.queueSubmitLock.value;
  if (Number.isInteger(submitter?.pid) && submitter.pid > 0 && !isAlive(submitter.pid)) {
    holds.push({ kind: 'queue-lock', since: null,
      reason: `the review queue's submission lock belongs to the dead process ${submitter.pid}`,
      action: `Confirm no Sentinel process has PID ${submitter.pid} and no submitter replaced the lock, then delete ${paths.queueSubmitLock}; recover removes it only while the watcher is stopped.` });
  }
  const marker = read.marker.value;
  if (marker && !await activationRuns(marker, { isAlive, startedAt })) {
    holds.push({ kind: 'interrupted', since: marker.startedAt ?? null,
      reason: `an update to ${marker.version ?? 'another version'} stopped, its process ${marker.pid} gone, leaving ${updateMarker(paths)}`,
      action: 'Follow Isolation and recovery in the updates guide: restore and verify the previous runtime, then remove the marker and its pause.' });
  }
  return holds;
}

export async function updateInformation(paths, { holds = watcherHolds } = {}) {
  const state = await readJson(engineStatePath(paths));
  const phase = state?.phase || 'idle';
  const pendingVersion = state?.pendingVersion || null;
  let settingsError = null;
  const automatic = await enabled(paths, process.env).catch((error) => { settingsError = error?.message || String(error); return null; });
  // Waiting: whatever keeps the release waiting. Activating: only what shows
  // the activation is gone or cannot be checked; a live one stops its watcher
  // and pauses on purpose.
  const found = ['waiting', 'activating'].includes(phase) && pendingVersion ? await holds(paths) : [];
  if (settingsError && ['waiting', 'activating'].includes(phase) && pendingVersion) {
    found.unshift({ kind: 'unreadable', since: null, reason: `update-settings: ${settingsError}`,
      action: 'Run npx --no-install rove-sentinel updates --enable or --disable to rewrite it.' });
  }
  return { automatic, settingsError,
    runningVersion: GATE_VERSION, activeVersion: state?.activeVersion || GATE_VERSION,
    pendingVersion, phase,
    lastAttempt: state?.lastAttempt || null, lastError: state?.lastError || null,
    blockedBy: phase === 'waiting' ? found : found.filter((hold) => ['interrupted', 'unreadable'].includes(hold.kind)) };
}

/**
 * The lines review commands print about updates and the watcher: the update's
 * state and why it cannot activate, and a pause left longer than LONG_PAUSE_MS,
 * which also refuses pushes that still need a review.
 */
export async function reviewNotices(paths, project, { now = Date.now(), holds = watcherHolds, isAlive = processAlive, startedAt = processStartedAt } = {}) {
  const information = await updateInformation(paths, { holds });
  const lines = [];
  const update = updateMessage(information, project);
  if (update) lines.push(update);
  if (information.settingsError && !information.blockedBy.some((hold) => hold.reason.startsWith('update-settings:'))) {
    lines.push(`Rove Sentinel cannot read the update settings for ${project}: ${information.settingsError} Automatic updates stop until npx --no-install rove-sentinel updates --enable or --disable rewrites them.`);
  }
  const paused = await readJson(paths.paused).catch(() => null);
  const since = Date.parse(paused?.pausedAt);
  if (paused && Number.isFinite(since) && now - since > LONG_PAUSE_MS && !await liftsItself(paused, paths, { isAlive, startedAt })) {
    lines.push(longPauseMessage(paused, project));
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
  let target = null;
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
    // Reserve the runtime under the store's lock, so another project's collection
    // either reads the reservation or has removed the copy before this one looks.
    target = nextVersion;
    await save({ phase: 'downloading', lastError: null });
    await ensure(nextVersion, { root, reserve: () => save({ pendingVersion: nextVersion }) });
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
    await save({ phase: 'download-failed', lastError: error.message, ...(target ? { pendingVersion: target } : {}) });
    return { status: 'download-failed', error: error.message };
  } finally { await releaseWorker(); }
}
