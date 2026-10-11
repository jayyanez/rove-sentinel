import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  copyFile,
  open,
  readFile,
  readdir,
  link,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHARTER_VERSION, GATE_VERSION, LIMITS } from './constants.mjs';

export function hashText(value, length = 24) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function normalizeRepositoryIdentity(remoteUrl, repoRoot, { platform = process.platform } = {}) {
  const normalizedRemote = remoteUrl
    .trim()
    .replace(/^([^@\s/:]+)@([^:/\s]+):/i, 'ssh://$1@$2/')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  if (normalizedRemote) {
    try {
      const parsed = new URL(normalizedRemote);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      if (!parsed.host) return `remote:${hashText(normalizedRemote, 32)}`;
      // Transport and credentials do not identify a repository. Normalize
      // every host-based URL onto one credential-free identity so one daemon
      // and attestation store serve every local clone of the same remote.
      // GitHub paths are case-insensitive; preserving this identity also
      // preserves existing Rove state. Other hosts may distinguish path case.
      const pathname = parsed.hostname.toLowerCase() === 'github.com'
        ? parsed.pathname.toLowerCase() : parsed.pathname;
      return `https://${parsed.host.toLowerCase()}${pathname}`.replace(/\/$/, '');
    } catch {
      return `remote:${hashText(normalizedRemote, 32)}`;
    }
  }
  const local = (platform === 'win32' ? path.win32 : path.posix).resolve(repoRoot);
  return platform === 'win32' ? local.toLowerCase() : local;
}

export function stateRootFor(
  repositoryIdentity,
  {
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
  } = {},
) {
  const repoId = hashText(repositoryIdentity, 16);
  if (platform === 'win32') {
    const pathApi = path.win32;
    const local = env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local');
    return pathApi.join(local, 'Rove', 'shared-review-gate', repoId);
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Rove', 'shared-review-gate', repoId);
  }
  return path.posix.join(
    env.XDG_STATE_HOME || path.join(home, '.local', 'state'),
    'rove',
    'shared-review-gate',
    repoId,
  );
}

export function statePaths(root) {
  return {
    root,
    requests: path.join(root, 'requests'),
    claims: path.join(root, 'claims'),
    results: path.join(root, 'results'),
    attestations: path.join(root, 'attestations'),
    outcomes: path.join(root, 'outcomes'),
    reports: path.join(root, 'reports'),
    convergence: path.join(root, 'convergence'),
    dispositions: path.join(root, 'dispositions'),
    shardCheckpoints: path.join(root, 'shard-checkpoints'),
    events: path.join(root, 'events'),
    auditEvents: path.join(root, 'audit-events'),
    queueSubmitLock: path.join(root, 'queue-submit.lock'),
    lock: path.join(root, 'daemon.lock.json'),
    heartbeat: path.join(root, 'heartbeat.json'),
    stopRequest: path.join(root, 'stop-request.json'),
    daemonError: path.join(root, 'daemon-error.json'),
    paused: path.join(root, 'paused.json'),
    policy: path.join(root, 'policy.json'),
  };
}

export async function ensureState(root) {
  const paths = statePaths(root);
  await Promise.all(
    ['requests', 'claims', 'results', 'attestations', 'outcomes', 'reports', 'convergence', 'dispositions', 'shardCheckpoints', 'events', 'auditEvents'].map((key) =>
      mkdir(paths[key], { recursive: true }),
    ),
  );
  return paths;
}

export async function atomicWriteJson(target, value) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temp, target);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
      await rm(temp, { force: true });
      throw error;
    }
    await replaceExistingFile(target, temp);
    return;
  }
  await rm(`${target}.previous`, { force: true }).catch(() => {});
}

export async function replaceExistingFile(
  target,
  temp,
  {
    copy = copyFile,
    move = rename,
    remove = rm,
  } = {},
) {
  const previous = `${target}.previous`;
  await remove(previous, { force: true });
  await copy(target, previous);
  await remove(target, { force: true });
  try {
    await move(temp, target);
  } catch (replacementError) {
    try {
      await move(previous, target);
    } catch (restoreError) {
      throw new Error(`Could not replace ${target}, and could not restore its previous value. The previous copy remains at ${previous}: ${restoreError?.message || String(restoreError)}`, {
        cause: replacementError,
      });
    }
    await remove(temp, { force: true }).catch(() => {});
    throw replacementError;
  }
  await remove(previous, { force: true }).catch(() => {});
}

export async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const previous = `${target}.previous`;
      try {
        // The replacement writer owns this recovery copy. Reading it is safe
        // during the brief target-absent window, but moving it can overwrite a
        // newly installed value or consume the writer's only rollback copy.
        return JSON.parse(await readFile(previous, 'utf8'));
      } catch (previousError) {
        if (previousError?.code === 'ENOENT') return fallback;
        throw previousError;
      }
    }
    throw error;
  }
}

export async function removeStoredJson(target, { remove = rm } = {}) {
  // Remove the recovery copy first. If that fails, preserve the primary and
  // fail the revocation instead of letting readJson resurrect stale authority.
  await remove(`${target}.previous`, { force: true });
  await remove(target, { force: true });
}

export function attestationIdentity({
  repository,
  baseSha,
  headSha,
  policyDigest,
  charterVersion = CHARTER_VERSION,
  gateVersion = GATE_VERSION,
}) {
  if (typeof policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policyDigest)) {
    throw new Error('Review attestation identity requires the exact 64-character policy digest.');
  }
  return {
    repository,
    baseSha,
    headSha,
    policyDigest,
    charterVersion,
    gateVersion,
  };
}

export function attestationFileName(identity) {
  return `${hashText(JSON.stringify(identity), 40)}.json`;
}

export async function readAttestation(paths, identity) {
  const value = await readJson(path.join(paths.attestations, attestationFileName(identity)));
  if (!value || value.status !== 'pass') return null;
  for (const [key, expected] of Object.entries(identity)) {
    if (value.identity?.[key] !== expected) return null;
  }
  return value;
}

export async function removeAttestation(paths, identity) {
  await removeStoredJson(path.join(paths.attestations, attestationFileName(identity)));
}

export async function writeAttestation(paths, identity, details) {
  const value = {
    schemaVersion: 1,
    status: 'pass',
    identity,
    createdAt: new Date().toISOString(),
    ...details,
  };
  await atomicWriteJson(
    path.join(paths.attestations, attestationFileName(identity)),
    value,
  );
  await pruneDirectory(paths.attestations, {
    maxFiles: LIMITS.maxAttestations,
    maxAgeMs: LIMITS.retentionMs,
  });
  return value;
}

function identityMatches(value, identity) {
  return Object.entries(identity).every(([key, expected]) => value?.identity?.[key] === expected);
}

export async function readOutcome(paths, identity) {
  const value = await readJson(path.join(paths.outcomes, attestationFileName(identity)));
  return value && identityMatches(value, identity) ? value : null;
}

export async function writeOutcome(paths, identity, details) {
  const value = {
    schemaVersion: 1,
    identity,
    updatedAt: new Date().toISOString(),
    ...details,
  };
  await atomicWriteJson(path.join(paths.outcomes, attestationFileName(identity)), value);
  await pruneDirectory(paths.outcomes, {
    maxFiles: LIMITS.maxOutcomes,
    maxAgeMs: LIMITS.retentionMs,
  });
  return value;
}

export async function removeOutcome(paths, identity) {
  await removeStoredJson(path.join(paths.outcomes, attestationFileName(identity)));
}

export async function clearTechnicalErrorOutcomes(paths) {
  const entries = await readdir(paths.outcomes, { withFileTypes: true });
  let removed = 0;
  const visited = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const primaryName = entry.name.endsWith('.json.previous')
      ? entry.name.slice(0, -'.previous'.length)
      : entry.name.endsWith('.json')
        ? entry.name
        : null;
    if (!primaryName || visited.has(primaryName)) continue;
    visited.add(primaryName);
    const target = path.join(paths.outcomes, primaryName);
    let outcome;
    try {
      outcome = await readJson(target);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await removeStoredJson(target);
      removed += 1;
      continue;
    }
    if (outcome?.status !== 'error') continue;
    await removeStoredJson(target);
    removed += 1;
  }
  return removed;
}

/**
 * The shard reviews a round completed before it failed closed (1.12.0), for
 * the exact identity — repository, base, head, policy digest and versions —
 * so a rerun reviews only the shards that did not complete. `shards` maps an
 * assignment digest (what one reviewer was given) to its review; `failures`
 * counts consecutive failed runs per assignment. An unreadable record, one
 * for another identity, or one past `shardCheckpointMaxAgeMs` reads as
 * absent: the shards are then reviewed again. The age bound is each review's
 * own: a failed rerun rewrites the record, and must not make a review it
 * carried over any younger.
 */
export async function readShardCheckpoint(paths, identity, { now = Date.now() } = {}) {
  const target = path.join(paths.shardCheckpoints, attestationFileName(identity));
  let value;
  try {
    value = await readJson(target);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    await removeStoredJson(target);
    return null;
  }
  if (!value || value.schemaVersion !== 1 || !identityMatches(value, identity)) return null;
  const age = now - Date.parse(value.updatedAt);
  if (!Number.isFinite(age) || age < 0 || age > LIMITS.shardCheckpointMaxAgeMs) return null;
  const record = (field) => (field && typeof field === 'object' && !Array.isArray(field) ? field : {});
  const fresh = (entry) => {
    const reviewAge = now - Date.parse(entry?.completedAt);
    return Number.isFinite(reviewAge) && reviewAge >= 0 && reviewAge <= LIMITS.shardCheckpointMaxAgeMs;
  };
  return {
    ...value,
    shards: Object.fromEntries(Object.entries(record(value.shards)).filter(([, entry]) => fresh(entry))),
    failures: record(value.failures),
  };
}

export async function writeShardCheckpoint(paths, identity, { shards, failures }) {
  const value = {
    schemaVersion: 1,
    identity,
    updatedAt: new Date().toISOString(),
    shards,
    failures,
  };
  await atomicWriteJson(path.join(paths.shardCheckpoints, attestationFileName(identity)), value);
  await pruneDirectory(paths.shardCheckpoints, {
    maxFiles: LIMITS.maxShardCheckpoints,
    maxAgeMs: LIMITS.shardCheckpointMaxAgeMs,
  });
  return value;
}

export async function removeShardCheckpoint(paths, identity) {
  await removeStoredJson(path.join(paths.shardCheckpoints, attestationFileName(identity)));
}

export async function writeReport(paths, report) {
  const id = report.id || `${Date.now()}-${randomUUID()}`;
  const value = { ...report, id };
  await atomicWriteJson(path.join(paths.reports, `${id}.json`), value);
  await pruneDirectory(paths.reports, {
    maxFiles: LIMITS.maxReports,
    maxAgeMs: LIMITS.retentionMs,
  });
  return value;
}

/** A stored report by id, or null when pruned or absent. */
export async function readReport(paths, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) return null;
  const value = await readJson(path.join(paths.reports, `${id}.json`));
  return value && value.id === id ? value : null;
}

/**
 * The newest report whose identity matches exactly (repository, base, head,
 * policy digest, versions). Bounded by the report directory's retention.
 */
export async function findLatestReportForIdentity(paths, identity) {
  let entries;
  try {
    entries = await readdir(paths.reports, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const value = await readJson(path.join(paths.reports, entry.name));
    if (!value || !identityMatches(value, identity)) continue;
    if (!best || String(value.createdAt) > String(best.createdAt)) best = value;
  }
  return best;
}

/**
 * Rolling wall-clock and per-stage averages over the retained reports
 * (v1.8.0), so `npx --no-install rove-sentinel status` answers "where does the time go" from
 * evidence instead of memory. Wall clock is the span from the report's
 * creation to its last stage end; skipped/errored reports carry no stages
 * and are excluded.
 */
export async function reviewTimingSummary(paths) {
  let entries;
  try {
    entries = await readdir(paths.reports, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { full: null, followUp: null, stages: {} };
    throw error;
  }
  const rounds = { full: [], followUp: [] };
  const stageTotals = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const value = await readJson(path.join(paths.reports, entry.name));
    if (!value || !Array.isArray(value.stages) || !value.stages.length) continue;
    const start = Date.parse(value.createdAt);
    let end = start;
    for (const stage of value.stages) {
      const stageEnd = Date.parse(stage.startedAt) + (Number(stage.ms) || 0);
      if (Number.isFinite(stageEnd) && stageEnd > end) end = stageEnd;
      const totals = stageTotals.get(stage.name) || { ms: 0, count: 0 };
      totals.ms += Number(stage.ms) || 0;
      totals.count += 1;
      stageTotals.set(stage.name, totals);
    }
    if (!Number.isFinite(start)) continue;
    (value.round === 'follow-up' ? rounds.followUp : rounds.full).push(end - start);
  }
  const summarize = (list) => (list.length
    ? {
        count: list.length,
        averageMinutes: Number((list.reduce((sum, ms) => sum + ms, 0) / list.length / 60_000).toFixed(1)),
        maxMinutes: Number((Math.max(...list) / 60_000).toFixed(1)),
      }
    : null);
  const stages = {};
  for (const [name, totals] of stageTotals) {
    stages[name] = { count: totals.count, averageSeconds: Math.round(totals.ms / totals.count / 1000) };
  }
  return { full: summarize(rounds.full), followUp: summarize(rounds.followUp), stages };
}

function convergencePrefix(lineage) {
  return `${hashText(JSON.stringify(lineage), 40)}-`;
}

function lineagePrefixMatches(entry, prefix) {
  return entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json');
}

/**
 * Every reviewed head of a lineage (pass or fail), oldest first, with the
 * blocking findings it recorded. A follow-up round takes its incremental diff
 * from the closest reviewed ancestor and re-verifies that head's blocking
 * findings, so a repair is reviewed as a repair instead of as a fresh,
 * nondeterministic full review of the whole branch (v1.8.0).
 */
export async function readLineageReviews(paths, lineage) {
  const prefix = convergencePrefix(lineage);
  const entries = await readdir(paths.convergence, { withFileTypes: true });
  const reviews = [];
  for (const entry of entries) {
    if (!lineagePrefixMatches(entry, prefix)) continue;
    const value = await readJson(path.join(paths.convergence, entry.name));
    if (
      JSON.stringify(value?.lineage) !== JSON.stringify(lineage) ||
      typeof value?.headSha !== 'string'
    ) continue;
    if (value.type === 'lineage-review') {
      reviews.push({
        headSha: value.headSha,
        reportId: value.reportId ?? null,
        status: value.status,
        createdAt: value.createdAt,
        blockingFindings: Array.isArray(value.blockingFindings) ? value.blockingFindings : [],
        lateDiscoveries: Number.isInteger(value.lateDiscoveries) ? value.lateDiscoveries : 0,
        reviewedHeads: Number.isInteger(value.reviewedHeads) ? value.reviewedHeads : 0,
      });
    } else if (value.type === 'lineage-pass') {
      // Records written by gate <= 1.7.0.
      reviews.push({
        headSha: value.headSha,
        reportId: value.reportId ?? null,
        status: 'pass',
        createdAt: value.createdAt,
        blockingFindings: [],
        lateDiscoveries: 0,
        reviewedHeads: 0,
      });
    }
  }
  // Stable order: creation time, then head SHA, so equal-millisecond writes
  // cannot depend on filesystem enumeration order.
  return reviews.sort((a, b) => (
    String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.headSha).localeCompare(String(b.headSha))
  ));
}

/** Distinct exact heads of the lineage that passed. */
export async function readLineagePassHeads(paths, lineage) {
  const reviews = await readLineageReviews(paths, lineage);
  return [...new Set(reviews.filter((review) => review.status === 'pass').map((review) => review.headSha))];
}

/**
 * Record one immutable review event per exact head. Re-running a forced
 * review of the same SHA replaces the same small file, so a head can never
 * count twice.
 */
/**
 * Every retained lineage-review record of the same repository, branch and
 * merge base, whatever policy digest or versions it was reviewed under: the
 * repair-round budget measures the author's repair effort on this PR, and
 * a gate or charter bump the branch itself carried must not reset it.
 */
export async function readBranchReviews(paths, lineage) {
  let entries;
  try {
    entries = await readdir(paths.convergence, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const reviews = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const value = await readJson(path.join(paths.convergence, entry.name));
    if (!value || !['lineage-review', 'lineage-pass'].includes(value.type) || typeof value.headSha !== 'string') continue;
    const own = value.lineage || {};
    if (own.repository !== lineage.repository || own.branch !== lineage.branch || own.baseSha !== lineage.baseSha) continue;
    reviews.push({
      headSha: value.headSha,
      createdAt: value.createdAt,
      reviewedHeads: Number.isInteger(value.reviewedHeads) ? value.reviewedHeads : 0,
      samePolicy: JSON.stringify(own) === JSON.stringify(lineage),
      // Diagnostic: whether the record's policy differs by a gate/charter
      // version (any policy change — a bug-lesson edit too — restarts the
      // lineage, and the budget spans all of them, charter §4).
      versionBump: own.gateVersion !== lineage.gateVersion || own.charterVersion !== lineage.charterVersion,
    });
  }
  return reviews.sort((a, b) => (
    String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.headSha).localeCompare(String(b.headSha))
  ));
}

export async function recordLineageReview(paths, lineage, {
  headSha, reportId, status, blockingFindings = [], lateDiscoveries = 0, reviewedHeads = 0,
}) {
  const prefix = convergencePrefix(lineage);
  const target = path.join(paths.convergence, `${prefix}${hashText(headSha, 40)}.json`);
  await atomicWriteJson(target, {
    schemaVersion: 2,
    type: 'lineage-review',
    createdAt: new Date().toISOString(),
    lineage,
    headSha,
    reportId,
    status,
    blockingFindings: blockingFindings.map((finding) => ({
      key: finding.key,
      title: String(finding.title || '').slice(0, 300),
      file: String(finding.file || '').slice(0, 500),
      priority: finding.priority,
    })),
    lateDiscoveries,
    // Running counts (like lateDiscoveries) travel in every record, so the
    // repository-wide retention below cannot reset a lineage's budget while
    // its follow-up base record survives.
    reviewedHeads,
  });
  await pruneDirectory(paths.convergence, {
    maxFiles: LIMITS.maxConvergenceEvents,
    maxAgeMs: LIMITS.retentionMs,
  });
}

export async function recordLineagePass(paths, lineage, { headSha, reportId }) {
  await recordLineageReview(paths, lineage, { headSha, reportId, status: 'pass' });
}

/**
 * Author dispositions (v1.8.0): a verified advisory the author chose not to
 * fix, recorded with its reason. Keyed by finding identity within the
 * lineage, so the same defect stays deferred across later heads and the
 * decision is published in the PR comment instead of being lost.
 */
export async function recordDisposition(paths, lineage, {
  key, title, file, priority, reason, headSha, source = 'author', createdAt = null, previousFiles = [],
}, { prune = true, onPruneError = (error) => process.stderr.write(`Shared review gate: disposition retention prune failed: ${error?.message || error}\n`) } = {}) {
  if (typeof key !== 'string' || !key) throw new Error('A disposition needs a finding key.');
  if (typeof reason !== 'string' || reason.trim().length < 12) {
    throw new Error('A deferral reason must explain the decision (minimum 12 characters).');
  }
  const prefix = convergencePrefix(lineage);
  const target = path.join(paths.dispositions, `${prefix}${hashText(key, 40)}.json`);
  const value = {
    schemaVersion: 1,
    type: 'deferral',
    // A restore keeps the original decision's timestamp.
    createdAt: typeof createdAt === 'string' && createdAt ? createdAt : new Date().toISOString(),
    lineage,
    key,
    title: String(title || '').slice(0, 300),
    file: String(file || '').slice(0, 500),
    priority,
    reason: reason.trim().slice(0, 1000),
    headSha,
    source,
    // Earlier paths of a propagated record (bounded), so a later rename that
    // starts from one of them still reaches it.
    previousFiles: (Array.isArray(previousFiles) ? previousFiles : [])
      .filter((entry) => typeof entry === 'string' && entry)
      .slice(-10)
      .map((entry) => entry.slice(0, 500)),
  };
  await atomicWriteJson(target, value);
  // The write above is the commit; retention pruning is hygiene: a batch
  // prunes once at its end, and a prune failure is reported on stderr (the
  // next write retries it) instead of failing a durable decision.
  if (prune) await pruneDispositions(paths, { onPruneError });
  return value;
}

export async function pruneDispositions(paths, { onPruneError = () => {} } = {}) {
  try {
    await pruneDirectory(paths.dispositions, {
      maxFiles: LIMITS.maxDispositions,
      maxAgeMs: LIMITS.retentionMs,
    });
  } catch (error) {
    onPruneError(error);
  }
}

/**
 * Exclusive per-lineage lock for a disposition batch: created with O_EXCL,
 * holding the owner pid and time; a lock older than its TTL (a dead
 * process) is reclaimed. Returns the release function.
 */
export async function acquireDispositionLock(paths, lineage, {
  ttlMs = 5 * 60 * 1000, maxHoldMs = 30 * 60 * 1000, now = Date.now, isAlive = processIsAlive, beforeClaim = null,
} = {}) {
  const target = path.join(paths.dispositions, `${convergencePrefix(lineage)}batch.lock`);
  const reclaimTarget = `${target}.reclaim`;
  const token = randomUUID();
  const record = () => `${JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() })}\n`;
  const heldError = (holder) => new Error(`Another disposition command holds this lineage (pid ${holder?.pid ?? 'unknown'} since ${holder?.at ?? 'unknown'}); retry when it finishes.`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // No acquisition while a live reclaim is in progress: that is what lets
    // a reclaimer's rename move only the stale record it observed. A reclaim
    // mutex left by a dead process is removed like any stale lock.
    const reclaim = await readLockRecord(reclaimTarget);
    if (reclaim !== null) {
      if (!lockIsStale(reclaim, { now, ttlMs, maxHoldMs, isAlive })) throw heldError(reclaim.holder);
      const replaced = await removeObservedRecord(reclaimTarget, reclaim);
      if (replaced !== null) throw heldError(replaced.holder);
    }
    try {
      await writeFile(target, record(), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
      // The exclusive create is the claim; a reclaimer racing on a stale
      // predecessor could still have moved it aside, so the token installed
      // at the path is confirmed before the batch proceeds.
      const installed = await readLockRecord(target);
      if (installed?.holder?.token !== token) continue;
      // Release only the lock this acquisition wrote: a successor's lock is
      // never unlinked by a predecessor.
      return async () => {
        const current = await readLockRecord(target);
        if (current?.holder?.token === token) await rm(target, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const observed = await readLockRecord(target);
      if (observed === null) continue; // released meanwhile: retry the exclusive create
      if (!lockIsStale(observed, { now, ttlMs, maxHoldMs, isAlive })) throw heldError(observed.holder);
      // Reclaim under a mutex of its own (exclusive create): while it exists
      // no contender creates the lock, so the rename below moves the stale
      // record observed or finds it gone — never a successor's live lock.
      try {
        await writeFile(reclaimTarget, record(), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
      } catch (reclaimError) {
        if (reclaimError?.code === 'EEXIST') throw heldError((await readLockRecord(reclaimTarget))?.holder);
        throw reclaimError;
      }
      try {
        if (beforeClaim) await beforeClaim();
        // A contender that passed its reclaim check before this mutex
        // existed may still have created a live lock: it is put back and
        // the lineage reported as held — a successor's record is restored,
        // never deleted.
        const replaced = await removeObservedRecord(target, observed);
        if (replaced !== null) throw heldError(replaced.holder);
        continue;
      } finally {
        // Release only the mutex this reclaim wrote.
        const current = await readLockRecord(reclaimTarget);
        if (current?.holder?.token === token) await rm(reclaimTarget, { force: true });
      }
    }
  }
  throw new Error('Could not acquire the disposition lock after reclaiming a stale one.');
}

// Remove exactly the record observed at `target`, never a successor's:
// rename is atomic (of two removers one wins, the other finds nothing), the
// moved file is compared with the observation, and a different record — a
// live successor — is linked back (link refuses to overwrite a newer one) and
// returned instead of being deleted. Returns null when the observed record
// was removed or was already gone.
async function removeObservedRecord(target, observed) {
  const claimed = `${target}.stale-${randomUUID()}`;
  try {
    await rename(target, claimed);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const moved = await readLockRecord(claimed);
  // Identity: the token for a readable record; for an unreadable one (a
  // partial write, corruption) the exact bytes and mtime observed — a
  // successor caught mid-write differs in either and is therefore kept.
  const sameRecord = moved !== null && (
    observed.holder === null
      ? moved.holder === null && moved.text === observed.text && moved.mtimeMs === observed.mtimeMs
      : moved.holder?.token === observed.holder.token
  );
  if (sameRecord) {
    await rm(claimed, { force: true });
    return null;
  }
  try {
    await link(claimed, target);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await rm(claimed, { force: true });
  return moved ?? { holder: null };
}

async function readLockRecord(target) {
  let text;
  let mtimeMs;
  try {
    text = await readFile(target, 'utf8');
    mtimeMs = (await stat(target)).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let holder = null;
  try {
    const parsed = JSON.parse(text);
    holder = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    holder = null;
  }
  return { holder, text, mtimeMs };
}

// A readable record is stale exactly when its holder process is gone; age
// alone never proves death. A record without a usable holder (partial write,
// corruption) is stale only once its file is older than the TTL, so a lock
// caught between creation and its completed JSON is not reclaimed.
// A readable record is stale when its holder process is gone, or when it is
// older than the maximum hold: a disposition batch lasts seconds, and a pid
// reused by an unrelated process after a crash must not strand the lineage.
function lockIsStale({ holder, mtimeMs }, { now, ttlMs, maxHoldMs, isAlive }) {
  if (holder === null || !Number.isInteger(holder.pid)) return now() - mtimeMs > ttlMs;
  if (!isAlive(holder.pid)) return true;
  const age = holder.at ? now() - Date.parse(holder.at) : now() - mtimeMs;
  return Number.isFinite(age) && age > maxHoldMs;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function removeDisposition(paths, lineage, key) {
  const prefix = convergencePrefix(lineage);
  await removeStoredJson(path.join(paths.dispositions, `${prefix}${hashText(key, 40)}.json`));
}

export async function readDispositions(paths, lineage) {
  const prefix = convergencePrefix(lineage);
  let entries;
  try {
    entries = await readdir(paths.dispositions, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const deferrals = new Map();
  for (const entry of entries) {
    if (!lineagePrefixMatches(entry, prefix)) continue;
    const value = await readJson(path.join(paths.dispositions, entry.name));
    if (
      value?.type !== 'deferral' ||
      JSON.stringify(value.lineage) !== JSON.stringify(lineage) ||
      typeof value.key !== 'string' ||
      typeof value.reason !== 'string'
    ) continue;
    deferrals.set(value.key, {
      key: value.key,
      title: value.title,
      file: value.file,
      previousFiles: Array.isArray(value.previousFiles) ? value.previousFiles.filter((entry) => typeof entry === 'string') : [],
      priority: value.priority,
      reason: value.reason,
      headSha: value.headSha,
      at: value.createdAt,
      source: value.source,
    });
  }
  return deferrals;
}

export async function recordEvent(paths, event, { deferPrune = false } = {}) {
  const audit = event?.type === 'emergency-bypass' || event?.type === 'ref-deletion';
  const directory = audit ? paths.auditEvents : paths.events;
  const id = `${Date.now()}-${randomUUID()}`;
  await atomicWriteJson(path.join(directory, `${id}.json`), {
    at: new Date().toISOString(),
    ...event,
  });
  if (deferPrune) return;
  await pruneDirectory(directory, {
    maxFiles: audit ? LIMITS.maxAuditEvents : LIMITS.maxEvents,
    maxAgeMs: audit ? LIMITS.auditRetentionMs : LIMITS.retentionMs,
  });
}

export async function submitRequest(paths, request) {
  const release = await acquireQueueSubmissionLock(paths);
  try {
    const queued = (await readdir(paths.requests, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    );
    if (queued.length >= LIMITS.maxQueuedRequests) {
      throw new Error(`Shared review queue is full (${LIMITS.maxQueuedRequests} requests). Check npx --no-install rove-sentinel status before retrying.`);
    }
    const id = randomUUID();
    const value = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      ...request,
    };
    await atomicWriteJson(path.join(paths.requests, `${id}.json`), value);
    return value;
  } finally {
    await release();
  }
}

async function acquireQueueSubmissionLock(paths, { timeoutMs = 5_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let handle;
    try {
      const ownerToken = randomUUID();
      handle = await open(paths.queueSubmitLock, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, ownerToken })}\n`);
      await handle.close();
      handle = null;
      return async () => {
        let current;
        try {
          current = JSON.parse(await readFile(paths.queueSubmitLock, 'utf8'));
        } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw error;
        }
        if (current?.pid === process.pid && current?.ownerToken === ownerToken) {
          await rm(paths.queueSubmitLock, { force: true });
        }
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await rm(paths.queueSubmitLock, { force: true }).catch(() => {});
      }
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readFile(paths.queueSubmitLock, 'utf8')
        .then((value) => JSON.parse(value))
        .catch(() => null);
      if (Number.isInteger(owner?.pid) && owner.pid > 0 && !isProcessAlive(owner.pid)) {
        throw new Error(`Shared review queue submission lock belongs to dead PID ${owner.pid}; refusing automatic removal because another submitter may have replaced it. Inspect npx --no-install rove-sentinel status, then run npx --no-install rove-sentinel recover --reason "<why the owner is stale>" before retrying.`);
      }
      await sleep(25);
    }
  }
  throw new Error('Timed out reserving shared review queue capacity; retry the push after npx --no-install rove-sentinel status.');
}

export async function cancelQueuedRequest(paths, requestId) {
  await removeStoredJson(path.join(paths.requests, `${requestId}.json`));
}

function requestIdFromClaimName(claimName) {
  const requestNameEnd = claimName.indexOf('.json.');
  const requestFileName = requestNameEnd >= 0
    ? claimName.slice(0, requestNameEnd + 5)
    : null;
  return {
    requestFileName,
    requestId: requestFileName?.slice(0, -5) || null,
  };
}

async function failCorruptClaim(paths, claimName, target) {
  const { requestFileName, requestId } = requestIdFromClaimName(claimName);
  if (requestId) {
    await atomicWriteJson(path.join(paths.results, `${requestId}.json`), {
      schemaVersion: 1,
      requestId,
      completedAt: new Date().toISOString(),
      status: 'error',
      error: 'The shared review request was interrupted and its persisted claim became unreadable. Rerun the gate; no PASS was recorded.',
    });
    await rm(path.join(paths.claims, `${requestFileName}.lock`), { force: true });
  }
  await rm(target, { force: true });
}

export async function recoverClaims(paths) {
  const entries = await readdir(paths.claims, { withFileTypes: true });
  let recovered = 0;
  for (const entry of entries) {
    const target = path.join(paths.claims, entry.name);
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.lock')) {
      await removeStoredJson(target);
      continue;
    }
    if (!entry.name.endsWith('.claim')) continue;
    let request;
    try {
      request = await readJson(target);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await failCorruptClaim(paths, entry.name, target);
      continue;
    }
    const { requestId } = requestIdFromClaimName(entry.name);
    if (!requestId || request?.id !== requestId) {
      await failCorruptClaim(paths, entry.name, target);
      continue;
    }
    const completed = await readJson(path.join(paths.results, `${request.id}.json`));
    if (!completed) {
      await atomicWriteJson(path.join(paths.requests, `${request.id}.json`), request);
      recovered += 1;
    }
    await rm(target, { force: true });
  }
  return recovered;
}

export async function claimNextRequest(paths) {
  const entries = (await readdir(paths.requests, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const ordered = await Promise.all(entries.map(async (entry) => {
    const queued = await readJson(path.join(paths.requests, entry.name)).catch(() => null);
    const createdAt = Date.parse(queued?.createdAt);
    return { entry, createdAt: Number.isFinite(createdAt) ? createdAt : Number.POSITIVE_INFINITY };
  }));
  ordered.sort((a, b) => a.createdAt - b.createdAt || a.entry.name.localeCompare(b.entry.name));
  for (const { entry } of ordered) {
    const source = path.join(paths.requests, entry.name);
    const lockPath = path.join(paths.claims, `${entry.name}.lock`);
    const target = path.join(paths.claims, `${entry.name}.${process.pid}.${randomUUID()}.claim`);
    let lockHandle;
    try {
      lockHandle = await open(lockPath, 'wx', 0o600);
      await lockHandle.writeFile(`${process.pid}\n`);
      await lockHandle.close();
      await rename(source, target);
      const request = await readJson(target);
      if (request?.id !== entry.name.slice(0, -5)) {
        await failCorruptClaim(paths, path.basename(target), target);
        await rm(lockPath, { force: true });
        continue;
      }
      return { path: target, lockPath, request };
    } catch (error) {
      await lockHandle?.close().catch(() => {});
      if (error?.code === 'EEXIST') continue;
      await rm(lockPath, { force: true });
      if (error instanceof SyntaxError) {
        await failCorruptClaim(paths, path.basename(target), target);
        continue;
      }
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export async function hasQueuedRequests(paths) {
  const entries = await readdir(paths.requests, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'));
}

export async function completeRequest(paths, claim, result) {
  await atomicWriteJson(path.join(paths.results, `${claim.request.id}.json`), {
    schemaVersion: 1,
    requestId: claim.request.id,
    completedAt: new Date().toISOString(),
    ...result,
  });
  await rm(claim.path, { force: true });
  await rm(claim.lockPath, { force: true });
  await pruneDirectory(paths.results, {
    maxFiles: LIMITS.maxReports,
    maxAgeMs: LIMITS.retentionMs,
  });
}

export async function waitForResult(
  paths,
  requestId,
  {
    timeoutMs = LIMITS.hookWaitTimeoutMs,
    pollMs = LIMITS.queuePollMs,
    onProgress = () => {},
    shouldCancel = async () => null,
    signal,
  } = {},
) {
  const target = path.join(paths.results, `${requestId}.json`);
  const started = Date.now();
  let lastProgress = started;
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw signal.reason || new Error('Shared review wait aborted.');
    const result = await readJson(target);
    if (result) {
      await removeStoredJson(target);
      return result;
    }
    const cancellationReason = await shouldCancel();
    if (cancellationReason) {
      throw new Error(String(cancellationReason));
    }
    if (Date.now() - lastProgress >= LIMITS.hookProgressEveryMs) {
      lastProgress = Date.now();
      onProgress(Date.now() - started);
    }
    await sleep(pollMs, { signal });
  }
  throw new Error(`Timed out waiting for shared review request ${requestId}.`);
}

export async function pruneDirectory(directory, { maxFiles, maxAgeMs, now = Date.now() }) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  const auxiliaryFiles = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const targetList = entry.name.endsWith('.json')
      ? files
      : entry.name.endsWith('.json.previous') || entry.name.endsWith('.tmp')
        ? auxiliaryFiles
        : null;
    if (!targetList) continue;
    const target = path.join(directory, entry.name);
    const metadata = await stat(target).catch(() => null);
    if (metadata) targetList.push({ target, mtimeMs: metadata.mtimeMs });
  }
  const staleTargets = (candidates) => candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .filter((file, index) => index >= maxFiles || now - file.mtimeMs > maxAgeMs)
      .map((file) => file.target);
  await Promise.all(
    [...staleTargets(files), ...staleTargets(auxiliaryFiles)]
      .map((target) => rm(target, { force: true })),
  );
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function daemonOwnerIsHealthy(
  lock,
  heartbeat,
  { isAlive = isProcessAlive, now = Date.now, maxAgeMs = 60_000 } = {},
) {
  const ageMs = now() - Date.parse(heartbeat?.at);
  return Boolean(
    lock?.ownerToken &&
    lock.ownerToken === heartbeat?.ownerToken &&
    lock.pid === heartbeat?.pid &&
    isAlive(lock.pid) &&
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs <= maxAgeMs,
  );
}

export async function acquireDaemonLock(
  paths,
  {
    openFile = open,
    read = readJson,
    remove = rm,
    ownerPid = process.pid,
    ownerTokenFactory = randomUUID,
    isAlive = isProcessAlive,
  } = {},
) {
  const tryAcquire = async () => {
    const ownerToken = ownerTokenFactory();
    const handle = await openFile(paths.lock, 'wx', 0o600);
    let writeError;
    try {
      await handle.writeFile(`${JSON.stringify({ pid: ownerPid, ownerToken, startedAt: new Date().toISOString() })}\n`);
    } catch (error) {
      writeError = error;
    } finally {
      await handle.close().catch(() => {});
    }
    if (writeError) {
      await remove(paths.lock, { force: true });
      throw writeError;
    }
    return {
      ownerToken,
      async release() {
        const current = await read(paths.lock);
        if (current?.pid === ownerPid && current?.ownerToken === ownerToken) {
          await remove(paths.lock, { force: true });
        }
      },
    };
  };

  try {
    return await tryAcquire();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const missingLock = Symbol('missing daemon lock');
  let existing;
  try {
    existing = await read(paths.lock, missingLock);
  } catch (error) {
    throw new Error(`Review daemon lock is unreadable or still initializing; refusing to remove it during concurrent startup. Retry shortly, or inspect ${paths.root} and run npx --no-install rove-sentinel recover --reason "<why the owner is stale>" if it remains invalid. ${error?.message || String(error)}`);
  }
  if (existing === missingLock) return await tryAcquire();
  if (
    !Number.isInteger(existing?.pid) ||
    existing.pid <= 0 ||
    typeof existing?.ownerToken !== 'string' ||
    existing.ownerToken.length < 8
  ) {
    throw new Error(`Review daemon lock is invalid or still initializing; refusing to remove it during concurrent startup. Retry shortly, or inspect ${paths.root} and run npx --no-install rove-sentinel recover --reason "<why the owner is stale>" if it remains invalid.`);
  }
  const heartbeat = await read(paths.heartbeat).catch(() => null);
  if (daemonOwnerIsHealthy(existing, heartbeat)) return null;
  if (isAlive(existing?.pid)) {
    throw new Error(`Review daemon lock names live PID ${existing.pid} without a fresh matching owner heartbeat; refusing to trust a possibly reused PID. Inspect ${paths.root}, then run npx --no-install rove-sentinel recover --reason "<why the owner is stale>" to clear it without signaling that PID.`);
  }
  throw new Error(`Review daemon lock belongs to dead PID ${existing.pid}; refusing automatic removal because another starter may have replaced it. Inspect ${paths.root}, then run npx --no-install rove-sentinel recover --reason "<why the owner is stale>" before retrying.`);
}

export async function writeHeartbeat(paths, details = {}) {
  await atomicWriteJson(paths.heartbeat, {
    pid: process.pid,
    at: new Date().toISOString(),
    ...details,
  });
}

export async function clearDaemonError(paths) {
  await removeStoredJson(paths.daemonError);
}

export async function writeDaemonError(paths, error) {
  const message = String(error?.message || error || 'unknown startup error').slice(0, 2000);
  await atomicWriteJson(paths.daemonError, {
    schemaVersion: 1,
    at: new Date().toISOString(),
    message,
  });
  return message;
}

export async function waitForDaemonHeartbeat(
  paths,
  _requestingRepoRoot,
  { timeoutMs = 15_000, pollMs = 250, policyDigest } = {},
) {
  const started = Date.now();
  let incompatibleHeartbeat = null;
  while (Date.now() - started < timeoutMs) {
    const [lock, heartbeat, daemonError] = await Promise.all([
      readJson(paths.lock).catch(() => null),
      readJson(paths.heartbeat).catch(() => null),
      readJson(paths.daemonError).catch(() => null),
    ]);
    if (daemonError?.message) {
      throw new Error(`The shared review watcher could not start: ${daemonError.message} State: ${paths.root}`);
    }
    if (daemonOwnerIsHealthy(lock, heartbeat)) {
      if (
        heartbeat.gateVersion === GATE_VERSION &&
        heartbeat.charterVersion === CHARTER_VERSION &&
        (!policyDigest || heartbeat.policyDigest === policyDigest)
      ) {
        return heartbeat;
      }
      incompatibleHeartbeat = heartbeat;
    }
    await sleep(pollMs);
  }
  if (incompatibleHeartbeat) {
    throw new Error(`The running shared review watcher has policy identity ${incompatibleHeartbeat.gateVersion || 'unknown'}/${incompatibleHeartbeat.charterVersion || 'unknown'}/${incompatibleHeartbeat.policyDigest || 'unknown'}, but this caller requires ${GATE_VERSION}/${CHARTER_VERSION}/${policyDigest || 'any installed digest'}. Run npx --no-install rove-sentinel install from your trusted main checkout.`);
  }
  throw new Error('The shared review watcher did not produce a fresh matching owner heartbeat.');
}

export async function readPause(paths) {
  try {
    return await readJson(paths.paused);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('The shared review pause record is corrupt. Run npx --no-install rove-sentinel resume to clear it; unattested pushes remain blocked until then.', { cause: error });
  }
}

export async function pauseGate(paths, reason) {
  const normalized = String(reason || '').trim();
  if (normalized.length < 8) throw new Error('A pause reason of at least 8 characters is required.');
  const value = { pausedAt: new Date().toISOString(), reason: normalized };
  await atomicWriteJson(paths.paused, value);
  return value;
}

export async function resumeGate(paths) {
  let previous;
  try {
    previous = await readJson(paths.paused);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    previous = {
      corrupt: true,
      error: error?.message || String(error),
    };
  }
  await removeStoredJson(paths.paused);
  return previous;
}

export function sleep(milliseconds, { signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('Sleep aborted.'));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new Error('Sleep aborted.'));
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
