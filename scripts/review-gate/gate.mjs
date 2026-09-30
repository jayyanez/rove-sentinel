import { access } from 'node:fs/promises';
import path from 'node:path';
import { acquireReviewLease } from './maintenance.mjs';

import {
  createContextBundle,
  loadInstalledReviewPolicy,
  readOpenBugBriefs,
  reviewPolicySnapshot,
} from './context.mjs';
import {
  changedFiles,
  createDetachedWorktree,
  currentBranch,
  diffStats,
  excludedReviewFiles,
  findRepoRoot,
  inferAuthor,
  isAncestor,
  mergeBase,
  primaryRemote,
  readPatch,
  recoverStaleReviewResources,
  resolveCommit,
  resolveHeadSnapshot,
  runGit,
} from './git.mjs';
import { buildReferenceMap } from './refmap.mjs';
import { runDeterministicLanes } from './lint.mjs';
import {
  canonicalChangedPath,
  promptSafe,
  runCoordinator,
  runHypothesisReviewer,
  runReviewer,
  runScout,
  runShardReviewer,
} from './providers.mjs';
import {
  newProcessLaunchesBlocked,
  processTreeCleanupFailureCode,
  providerCleanupFailureDetail,
  providerCleanupFailureLatched,
  resetProviderCleanupLatch,
} from './process.mjs';
import { detectSubscriptions } from './subscriptions.mjs';
import { modelSettings, selectProviders, validateModelClients } from './modelSettings.mjs';
import { classifyRisk, reviewPlan } from './risk.mjs';
import { metadataOnlySections, partitionShards, renameMapFor, renamedPaths, splitPatchByFile } from './shards.mjs';
import { deferCommand } from './dispositions.mjs';
import { LIMITS } from './constants.mjs';
import {
  carriedFinding,
  renameTargetFor,
  advisoryFindings,
  applyConvergencePolicy,
  blockingFindings,
  convergenceLineage,
  findingKey,
  lateDiscoveriesConsumed,
  undisposedAdvisories,
} from './convergence.mjs';
import {
  acquireDispositionLock,
  attestationIdentity,
  ensureState,
  normalizeRepositoryIdentity,
  readAttestation,
  readDispositions,
  readBranchReviews,
  readLineageReviews,
  readReport,
  recordDisposition,
  removeDisposition,
  recordLineageReview,
  removeAttestation,
  stateRootFor,
  writeAttestation,
  writeReport,
} from './storage.mjs';

export const providerTreeCleanupFailureCode = processTreeCleanupFailureCode;

export function describeReviewerFailures(settled, reviewers) {
  return settled.flatMap((result, roleIndex) => result.status === 'rejected'
    ? [`${reviewers[roleIndex] || 'unknown'} reviewer role ${roleIndex}: ${result.reason?.message || String(result.reason)}`]
    : []);
}

/**
 * Why a launch is being skipped, naming the process whose cleanup failure
 * latched the fence: the generic refusal alone hid the cause (PR #519).
 */
export function launchFenceReason(kind) {
  const detail = providerCleanupFailureDetail();
  if (detail) return `${kind} launch skipped: a provider cleanup failure is active (${detail}).`;
  if (newProcessLaunchesBlocked()) return `${kind} launch skipped: the watcher is stopping and new process launches are blocked.`;
  return `${kind} launch skipped: a process-launch fence or provider cleanup failure is active.`;
}

/**
 * Retry wrapper for provider calls (scout, coordinator, reviewers): one
 * retry, EXCEPT after a provider-tree cleanup failure — retrying would
 * launch another provider process on top of an unverified tree, and a
 * successful retry would erase the only evidence of that tree (§5 fence).
 */
export async function runProviderWithOneRetry(task) {
  const fenced = () => (newProcessLaunchesBlocked() || providerCleanupFailureLatched()
    ? {
        status: 'rejected',
        reason: new Error(launchFenceReason('Provider')),
        retried: false,
      }
    : null);
  // The scout and the adjudication batches queue behind shards in the shared
  // pool, so a sibling may have latched a cleanup failure — or shutdown may
  // have raised the launch fence — before this task gets its slot. Check at
  // launch and again before the retry, exactly like the reviewer waves.
  const blockedBefore = fenced();
  if (blockedBefore) return blockedBefore;
  try {
    return { status: 'fulfilled', value: await task(), retried: false };
  } catch (first) {
    if (processTreeCleanupFailureCode(first)) {
      return { status: 'rejected', reason: first, retried: false };
    }
    if (fenced()) return { status: 'rejected', reason: first, retried: false };
    try {
      return { status: 'fulfilled', value: await task(), retried: true };
    } catch (second) {
      return { status: 'rejected', reason: second, retried: true };
    }
  }
}

/**
 * A shared launch pool (v1.8.0). The scout, the shard wave, the hypothesis
 * wave, and the adjudication batches all draw from ONE bounded set of
 * provider slots, so running them concurrently never bursts past
 * `providerConcurrency` subprocesses however the waves overlap.
 */
export function createLaunchPool(concurrency = LIMITS.providerConcurrency) {
  const size = Math.max(1, concurrency);
  let active = 0;
  const waiters = [];
  const acquire = () => new Promise((resolve) => {
    if (active < size) {
      active += 1;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    async run(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * Run async task thunks with at most `concurrency` in flight. Order of
 * results matches the input order. A caller may pass a shared pool so
 * several waves share one bound.
 */
export async function mapWithConcurrency(tasks, worker, concurrency = LIMITS.providerConcurrency, { pool } = {}) {
  const launch = pool || createLaunchPool(concurrency);
  return await Promise.all(tasks.map((task, index) => launch.run(() => worker(task, index))));
}

export async function settleReviewersWithRetry(tasks, { concurrency = LIMITS.providerConcurrency, pool } = {}) {
  // One retry total (charter: "retried once" — two attempts, never three),
  // and a provider-tree cleanup failure halts NEW launches instead of
  // retrying: an unverified process tree must not accumulate more provider
  // processes (§5 safety fence).
  let halted = false;
  return await mapWithConcurrency(tasks, async (task) => {
    if (halted) {
      return {
        status: 'rejected',
        // Name the process whose cleanup failure halted the lanes (the latch
        // kept it); the generic line hid the cause from every queued reviewer.
        reason: new Error(providerCleanupFailureDetail()
          ? launchFenceReason('Reviewer')
          : 'Reviewer launch halted after a provider process-tree cleanup failure.'),
        retried: false,
      };
    }
    // During watcher shutdown the process-launch fence is up: drain queued
    // lanes instead of spawning tasks that would each fail (and retry)
    // against the block. The cleanup latch closes the race where a cleanup
    // failure has occurred but its rejection has not yet reached any lane's
    // catch (and therefore the local halt flag).
    if (newProcessLaunchesBlocked() || providerCleanupFailureLatched()) {
      return {
        status: 'rejected',
        reason: new Error(launchFenceReason('Reviewer')),
        retried: false,
      };
    }
    try {
      return { status: 'fulfilled', value: await task(), retried: false };
    } catch (first) {
      if (processTreeCleanupFailureCode(first)) {
        halted = true;
        return { status: 'rejected', reason: first, retried: false };
      }
      // A sibling may have tripped the cleanup fence — or shutdown may have
      // raised the launch fence — while this task was in flight: re-check
      // before the retry, or the retry itself launches forbidden provider
      // work.
      if (halted || newProcessLaunchesBlocked() || providerCleanupFailureLatched()) {
        return { status: 'rejected', reason: first, retried: false };
      }
      try {
        return { status: 'fulfilled', value: await task(), retried: true };
      } catch (second) {
        if (processTreeCleanupFailureCode(second)) halted = true;
        return { status: 'rejected', reason: second, retried: true };
      }
    }
  }, concurrency, { pool });
}

/**
 * First provider-tree cleanup failure among settled reviewer results, if any.
 * The gate must fail closed on it even when sibling reviewers succeeded:
 * completing the review would leave unverified provider processes behind
 * without pausing automatic work.
 */
export function reviewerCleanupFailure(settled) {
  for (const result of settled) {
    if (result.status !== 'rejected') continue;
    const code = processTreeCleanupFailureCode(result.reason);
    if (code) return { code, reason: result.reason };
  }
  return null;
}

/**
 * Adjudication is skipped only when there is nothing to adjudicate, or when
 * a follow-up round carries P3 candidates alone: a follow-up's P2 candidate
 * IS adjudicated (v1.8.0) — the two unadjudicated cheap-follow-up P2s of the
 * 2026-09-01 audit both became CodeRabbit actionables.
 */
export function shouldSkipCoordinator(candidates, { followUp = false } = {}) {
  if (!candidates.length) return true;
  if (!followUp) return false;
  return candidates.every((candidate) => candidate.priority === 'P3');
}

/** Split candidates into fresh-context adjudication batches. */
export function adjudicationBatches(candidates, size = LIMITS.coordinatorBatchSize) {
  const batches = [];
  for (let index = 0; index < candidates.length; index += size) {
    batches.push(candidates.slice(index, index + size));
  }
  return batches;
}

function advisoryFromCandidate(candidate, reason) {
  return {
    candidate_id: candidate.id,
    title: candidate.title,
    priority: candidate.priority,
    file: candidate.file,
    line: candidate.line,
    disposition: 'advisory',
    reason,
    scenario: candidate.scenario,
    proposed_test: candidate.proposed_test,
    enforcement: 'advisory',
    adjudicatedDisposition: 'unadjudicated',
    advisoryReason: reason,
    requiresDisposition: false,
    findingKey: findingKey(candidate),
  };
}

export async function createGateContext(repoRootInput = process.cwd(), options = {}) {
  const repoRoot = await findRepoRoot(repoRootInput);
  const { name: remoteName, url: remote } = await primaryRemote(repoRoot, options.remoteName);
  const repository = normalizeRepositoryIdentity(remote, repoRoot);
  const stateRoot = options.stateRoot || stateRootFor(repository);
  const paths = await ensureState(stateRoot);
  return { repoRoot, remote, remoteName, repository, stateRoot, paths };
}

export function cleanCandidates(reviews) {
  const qualifying = reviews
    .flatMap((review) => review.candidates)
    .filter((candidate) => candidate.confidence >= 50);
  // Independent reviewers frequently converge on the same defect. Merging is
  // a deterministic IDENTITY merge, never a judgment call, so the key is the
  // full identity — file, integer line, priority, AND normalized title.
  // Same-location candidates with different titles may be distinct defects
  // and all reach adjudication. The survivor is the highest-confidence
  // candidate kept WHOLE (id, category, scenario, evidence, test all from
  // the same reviewer — never a stitched hybrid), annotated with how many
  // reviewers corroborated it.
  const normalizedTitle = (title) => String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const byKey = new Map();
  const candidates = [];
  for (const candidate of qualifying) {
    const key = Number.isInteger(candidate.line) && typeof candidate.file === 'string'
      ? `${candidate.file}\0${candidate.line}\0${candidate.priority}\0${normalizedTitle(candidate.title)}`
      : null;
    const existingIndex = key === null ? -1 : (byKey.has(key) ? byKey.get(key) : -1);
    if (existingIndex === -1) {
      if (key !== null) byKey.set(key, candidates.length);
      candidates.push({ ...candidate, corroboratingReviewers: 1 });
      continue;
    }
    const existing = candidates[existingIndex];
    const corroboratingReviewers = existing.corroboratingReviewers + 1;
    candidates[existingIndex] = candidate.confidence > existing.confidence
      ? { ...candidate, corroboratingReviewers }
      : { ...existing, corroboratingReviewers };
  }
  if (candidates.length > LIMITS.maxCandidates) {
    throw new Error(`Independent reviewers produced ${candidates.length} qualifying candidates; the bounded adjudication limit is ${LIMITS.maxCandidates}. The gate refuses to drop candidates or attest an incomplete review.`);
  }
  return candidates;
}

function assertAdjudicationCoverage(candidates, adjudication) {
  const expected = new Set(candidates.map((candidate) => candidate.id));
  const actual = new Set();
  for (const finding of adjudication.findings) {
    if (!expected.has(finding.candidate_id)) {
      throw new Error(`Coordinator returned unknown candidate_id ${finding.candidate_id}.`);
    }
    if (actual.has(finding.candidate_id)) {
      throw new Error(`Coordinator returned duplicate candidate_id ${finding.candidate_id}.`);
    }
    actual.add(finding.candidate_id);
  }
  const missing = [...expected].filter((id) => !actual.has(id));
  if (missing.length) throw new Error(`Coordinator omitted candidate_id(s): ${missing.join(', ')}.`);
}

/**
 * For a follow-up round, pick the reviewed lineage head (pass OR fail) the
 * incremental diff should be taken from: an ancestor of the current head
 * whose report still exists, and among several the closest one. Returns null
 * when no reviewed head is a usable ancestor (e.g. after a rebase) — the
 * head then receives a full review.
 */
export async function selectFollowUpBase(repoRoot, priorReviews, headSha, {
  countCommits = async (from, to) => Number(await runGit(repoRoot, [
    'rev-list', '--count', `${from}..${to}`,
  ])),
  ancestorCheck = (ancestor, descendant) => isAncestor(repoRoot, ancestor, descendant),
  // The lineage record alone is not proof that the head was reviewed: the
  // report is the review. A pruned or missing report escalates to a full
  // review rather than granting a reduced plan on a record's word.
  reviewCheck = async () => true,
} = {}) {
  let best = null;
  for (const review of priorReviews) {
    const passHead = typeof review === 'string' ? review : review.headSha;
    if (passHead === headSha) continue;
    try {
      if (!(await reviewCheck(review))) continue;
      if (!(await ancestorCheck(passHead, headSha))) continue;
      const distance = await countCommits(passHead, headSha);
      if (!Number.isFinite(distance)) continue;
      if (!best || distance < best.distance) best = { passHead, distance };
    } catch {
      continue;
    }
  }
  return best?.passHead ?? null;
}

/**
 * Persist an error report best-effort and ALWAYS return the fail-closed
 * error carrying its classification. A failed report write must never
 * replace the error — losing a process-tree cleanup code there would stop
 * the watcher's mandatory pause, letting later runs launch more providers
 * on top of an unverified tree (§5 fence).
 */
export async function buildFailClosedError({ paths, baseReport, summary, errors, code = null, extra = {} }) {
  let report = null;
  let persistError = null;
  try {
    report = await writeReport(paths, {
      ...baseReport,
      status: 'error',
      summary,
      errors,
      ...extra,
    });
  } catch (error) {
    persistError = error;
  }
  const detail = [
    ...errors,
    ...(persistError ? [`Report persistence also failed: ${persistError.message || String(persistError)}`] : []),
  ].join(' | ');
  const wrapped = new Error(`${summary} ${detail}`);
  wrapped.reportId = report?.id ?? null;
  if (code) wrapped.code = code;
  return wrapped;
}

function reportBase({ identity, branch, author, risk, riskReasons, files, excludedFiles, metadataOnlyFiles = [], stats, plan }) {
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    identity,
    branch,
    author,
    risk,
    riskReasons,
    files,
    excludedFiles,
    metadataOnlyFiles,
    stats,
    plan,
  };
}

export async function reconcileCleanupFailure({
  cleanupErrors,
  operationError,
  completedResult,
  revokePass,
}) {
  if (!cleanupErrors.length) return;
  const messages = cleanupErrors.map((error) => error?.message || String(error));
  const detail = messages.join(' | ');
  const cleanupCode = cleanupErrors
    .map(providerTreeCleanupFailureCode)
    .find((code) => code === 'ORPHANED_PROCESS_TREE') ||
    cleanupErrors.map(providerTreeCleanupFailureCode).find(Boolean) ||
    null;
  if (operationError) {
    operationError.message = `${operationError.message} Cleanup also failed: ${detail}`;
    if (cleanupCode && !providerTreeCleanupFailureCode(operationError)) {
      operationError.code = cleanupCode;
    }
    return;
  }
  if (completedResult && completedResult.status !== 'pass') {
    completedResult.cleanupErrors = messages;
    completedResult.summary = `${completedResult.summary} Temporary resource cleanup also failed: ${detail}`;
    if (cleanupCode) {
      const cleanupError = new Error(`Review result was preserved but process-tree cleanup could not be verified: ${detail}`);
      cleanupError.code = cleanupCode;
      cleanupError.reportId = completedResult.reportId ?? null;
      cleanupError.completedResult = completedResult;
      throw cleanupError;
    }
    return;
  }
  await revokePass();
  const cleanupError = new Error(`Review completed but temporary resource cleanup failed: ${detail}`);
  if (cleanupCode) cleanupError.code = cleanupCode;
  cleanupError.reportId = completedResult?.reportId ?? null;
  cleanupError.completedResult = completedResult ?? null;
  throw cleanupError;
}

/** Stage telemetry (v1.8.0): where the wall clock of a review actually goes. */
export function createStageClock() {
  const stages = [];
  return {
    async time(name, task) {
      const startedAt = Date.now();
      try {
        return await task();
      } finally {
        stages.push({ name, startedAt: new Date(startedAt).toISOString(), ms: Date.now() - startedAt });
      }
    },
    snapshot() {
      return stages.map((stage) => ({ ...stage }));
    },
  };
}

/**
 * Follow-up shards (v1.8.0): the incremental diff, plus a re-verification
 * shard for every prior-blocker file the increment does not touch, built
 * from that file's full-branch hunks — a blocker outside the increment must
 * still be handed to a reviewer, or a persisting defect silently vanishes
 * from enforcement (gate self-review).
 */
export function followUpShards({
  followUpPatch, patch, incrementFiles, priorBlocking, maxShards, excludedFiles = [],
}) {
  const bound = Math.max(1, maxShards);
  const fullSections = splitPatchByFile(patch);
  // A blocker's file may have been renamed by the repair: its new section
  // covers the old path, so the re-verification shard follows the rename.
  const renamedTo = new Map([...renamedPaths(patch), ...renamedPaths(followUpPatch)]);
  // Only an increment file with a textual hunk is read by an incremental
  // shard: a file the repair merely renamed (or that is binary) owns no
  // shard, so a blocker in it still needs its re-verification shard.
  const textualIncrement = new Set(splitPatchByFile(followUpPatch)
    .filter((section) => !section.metadataReason)
    .map((section) => section.file));
  const covered = new Set((incrementFiles || []).filter((file) => textualIncrement.has(file)));
  const uncovered = [...new Set((priorBlocking || [])
    .map((finding) => String(finding.file || ''))
    .map((file) => (renamedTo.has(file) ? renamedTo.get(file) : file))
    .filter((file) => file && !covered.has(file)))];
  const sections = uncovered.length
    ? fullSections.filter((section) => uncovered.includes(section.file))
    : [];
  if (!sections.length) return partitionShards(followUpPatch, { maxShards: bound, excludedFiles });
  // The re-verification shards share the round's shard cap with the
  // incremental ones: the wave never exceeds maxShards reviewers.
  const incremental = partitionShards(followUpPatch, { maxShards: Math.max(1, bound - 1), excludedFiles });
  const reverifyPatch = `${sections.map((section) => section.text).join('\n')}\n`;
  const reverify = partitionShards(reverifyPatch, {
    maxShards: Math.max(1, bound - incremental.length), excludedFiles,
  }).map((shard) => ({ ...shard, reverify: true }));
  return [...incremental, ...reverify].map((shard, index) => ({ ...shard, index }));
}

// A recorded deferral removes a prior blocker from the set — except a P0/P1
// (a P2 deferred earlier and re-adjudicated up keeps its key), which no
// deferral can soften and which must reach carriedFinding's always-blocking
// rule.
export function priorBlockingFromReviews(reviews, deferrals) {
  const byKey = new Map();
  for (const review of reviews) {
    for (const finding of review.blockingFindings || []) {
      if (!finding?.key) continue;
      const alwaysBlocking = finding.priority === 'P0' || finding.priority === 'P1';
      if (!alwaysBlocking && deferrals.has(finding.key)) continue;
      byKey.set(finding.key, finding);
    }
  }
  return byKey;
}

export async function runGate(options = {}) {
  const context = await createGateContext(options.repoRoot || process.cwd(), { stateRoot: options.stateRoot });
  const release = await acquireReviewLease(context.paths);
  try { return await runGateWithLease(options); }
  finally { await release(); }
}

async function runGateWithLease({
  repoRoot: repoRootInput = process.cwd(),
  base = 'origin/main',
  head = 'HEAD',
  branch: branchOverride,
  author: authorOverride = 'auto',
  risk: riskOverride,
  nativeEvidence,
  force = false,
  dryRun = false,
  progress = () => {},
  reviewer = runReviewer,
  // One injected `reviewer` seam serves both the lens fallback and the shard
  // wave (tests), unless a dedicated shard reviewer is supplied.
  shardReviewer = reviewer === runReviewer ? runShardReviewer : reviewer,
  hypothesisReviewer = runHypothesisReviewer,
  scout = runScout,
  coordinator = runCoordinator,
  deterministicLanes = runDeterministicLanes,
  policy,
  stateRoot,
  availableProviders,
} = {}) {
  const context = await createGateContext(repoRootInput, { stateRoot });
  // Reviews are serialized (one per daemon, or one foreground run); the
  // cleanup latch belongs to the run that observes the failure. Cross-run
  // policy (pause until operator recovery) is the watcher's job.
  resetProviderCleanupLatch();
  const reviewPolicy = policy
    ? reviewPolicySnapshot(policy)
    : await loadInstalledReviewPolicy(context.paths);
  await recoverStaleReviewResources(context.repoRoot);
  // The branch selects lineage history and author deferrals, so the commit
  // and the branch name must come from ONE observation of the checkout: for
  // the `HEAD` form both are read by a single git process; an explicit head
  // is additionally required to sit on the checked-out branch.
  const requestedBaseSha = await resolveCommit(context.repoRoot, base);
  let headSha;
  let branch;
  if (head === 'HEAD' && branchOverride === undefined) {
    const snapshot = await resolveHeadSnapshot(context.repoRoot);
    headSha = snapshot.sha;
    branch = snapshot.branch;
  } else {
    [headSha, branch] = await Promise.all([
      resolveCommit(context.repoRoot, head),
      branchOverride === undefined ? currentBranch(context.repoRoot) : Promise.resolve(branchOverride),
    ]);
  }
  if (branchOverride === undefined && branch && head !== 'HEAD') {
    const branchTip = await resolveCommit(context.repoRoot, branch).catch(() => null);
    const onBranch = branchTip === headSha ||
      (branchTip !== null && await isAncestor(context.repoRoot, headSha, branchTip).catch(() => false));
    if (!onBranch) {
      throw new Error(`The review target ${headSha.slice(0, 12)} is not on the checked-out branch ${branch} (tip ${String(branchTip || 'unknown').slice(0, 12)}), so its lineage cannot be inferred: rerun the gate after the checkout settles, or pass --branch explicitly.`);
    }
  }
  const baseSha = await mergeBase(context.repoRoot, requestedBaseSha, headSha);
  const identity = attestationIdentity({
    repository: context.repository,
    baseSha,
    headSha,
    policyDigest: reviewPolicy.policyDigest,
  });
  if (!force && !dryRun) {
    let existing;
    try {
      existing = await readAttestation(context.paths, identity);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await removeAttestation(context.paths, identity);
    }
    if (existing) {
      return { ...existing, cached: true, reportId: existing.reportId ?? null };
    }
  } else if (force && !dryRun) {
    await removeAttestation(context.paths, identity);
  }

  const [files, stats, patch] = await Promise.all([
    changedFiles(context.repoRoot, baseSha, headSha),
    diffStats(context.repoRoot, baseSha, headSha),
    readPatch(context.repoRoot, baseSha, headSha),
  ]);
  const excludedFiles = excludedReviewFiles(files);
  // Changes with no text to read own no shard; the context lists them.
  const metadataOnlyFiles = metadataOnlySections(patch, { excludedFiles });
  const risk = classifyRisk({
    config: reviewPolicy.config,
    files,
    patch,
    changedLines: stats.changedLines,
    override: riskOverride,
  });
  let subscriptions;
  const selectedProviders = risk.level === 'skip' ? [] : dryRun || availableProviders !== undefined || reviewer !== runReviewer
    ? selectProviders(reviewPolicy.config.providers ?? 'auto', availableProviders ?? ['claude', 'codex'])
    : (subscriptions = await detectSubscriptions(context.repoRoot, { mode: reviewPolicy.config.providers ?? 'auto' })).selected;
  if (subscriptions) validateModelClients(reviewPolicy.config, subscriptions);
  const providerExecutions = [];
  const author = inferAuthor(branch, authorOverride);
  const lineage = convergenceLineage(identity, branch);
  const lineageReviews = risk.level === 'skip'
    ? []
    : await readLineageReviews(context.paths, lineage);
  const deferrals = risk.level === 'skip'
    ? new Map()
    : await readDispositions(context.paths, lineage);
  // A follow-up round is justified by ATTENTION FOCUS: the incremental diff
  // since the closest REVIEWED ancestor (pass or fail) is what the shard wave
  // reviews, and that head's blocking findings are re-verified explicitly.
  // Reviewing a repair as a repair — instead of as a fresh, nondeterministic
  // full review of the whole branch — is what keeps a repair loop finite
  // (v1.8.0). After a rebase no reviewed head is an ancestor, so the head
  // gets a full review.
  let followUpBaseSha = null;
  let followUpPatch = null;
  let incrementFiles = null;
  // `--force` discards the cached attestation, never the round shape: a
  // forced rerun of a follow-up head must classify exactly as it did.
  if (lineageReviews.some((review) => review.headSha !== headSha)) {
    try {
      followUpBaseSha = await selectFollowUpBase(context.repoRoot, lineageReviews, headSha, {
        reviewCheck: async (review) => Boolean(review.reportId && await readReport(context.paths, review.reportId)),
      });
      if (followUpBaseSha) {
        followUpPatch = await readPatch(context.repoRoot, followUpBaseSha, headSha);
        incrementFiles = await changedFiles(context.repoRoot, followUpBaseSha, headSha);
      }
    } catch {
      followUpBaseSha = null;
      followUpPatch = null;
      incrementFiles = null;
    }
  }
  const followUp = followUpBaseSha !== null && typeof followUpPatch === 'string';
  const round = followUp ? 'follow-up' : 'full';
  const plan = reviewPlan(risk.level, author, { followUp, providers: selectedProviders });
  // Only reviews of ANCESTOR heads carry blockers into this head: after a
  // divergent force-push the abandoned side's findings are not this head's.
  const ancestorReviews = [];
  for (const review of lineageReviews) {
    if (review.headSha === headSha) continue;
    try {
      if (await isAncestor(context.repoRoot, review.headSha, headSha)) ancestorReviews.push(review);
    } catch {
      // An unresolvable head (pruned object) carries nothing forward.
    }
  }
  // The closest reviewed ancestor's record IS the current blocker state
  // (every round re-verifies or carries every blocker it inherited), so only
  // that snapshot carries blockers forward; older ancestors' cleared keys do
  // not resurrect.
  const followUpReview = followUpBaseSha
    ? ancestorReviews.filter((review) => review.headSha === followUpBaseSha)
    : [];
  const priorBlocking = priorBlockingFromReviews(followUpReview, deferrals);
  const lateDiscoveriesUsed = ancestorReviews.reduce(
    (max, review) => Math.max(max, review.lateDiscoveries || 0),
    0,
  );
  // The count travels in each record (like late discoveries): the closest
  // ancestor's record alone yields the budget used, so repository-wide
  // retention pruning of older ancestors cannot reset it. The ancestor count
  // covers records written before the field existed.
  // A forced rerun of this same head keeps the count its own record carries
  // (retention may have pruned every ancestor by then).
  const ownRecord = lineageReviews.find((review) => review.headSha === headSha);
  // The budget is the BRANCH's on this base: heads reviewed under an earlier
  // policy digest or gate/charter version the branch itself bumped count
  // too (charter §4) — a bump restarts the lineage, never the author's
  // repair effort. Only ancestors of this head count, as within a lineage.
  const branchReviews = risk.level === 'skip' ? [] : await readBranchReviews(context.paths, lineage);
  const branchAncestors = [];
  for (const review of branchReviews) {
    if (review.samePolicy || review.headSha === headSha) continue;
    try {
      if (await isAncestor(context.repoRoot, review.headSha, headSha)) branchAncestors.push(review);
    } catch {
      // An unresolvable head carries nothing forward.
    }
  }
  // One slot per exact head: a head reviewed under two policies is one head.
  const reviewedAncestorHeads = new Set([...ancestorReviews, ...branchAncestors].map((review) => review.headSha));
  const repairRoundsUsed = Math.max(
    reviewedAncestorHeads.size,
    ...ancestorReviews.map((review) => review.reviewedHeads || 0),
    ...branchAncestors.map((review) => review.reviewedHeads || 0),
    Math.max(0, (ownRecord?.reviewedHeads || 0) - 1),
  );
  const convergence = {
    round,
    followUpBaseSha,
    repairRoundsUsed,
    repairRoundBudget: LIMITS.lineageRepairRoundBudget,
    priorBlockingFindings: priorBlocking.size,
    lateDiscoveriesUsed,
    lateDiscoveryQuota: LIMITS.lateDiscoveryBlockingQuota,
    deferrals: deferrals.size,
  };
  const baseReport = {
    ...reportBase({
      identity,
      branch,
      author,
      risk: risk.level,
      riskReasons: risk.reasons,
      files,
      excludedFiles,
      metadataOnlyFiles,
      stats,
      plan,
    }),
    convergence,
    providerSelection: selectedProviders,
    providerSelectionVerified: Boolean(subscriptions),
    modelDiversity: selectedProviders.length > 1 ? 'multiple-providers' : selectedProviders.length === 1 ? 'single-provider' : 'no-model-review',
    modelSettings: modelSettings(reviewPolicy.config),
    providerExecutions,
  };

  if (dryRun) {
    return { status: 'planned', ...baseReport };
  }

  if (risk.level === 'skip') {
    const report = await writeReport(context.paths, {
      ...baseReport,
      status: 'pass',
      mode: 'skipped',
      summary: risk.reasons.join('; '),
      findings: [],
    });
    return await writeAttestation(context.paths, identity, {
      risk: risk.level,
      mode: 'skipped',
      summary: report.summary,
      providers: [],
      reportId: report.id,
      providerSelection: selectedProviders,
      modelSettings: modelSettings(reviewPolicy.config),
    });
  }

  const clock = createStageClock();
  progress(`Preparing isolated ${headSha.slice(0, 12)} review (${risk.level} risk, ${round} round).`);
  const worktree = await createDetachedWorktree(context.repoRoot, headSha);
  let bundle;
  let operationError;
  let completedResult;
  try {
    // Deterministic pre-computed evidence (v1.6.0): repository-wide usage
    // sites of changed symbols, untouched co-change siblings, and the open
    // bug briefs matching changed paths. Seconds of Git work that every
    // reviewer would otherwise have to spend its small read budget on. Both
    // degrade to an explicit placeholder rather than failing the review.
    progress('Building deterministic reference map and invariant context.');
    let referenceMap = '';
    let openBriefs = '';
    await clock.time('reference-map', async () => {
      try {
        referenceMap = await buildReferenceMap({
          checkout: worktree.checkout, headSha, patch, files,
        });
      } catch {
        referenceMap = '';
      }
      try {
        openBriefs = await readOpenBugBriefs(worktree.checkout, files);
      } catch {
        openBriefs = '';
      }
    });
    bundle = await createContextBundle({
      checkout: worktree.checkout,
      policyRoot: context.repoRoot,
      policy: reviewPolicy,
      baseSha,
      headSha,
      branch,
      author,
      risk: risk.level,
      riskReasons: risk.reasons,
      files,
      excludedFiles,
      metadataOnlyFiles,
      stats,
      patch,
      referenceMap,
      openBriefs,
      followUpPatch,
      followUpBaseSha,
    });

    bundle.modelConfig = reviewPolicy.config;
    bundle.providerExecutions = providerExecutions;

    // Deterministic lanes (v1.8.0) run alongside everything else. They can
    // only reject through the process-tree fence, which must reach the same
    // fail-closed path as a provider cleanup failure.
    const lanesPromise = clock.time('deterministic-lanes', () => deterministicLanes({
      config: reviewPolicy.config,
      checkout: worktree.checkout,
      files,
      patch,
      stateRoot: context.stateRoot,
    })).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    );

    // The shard wave starts immediately; the scout runs beside it and its
    // hypotheses join the same pool when it returns. Nothing model-side waits
    // for the scout any more (v1.8.0).
    const pool = createLaunchPool(LIMITS.providerConcurrency);
    // The scout takes the FIRST pool slot: submitted before the shard wave,
    // so eight shards on eight slots cannot serialize it behind them (gate
    // self-review, 1.8.0). Its promise is awaited after the wave is launched.
    const reviewerErrors = [];
    let scoutFailed = false;
    let hypotheses = [];
    let hypothesisProviders = [];
    let hypothesisPromise = Promise.resolve([]);
    const scoutPromise = plan.useScout
      ? clock.time('scout', () => pool.run(() => runProviderWithOneRetry(() => scout({
        provider: plan.coordinator,
        checkout: worktree.checkout,
        bundle,
        maxHypotheses: plan.maxHypotheses,
      }))))
      : null;
    // Prior blockers travel to the shard prompts under the path the repair
    // gave their file, so the re-verification instruction lands in the shard
    // that now holds it.
    // Renames show up in the incremental diff (a file the branch itself
    // added is merely "added" in the full patch), so both are consulted —
    // on a full round too, so a recorded deferral still follows its file
    // when retention forced the full review.
    const renamedTo = renameMapFor(patch, followUpPatch);
    const priorBlockingList = followUp
      ? [...priorBlocking.values()].map((finding) => (
        renamedTo.has(finding.file) ? { ...finding, file: renamedTo.get(finding.file) } : finding
      ))
      : [];
    const shards = followUp
      ? followUpShards({
        followUpPatch, patch, incrementFiles, priorBlocking: priorBlockingList, maxShards: plan.maxShards, excludedFiles,
      })
      : partitionShards(patch, { maxShards: plan.maxShards, excludedFiles });
    // A prior blocker in a file no shard holds (a usage-site file the branch
    // never changed) is flagged so every shard reviewer may re-verify it by
    // reading the file at head.
    const shardedFiles = new Set(shards.flatMap((shard) => shard.files));
    const unassignedBlockers = priorBlockingList.filter((finding) => !shardedFiles.has(finding.file));
    // Each unassigned blocker gets exactly ONE owning shard (round-robin),
    // and a shard never owns more than its result bound can carry. A blocker
    // no shard can own this round is NOT lost: it is carried forward below as
    // still present, so it keeps blocking until a round re-verifies it.
    const carriedForward = [];
    // In-shard blockers a shard can re-verify are bounded by its result
    // budget too; the excess is carried forward (still blocking), never
    // silently omitted by a compliant reviewer.
    const inShardCap = LIMITS.maxCandidates - LIMITS.shardMaxCandidates;
    for (const shard of shards) {
      const inShard = priorBlockingList.filter((finding) => shard.files.includes(finding.file));
      shard.reverifyBlockers = inShard.slice(0, inShardCap);
      carriedForward.push(...inShard.slice(inShardCap));
      shard.unassignedBlockers = [];
    }
    const capacity = (shard) => LIMITS.maxCandidates - LIMITS.shardMaxCandidates
      - shard.reverifyBlockers.length
      - shard.unassignedBlockers.length;
    unassignedBlockers.forEach((finding, index) => {
      const owner = shards.length
        ? [...shards].sort((a, b) => capacity(b) - capacity(a))[0]
        : null;
      if (owner && capacity(owner) > 0) owner.unassignedBlockers.push(finding);
      else if (shards.length) carriedForward.push(finding);
      // With no shard at all the lens reviewers receive the whole list.
      void index;
    });
    const shardProviders = shards.map((_, index) => plan.reviewers[index % plan.reviewers.length]);
    progress(`Reviewing ${shards.length} shard(s)${plan.useScout ? ` while scouting up to ${plan.maxHypotheses} hypotheses` : ''}.`);
    // The prior-blocker list travels as a bundle file, never inline in the
    // provider's argument vector: fifty persisted entries would exceed the
    // Windows command-line limit and fail every shard.
    const priorBlockingPath = priorBlockingList.length
      ? await bundle.writeArtifact('prior-blocking.md', [
        '# Prior blocking findings to re-verify',
        '',
        // Model-produced text, escaped exactly like the inline prompt list.
        ...priorBlockingList.map((finding) => `- ${promptSafe(finding.priority)} ${promptSafe(finding.file)} — ${promptSafe(finding.title)}`),
        ...shards.flatMap((shard) => (shard.unassignedBlockers?.length ? [
          '',
          `## owned by shard ${shard.index + 1} (files no shard holds)`,
          '',
          ...shard.unassignedBlockers.map((finding) => `- ${promptSafe(finding.priority)} ${promptSafe(finding.file)} — ${promptSafe(finding.title)}`),
        ] : [])),
        '',
      ].join('\n'))
      : null;
    const shardTasks = shards.map((shard, index) => () => shardReviewer({
      provider: shardProviders[index],
      roleIndex: index,
      lane: 'shard',
      round,
      checkout: worktree.checkout,
      bundle,
      shard,
      priorBlocking: priorBlockingList,
      priorBlockingPath,
    }));
    const shardPromise = clock.time('shards', () => settleReviewersWithRetry(shardTasks, { pool }));

    if (scoutPromise) {
      const scoutAttempt = await scoutPromise;
      if (scoutAttempt.status === 'fulfilled') {
        hypotheses = (scoutAttempt.value?.hypotheses || []).slice(0, plan.maxHypotheses);
      } else {
        // A scout that left an unverified provider process tree fails the
        // review closed: launching more work on top of it would violate the
        // §5 fence. Let the in-flight shard wave settle first so its own
        // cleanup evidence is not lost.
        const scoutCleanupCode = processTreeCleanupFailureCode(scoutAttempt.reason);
        if (scoutCleanupCode) {
          await shardPromise;
          await lanesPromise;
          throw await buildFailClosedError({
            paths: context.paths,
            baseReport,
            summary: 'The scout provider process tree could not be verifiably cleaned up; the gate failed closed without spending further provider work.',
            errors: [scoutAttempt.reason?.message || String(scoutAttempt.reason)],
            code: scoutCleanupCode,
          });
        }
        scoutFailed = true;
        reviewerErrors.push(`scout: ${scoutAttempt.reason?.message || String(scoutAttempt.reason)}`);
      }
      if (hypotheses.length) {
        progress(`Testing ${hypotheses.length} narrow hypothes${hypotheses.length === 1 ? 'is' : 'es'}.`);
        hypothesisProviders = hypotheses.map((_, roleIndex) => plan.reviewers[roleIndex % plan.reviewers.length]);
        // Hypothesis role indexes are offset past the shard wave so candidate
        // ids stay unique across both waves.
        const hypothesisTasks = hypotheses.map((hypothesis, roleIndex) => () => hypothesisReviewer({
          provider: hypothesisProviders[roleIndex],
          roleIndex: shards.length + roleIndex,
          checkout: worktree.checkout,
          bundle,
          hypothesis,
        }));
        hypothesisPromise = clock.time('hypotheses', () => settleReviewersWithRetry(hypothesisTasks, { pool }));
      }
    }
    const settledShards = await shardPromise;
    const settledHypotheses = await hypothesisPromise;
    // A shard-less diff (every changed file excluded from the textual patch
    // or without a textual hunk)
    // still gets the lens reviewer, so no reviewable head goes unreviewed.
    let settledLens = [];
    if (!shards.length) {
      progress(`Running ${plan.reviewers.length} bounded lens reviewer(s).`);
      // With no shard to own them, the lens reviewers re-verify the prior
      // blockers (as a bundle file) — as many as their result bound can
      // carry alongside new findings; the rest is carried forward.
      const lensCap = LIMITS.maxCandidates - LIMITS.maxReviewerCandidates;
      const lensBlockers = priorBlockingList.slice(0, lensCap);
      carriedForward.push(...priorBlockingList.slice(lensCap));
      settledLens = await clock.time('lens', () => settleReviewersWithRetry(
        plan.reviewers.map((provider, roleIndex) => () =>
          reviewer({
            provider, roleIndex, checkout: worktree.checkout, bundle, round, priorBlocking: lensBlockers, priorBlockingPath,
          })),
        { pool },
      ));
      reviewerErrors.push(...describeReviewerFailures(settledLens, plan.reviewers));
    }
    const settledReviewers = [...settledShards, ...settledHypotheses, ...settledLens];
    reviewerErrors.push(...describeReviewerFailures(settledShards, shardProviders.map((provider) => `${provider} shard`)));
    reviewerErrors.push(...describeReviewerFailures(settledHypotheses, hypothesisProviders.map((provider) => `${provider} hypothesis`)));
    const reviews = settledReviewers.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const lanesSettled = await lanesPromise;
    if (lanesSettled.status === 'rejected') {
      // Whichever wave produced a cleanup classification, it must reach the
      // fail-closed error: the watcher's mandatory pause keys on it.
      const laneCode = processTreeCleanupFailureCode(lanesSettled.reason) || reviewerCleanupFailure(settledReviewers)?.code || null;
      throw await buildFailClosedError({
        paths: context.paths,
        baseReport,
        summary: laneCode
          ? 'A deterministic lane process tree could not be verifiably cleaned up; the gate failed closed.'
          : 'A deterministic lane failed unexpectedly; the gate failed closed.',
        errors: [...reviewerErrors, lanesSettled.reason?.message || String(lanesSettled.reason)],
        code: laneCode,
      });
    }
    const lanes = lanesSettled.value || { lanes: [], findings: [] };
    // A shard is the ONLY reviewer of its hunks: a shard that failed after its
    // retry leaves them unreviewed, and a PASS over unreviewed hunks is the
    // silent gap sharded coverage exists to close. Fail closed — carrying any
    // sibling's process-tree cleanup classification, which the watcher's
    // mandatory pause keys on, whichever wave produced it.
    const failedShards = settledShards
      .map((result, index) => ({ result, shard: shards[index] }))
      .filter(({ result }) => result.status !== 'fulfilled');
    if (failedShards.length) {
      throw await buildFailClosedError({
        paths: context.paths,
        baseReport,
        summary: `${failedShards.length} shard reviewer(s) failed after retry, leaving their hunks unreviewed; the gate failed closed. Rerun the gate.`,
        errors: [
          ...reviewerErrors,
          ...failedShards.map(({ result, shard }) => `shard ${shard.index + 1} (${shard.files.join(', ')}): ${result.reason?.message || String(result.reason)}`),
        ],
        code: reviewerCleanupFailure(settledReviewers)?.code || null,
      });
    }
    if (!reviews.length) {
      const messages = reviewerErrors.length ? reviewerErrors : ['every required reviewer failed'];
      throw await buildFailClosedError({
        paths: context.paths,
        baseReport,
        summary: 'Every required review provider failed; the gate failed closed.',
        errors: messages,
        code: settledReviewers
          .filter((result) => result.status === 'rejected')
          .map((result) => providerTreeCleanupFailureCode(result.reason))
          .find(Boolean) || null,
      });
    }
    // A provider-tree cleanup failure fails the review closed even when
    // sibling reviewers succeeded: attesting or completing normally would
    // leave unverified provider processes running without pausing the
    // watcher (§5 safety fence).
    const partialCleanupFailure = reviewerCleanupFailure(settledReviewers);
    if (partialCleanupFailure) {
      throw await buildFailClosedError({
        paths: context.paths,
        baseReport,
        summary: 'A reviewer provider process tree could not be verifiably cleaned up; the gate failed closed without spending further provider work.',
        errors: [...reviewerErrors, partialCleanupFailure.reason?.message || String(partialCleanupFailure.reason)],
        code: partialCleanupFailure.code,
      });
    }
    // A model-written path is matched to the exact changed-file path when the
    // checkout's directory listings identify it (see canonicalChangedPath),
    // so the identity and increment checks below compare the same string.
    // Known paths: the changed files AND the files of the prior blockers a
    // follow-up re-verifies (a blocker may sit in an unchanged usage-site
    // file), so a re-verification path canonicalizes to the prior key.
    const knownFiles = [...new Set([...files, ...priorBlockingList.map((finding) => finding.file)])];
    const canonicalByModelPath = new Map();
    const canonicalize = async (modelFiles) => {
      for (const file of new Set(modelFiles)) {
        if (canonicalByModelPath.has(file)) continue;
        canonicalByModelPath.set(file, await canonicalChangedPath(file, knownFiles, { checkout: worktree.checkout }));
      }
    };
    const canonicalFile = (file) => canonicalByModelPath.get(file) ?? file;
    await canonicalize(reviews.flatMap((review) => review.candidates.map((candidate) => candidate.file)));
    const canonicalReviews = reviews.map((review) => ({
      ...review,
      candidates: review.candidates.map((candidate) => ({ ...candidate, file: canonicalFile(candidate.file) })),
    }));
    let candidates;
    try {
      candidates = cleanCandidates(canonicalReviews);
    } catch (error) {
      throw await buildFailClosedError({
        paths: context.paths,
        baseReport,
        summary: 'The independent candidate set exceeded its safe bound; the gate failed closed.',
        errors: [error?.message || String(error)],
        extra: {
          reviewerSummaries: reviews.map(({ provider, roleIndex, summary }) => ({
            provider,
            roleIndex,
            summary,
          })),
        },
      });
    }
    let adjudication = { summary: 'Independent reviewers found no candidates at confidence 50 or higher.', findings: [] };
    let usedCoordinator = false;
    if (candidates.length && shouldSkipCoordinator(candidates, { followUp })) {
      adjudication = {
        summary: 'Follow-up round found only P3 candidates; adjudication was skipped.',
        findings: candidates.map((candidate) => advisoryFromCandidate(
          candidate,
          'Follow-up rounds do not adjudicate P3 candidates.',
        )),
      };
    } else if (candidates.length) {
      usedCoordinator = true;
      const batches = adjudicationBatches(candidates);
      progress(`Adjudicating ${candidates.length} candidate finding(s) in ${batches.length} fresh ${plan.coordinator} batch(es).`);
      try {
        const settledBatches = await clock.time('adjudication', () => mapWithConcurrency(
          batches,
          (batch, batchIndex) => runProviderWithOneRetry(() => coordinator({
            provider: plan.coordinator,
            checkout: worktree.checkout,
            bundle,
            candidates: batch,
            batchIndex,
          })),
          LIMITS.providerConcurrency,
          { pool },
        ));
        // Among several failed batches, a process-tree cleanup failure must
        // win: it is the classification the watcher's mandatory pause keys on.
        const failedBatches = settledBatches.filter((result) => result.status !== 'fulfilled');
        const failed = failedBatches.find((result) => providerTreeCleanupFailureCode(result.reason)) || failedBatches[0];
        if (failed) throw failed.reason;
        // Identity across heads comes from the REVIEWER's title (the one a
        // follow-up reviewer is told to reuse verbatim); the adjudicator keeps
        // its recalibrated priority, file and line.
        const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        await canonicalize(settledBatches.flatMap((result) => result.value.findings.map((finding) => finding.file)));
        adjudication = {
          summary: settledBatches.map((result) => result.value.summary).join(' '),
          findings: settledBatches.flatMap((result) => result.value.findings).map((finding) => {
            const candidate = candidateById.get(finding.candidate_id);
            return candidate ? { ...finding, title: candidate.title, file: canonicalFile(finding.file) } : { ...finding, file: canonicalFile(finding.file) };
          }),
        };
        assertAdjudicationCoverage(candidates, adjudication);
      } catch (error) {
        throw await buildFailClosedError({
          paths: context.paths,
          baseReport,
          summary: 'The required candidate adjudication failed; the gate failed closed.',
          errors: [`${plan.coordinator} coordinator: ${error?.message || String(error)}`],
          code: providerTreeCleanupFailureCode(error),
        });
      }
    }

    // A prior blocker keeps its identity through a rename of its file: the
    // key convergence compares against is the one a reviewer produces at the
    // new path with the unchanged title.
    const priorBlockingKeys = new Set(priorBlockingList.map((finding) => findingKey(finding)));
    // A recorded deferral follows its file through a rename, exactly like a
    // prior blocker does — and the decision is RE-RECORDED under the new
    // key, so the pre-push check finds the same record the attestation
    // snapshot points at.
    const deferralsAtHead = new Map(deferrals);
    if (renamedTo.size && (deferrals.size || risk.level !== 'skip')) {
      // The same per-lineage lock every disposition writer takes; the set to
      // propagate is computed from the records re-read UNDER it, so a
      // disposition recorded while the reviewers ran is neither overwritten
      // nor left behind.
      const releaseDispositionLock = await acquireDispositionLock(context.paths, lineage);
      try {
        // The records on disk now are the truth: a key re-recorded while the
        // reviewers ran replaces the pre-review snapshot's copy.
        for (const [key, record] of await readDispositions(context.paths, lineage)) {
          deferralsAtHead.set(key, record);
        }
        for (const record of [...deferralsAtHead.values()]) {
          const currentFileExists = typeof record.file === 'string' && record.file
            ? await access(path.join(worktree.checkout, record.file)).then(() => true, () => false)
            : false;
          const renamedFile = renameTargetFor(record, renamedTo, { currentFileExists });
          if (!renamedFile) continue;
          const renamedKey = findingKey({ file: renamedFile, title: record.title });
          if (deferralsAtHead.has(renamedKey)) {
            // Destination already recorded (an earlier run whose source
            // removal failed): the stale source still goes.
            if (record.key !== renamedKey) {
              await removeDisposition(context.paths, lineage, record.key);
              deferralsAtHead.delete(record.key);
            }
            continue;
          }
          const previousFiles = [...(record.previousFiles || []), record.file];
          const renamedRecord = await recordDisposition(context.paths, lineage, {
            key: renamedKey,
            title: record.title,
            file: renamedFile,
            priority: record.priority,
            reason: record.reason,
            headSha: record.headSha,
            source: record.source || 'author',
            previousFiles,
          });
          deferralsAtHead.set(renamedKey, {
            ...record, key: renamedKey, file: renamedFile, previousFiles, at: renamedRecord.createdAt,
          });
          // The decision now lives under the new key; the old path is gone
          // from the head, so its key must not defer a later finding at a
          // reused path.
          await removeDisposition(context.paths, lineage, record.key);
          deferralsAtHead.delete(record.key);
        }
      } finally {
        await releaseDispositionLock();
      }
    }
    // Blockers no reviewer could re-verify this round stay verified and
    // persisting: silence is never evidence that a known defect is gone.
    // Every one of them is enforced (a recorded deferral makes it an
    // advisory); none is folded into a synthetic entry. Their number is
    // bounded by the lineage's own records, and a lineage that has
    // accumulated more unverified blockers than the adjudication bound is
    // beyond incremental review: it fails closed and names the way out.
    // A carried blocker whose file no longer exists at this head is settled
    // by the deletion itself — deterministic evidence, unlike reviewer
    // silence; the report notes it.
    const carriedGone = [];
    for (const finding of [...carriedForward]) {
      const present = typeof finding.file === 'string' && finding.file
        ? await access(path.join(worktree.checkout, finding.file)).then(() => true, () => false)
        : true;
      if (!present) carriedGone.push(finding);
    }
    if (carriedGone.length) {
      const gone = new Set(carriedGone);
      carriedForward.splice(0, carriedForward.length, ...carriedForward.filter((finding) => !gone.has(finding)));
      reviewerErrors.push(`${carriedGone.length} prior blocker(s) dropped: their file no longer exists at this head (${carriedGone.map((finding) => finding.file).join(', ')}).`);
    }
    if (carriedForward.length > LIMITS.maxCandidates) {
      throw await buildFailClosedError({
        paths: context.paths,
        baseReport,
        summary: `${carriedForward.length} prior blockers could not be re-verified in this follow-up round, more than the ${LIMITS.maxCandidates}-finding bound; fix or defer (npx --no-install rove-sentinel defer, using the earlier report that verified them) enough of them to fit, then rerun.`,
        errors: reviewerErrors,
      });
    }
    const carried = carriedForward.map((finding, index) => carriedFinding(
      finding, index, { deferral: deferralsAtHead.get(findingKey(finding)) ?? null },
    ));
    const enforcedFindings = [
      ...applyConvergencePolicy(
      [...adjudication.findings, ...lanes.findings],
      {
        round,
        incrementFiles: incrementFiles ? new Set(incrementFiles) : null,
        priorBlockingKeys,
        deferrals: deferralsAtHead,
        lateDiscoveriesUsed,
        repairRoundsUsed,
      },
      ),
      ...carried,
    ];
    const verified = blockingFindings(enforcedFindings);
    const advisories = advisoryFindings(enforcedFindings);
    const dismissed = enforcedFindings.filter((finding) => finding.disposition === 'dismissed');
    const native = enforcedFindings.filter(
      (finding) => finding.disposition === 'needs_native_evidence',
    );
    const evidenceAccepted = native.length > 0 && typeof nativeEvidence === 'string' && nativeEvidence.trim().length >= 8;
    const status = verified.length
      ? 'fail'
      : native.length && !evidenceAccepted
        ? 'needs_native_evidence'
        : 'pass';
    const pending = undisposedAdvisories(enforcedFindings, deferralsAtHead);
    const laneNotes = lanes.lanes.filter((lane) => lane.status !== 'skipped')
      .map((lane) => `${lane.lane}: ${lane.note}`);
    const summary = [
      adjudication.summary,
      advisories.length
        ? `${advisories.length} lower-severity finding(s) remain visible as non-blocking advisories under the bounded-convergence policy${pending.length ? `; ${pending.length} of them need a fix or a recorded deferral before this head can be pushed` : ''}.`
        : '',
      laneNotes.length ? `Deterministic lanes — ${laneNotes.join('; ')}.` : '',
      carriedForward.length ? `${carriedForward.length} prior blocker(s) could not be re-verified this round and are carried forward as still present.` : '',
    ].filter(Boolean).join(' ');
    const resultConvergence = {
      ...convergence,
      lateDiscoveriesUsed: lateDiscoveriesUsed + lateDiscoveriesConsumed(enforcedFindings),
      blockingReasons: verified.map((finding) => finding.blockingReason),
      undisposedAdvisories: pending.length,
    };
    const stages = clock.snapshot();
    const report = await writeReport(context.paths, {
      ...baseReport,
      convergence: resultConvergence,
      status,
      summary,
      round,
      followUpBaseSha,
      shards: shards.map(({ index, kind, files: shardFiles, changedLines, reverify }) => ({
        index, kind, files: shardFiles.length, changedLines, provider: shardProviders[index], reverify: Boolean(reverify),
      })),
      deterministicLanes: lanes.lanes,
      stages,
      reviewerSummaries: reviews.map(({ provider, roleIndex, summary: reviewerSummary }) => ({
        provider,
        roleIndex,
        summary: reviewerSummary,
      })),
      errors: reviewerErrors,
      findings: enforcedFindings,
      actionableCount: verified.length + (evidenceAccepted ? 0 : native.length),
      advisoryCount: advisories.length,
      nativeEvidence: evidenceAccepted ? nativeEvidence.trim() : null,
    });

    // Native-evidence findings are unresolved actionable work too: they
    // travel with the lineage so a follow-up round re-verifies their files
    // even when the repair does not touch them — until the evidence settles
    // them, after which they are not blockers for the next head.
    await recordLineageReview(context.paths, lineage, {
      headSha,
      reportId: report.id,
      providerSelection: selectedProviders,
      modelSettings: modelSettings(reviewPolicy.config),
      status,
      blockingFindings: [
        ...[...verified, ...(evidenceAccepted ? [] : native)].map((finding) => ({
          key: finding.findingKey || findingKey(finding),
          title: finding.title,
          file: finding.file,
          priority: finding.priority,
        })),
      ],
      lateDiscoveries: resultConvergence.lateDiscoveriesUsed,
      reviewedHeads: repairRoundsUsed + 1,
    });

    if (status !== 'pass') {
      completedResult = { ...report, reportId: report.id, scoutFailed };
      return completedResult;
    }
    const mode = evidenceAccepted
      ? advisories.length
        ? 'reviewed-with-native-evidence-and-advisories'
        : 'reviewed-with-native-evidence'
      : advisories.length
        ? 'reviewed-with-advisories'
        : 'reviewed';
    completedResult = await writeAttestation(context.paths, identity, {
      risk: risk.level,
      mode,
      round,
      summary,
      providers: [...new Set([...plan.reviewers, ...(usedCoordinator ? [plan.coordinator] : [])])],
      providerExecutions,
      modelDiversity: baseReport.modelDiversity,
      reportId: report.id,
      providerSelection: selectedProviders,
      modelSettings: modelSettings(reviewPolicy.config),
      lineage,
      followUpBaseSha,
      shards: report.shards,
      findings: advisories,
      dismissedFindings: dismissed,
      actionableCount: 0,
      advisoryCount: advisories.length,
      convergence: resultConvergence,
      stages,
      deterministicLanes: lanes.lanes,
      nativeEvidence: evidenceAccepted ? nativeEvidence.trim() : null,
    });
    return completedResult;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [bundle?.cleanup, worktree.cleanup]) {
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    await reconcileCleanupFailure({
      cleanupErrors,
      operationError,
      completedResult,
      revokePass: () => removeAttestation(context.paths, identity),
    });
  }
}

function formatFindingReason(finding) {
  return `${finding.reason}${finding.advisoryReason ? ` (${finding.advisoryReason})` : ''}`;
}

function formatStages(stages) {
  if (!Array.isArray(stages) || !stages.length) return '';
  const label = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`);
  return `Stages: ${stages.map((stage) => `${stage.name} ${label(stage.ms)}`).join(' · ')}`;
}

function formatLocation(finding) {
  return `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
}

export function formatGateResult(result) {
  const head = result.identity?.headSha?.slice(0, 12) || 'unknown';
  if (result.status === 'planned') {
    return `PLAN ${head}: ${result.risk} risk; ${result.round || 'full'} round; ${result.plan.reviewers.join(' + ') || 'no'} reviewers; up to ${result.plan.maxShards ?? 0} shard(s); coordinator ${result.plan.coordinator || 'none'}.`;
  }
  const dismissed = (result.dismissedFindings || (result.findings || []).filter((finding) => finding.disposition === 'dismissed'));
  const dismissedLines = dismissed.map(
    (finding) => `- DISMISSED ${finding.priority} ${formatLocation(finding)} — ${finding.title}: ${finding.reason}`,
  );
  const pending = (result.findings || []).filter((finding) => finding.disposition === 'advisory' && finding.requiresDisposition);
    const deferrableBlockers = (result.findings || []).filter((finding) => finding.disposition === 'verified' && finding.deferrable === true);
  const budgetReached = result.convergence?.repairRoundsUsed >= (result.convergence?.repairRoundBudget ?? Infinity);
  const budgetHint = deferrableBlockers.length
    ? `\n${budgetReached ? `This branch has used ${result.convergence.repairRoundsUsed} reviewed heads on this base (budget ${result.convergence.repairRoundBudget}): the` : 'The'} persisting${budgetReached ? ', late-discovery, repair-introduced and new' : ' and late-discovery'} blocker(s) above may be deferred with a published reason instead of another round —\n  ${deferCommand({ headSha: result.identity?.headSha, reportId: result.reportId, baseSha: result.identity?.baseSha, branch: result.lineage?.branch ?? result.branch, findingIds: deferrableBlockers.map((finding) => finding.candidate_id) })}`
    : '';
  const pendingHint = pending.length
    ? `\n${pending.length} advisor${pending.length === 1 ? 'y' : 'ies'} need a fix or a recorded deferral before this head can be pushed: fix and rerun, or\n  ${deferCommand({ headSha: result.identity?.headSha, reportId: result.reportId, baseSha: result.identity?.baseSha, branch: result.lineage?.branch ?? result.branch, findingIds: pending.map((finding) => finding.candidate_id) })}`
    : '';
  const stages = formatStages(result.stages);
  const selection = result.providerSelection?.length ? `Providers: ${result.providerSelection.join(' + ')}${result.providerSelection.length === 1 ? ' (single-provider review; no cross-model diversity)' : ''}` : '';
  const trailer = [selection, stages, ...dismissedLines].filter(Boolean).join('\n');
  if (result.status === 'pass') {
    const cache = result.cached ? ' (cached exact-SHA attestation)' : '';
    const advisories = (result.findings || []).filter((finding) => finding.disposition === 'advisory');
    const lines = advisories.map(
      (finding) =>
        `- ADVISORY ${finding.priority} ${formatLocation(finding)} — ${finding.title}: ${formatFindingReason(finding)}`,
    );
    return `PASS ${head}: ${result.summary}${cache}${lines.length ? `\n${lines.join('\n')}` : ''}${pendingHint}${trailer ? `\n${trailer}` : ''}`;
  }
  const findings = (result.findings || []).filter((finding) => finding.disposition !== 'dismissed');
  const lines = findings.map(
    (finding) =>
      `- ${finding.disposition === 'advisory' ? 'ADVISORY ' : ''}${finding.priority} ${formatLocation(finding)} — ${finding.title}: ${formatFindingReason(finding)}${finding.blockingReason && finding.blockingReason !== 'first-review' && finding.blockingReason !== 'always' ? ` [${finding.blockingReason}]` : ''}${finding.candidate_id ? ` (${finding.candidate_id})` : ''}`,
  );
  return `${String(result.status).toUpperCase()} ${head}: ${result.summary}${lines.length ? `\n${lines.join('\n')}` : ''}${budgetHint}${pendingHint}${trailer ? `\n${trailer}` : ''}`;
}
