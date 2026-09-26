import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWatcher } from '../daemon.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import {
  adjudicationBatches,
  cleanCandidates,
  createGateContext,
  describeReviewerFailures,
  formatGateResult,
  providerTreeCleanupFailureCode,
  reconcileCleanupFailure,
  runGate,
  shouldSkipCoordinator,
  settleReviewersWithRetry,
} from '../gate.mjs';
import {
  attestationIdentity,
  attestationFileName,
  atomicWriteJson,
  ensureState,
  readAttestation,
  submitRequest,
  waitForResult,
} from '../storage.mjs';

// These integration tests create real repositories and child Git processes.
// Windows process startup and filesystem-handle release can exceed Vitest's
// 5-second default while unrelated test files run concurrently.
if (process.platform === 'win32') {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
}

const REAL_GIT_TEST_TIMEOUT = process.platform === 'win32' ? 30_000 : 10_000;

const temporaryDirectories: string[] = [];

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-test-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'docs', 'bugs'), { recursive: true });
  await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'shared-review-charter.md'), '# Charter\n');
  await writeFile(path.join(root, 'docs', 'bugs', 'lessons.md'), '# Lessons\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/rove.git');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'lib', 'example.ts'), 'export const answer = 42;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'change');
  const head = git(root, 'rev-parse', 'HEAD');
  const policy = reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n' });
  return { root, base, head, policy };
}

async function installTestPolicy(stateRoot, policy) {
  const paths = await ensureState(stateRoot);
  await atomicWriteJson(paths.policy, policy);
  return paths;
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('shared review gate integration', () => {
  it('retries a failed reviewer once and keeps successful siblings', async () => {
    let attempts = 0;
    const settled = await settleReviewersWithRetry([
      async () => 'ok',
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return 'recovered';
      },
    ]);
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(settled[1].value).toBe('recovered');
  });

  it('attempts a permanently failing reviewer exactly twice — one retry, never a third call', async () => {
    let attempts = 0;
    const settled = await settleReviewersWithRetry([
      async () => {
        attempts += 1;
        throw new Error(`attempt ${attempts}`);
      },
    ]);
    expect(settled[0].status).toBe('rejected');
    expect(attempts).toBe(2);
  });

  it('halts new reviewer launches and skips the retry after a provider-tree cleanup failure', async () => {
    const orphan = Object.assign(new Error('tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    let orphanAttempts = 0;
    let laterLaunched = false;
    const settled = await settleReviewersWithRetry([
      async () => {
        orphanAttempts += 1;
        throw orphan;
      },
      async () => {
        laterLaunched = true;
        return 'never';
      },
    ], { concurrency: 1 });
    // Retrying or launching more work after an unverified process tree would
    // accumulate provider processes the operator cannot account for.
    expect(orphanAttempts).toBe(1);
    expect(laterLaunched).toBe(false);
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  });

  it('skips adjudication on a follow-up only when every candidate is P3', () => {
    expect(shouldSkipCoordinator([{ priority: 'P3' }], { followUp: true })).toBe(true);
    // A follow-up P2 IS adjudicated (the two unadjudicated cheap-follow-up P2s
    // of the 2026-09-01 audit both became CodeRabbit actionables).
    expect(shouldSkipCoordinator([{ priority: 'P2' }], { followUp: true })).toBe(false);
    expect(shouldSkipCoordinator([{ priority: 'P1' }], { followUp: true })).toBe(false);
    expect(shouldSkipCoordinator([{ priority: 'P3' }], { followUp: false })).toBe(false);
    expect(shouldSkipCoordinator([], { followUp: false })).toBe(true);
    expect(adjudicationBatches([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('identifies the exact provider role when a reviewer fails', () => {
    const failure = new Error('structured output failed');
    expect(describeReviewerFailures([
      { status: 'fulfilled', value: {} },
      { status: 'rejected', reason: failure },
    ], ['claude', 'codex'])).toEqual([
      'codex reviewer role 1: structured output failed',
    ]);
  });
  it('recognizes provider-tree cleanup failures through their cleanup cause', () => {
    expect(providerTreeCleanupFailureCode({
      terminationError: { code: 'ORPHANED_PROCESS_TREE' },
    })).toBe('ORPHANED_PROCESS_TREE');
    expect(providerTreeCleanupFailureCode({
      terminationError: new Error('taskkill failed'),
    })).toBe('PROCESS_TREE_CLEANUP_FAILED');
  });
  it('preserves a blocking verdict when temporary cleanup also fails', async () => {
    const result = { status: 'fail', reportId: 'report-1', summary: 'Verified defect.' };
    const revokePass = vi.fn(async () => {});

    await reconcileCleanupFailure({
      cleanupErrors: [new Error('worktree busy')],
      operationError: null,
      completedResult: result,
      revokePass,
    });

    expect(result).toMatchObject({
      status: 'fail',
      reportId: 'report-1',
      cleanupErrors: ['worktree busy'],
      summary: expect.stringContaining('Verified defect.'),
    });
    expect(revokePass).not.toHaveBeenCalled();
  });

  it('preserves a process-tree cleanup classification for the watcher pause path', async () => {
    const result = { status: 'fail', reportId: 'report-tree', summary: 'Verified defect.' };
    const cleanupFailure = Object.assign(new Error('git cleanup lost its tree'), {
      terminationError: { code: 'ORPHANED_PROCESS_TREE' },
    });

    await expect(reconcileCleanupFailure({
      cleanupErrors: [cleanupFailure],
      operationError: null,
      completedResult: result,
      revokePass: vi.fn(async () => {}),
    })).rejects.toMatchObject({
      code: 'ORPHANED_PROCESS_TREE',
      reportId: 'report-tree',
      completedResult: result,
    });
  });

  it('adds a cleanup classification to an existing operation failure', async () => {
    const operationError = new Error('review failed first');
    const cleanupFailure = Object.assign(new Error('cleanup tree unknown'), {
      terminationError: new Error('taskkill unavailable'),
    });

    await reconcileCleanupFailure({
      cleanupErrors: [cleanupFailure],
      operationError,
      completedResult: null,
      revokePass: vi.fn(async () => {}),
    });

    expect(operationError).toMatchObject({
      code: 'PROCESS_TREE_CLEANUP_FAILED',
      message: expect.stringContaining('Cleanup also failed'),
    });
  });

  it('revokes a PASS and preserves its report id when cleanup fails', async () => {
    const revokePass = vi.fn(async () => {});
    const completedResult = { status: 'pass', reportId: 'report-2', summary: 'Clean.' };

    let thrown;
    try {
      await reconcileCleanupFailure({
        cleanupErrors: [new Error('context locked')],
        operationError: null,
        completedResult,
        revokePass,
      });
    } catch (error) {
      thrown = error;
    }

    expect(revokePass).toHaveBeenCalledOnce();
    expect(thrown).toMatchObject({ reportId: 'report-2', completedResult });
  });

  it('drains queued lanes as soon as the provider cleanup latch trips, before any rejection unwinds', async () => {
    const { latchProviderCleanupFailure, resetProviderCleanupLatch } = await import('../process.mjs');
    latchProviderCleanupFailure();
    try {
      let launched = 0;
      const settled = await settleReviewersWithRetry([
        async () => {
          launched += 1;
          return 'ran';
        },
      ]);
      expect(launched).toBe(0);
      expect(settled[0].status).toBe('rejected');
    } finally {
      resetProviderCleanupLatch();
    }
  });

  it('drains queued reviewer lanes without spawning while the shutdown launch fence is up', async () => {
    const { blockNewProcessLaunches } = await import('../process.mjs');
    const release = blockNewProcessLaunches();
    try {
      let launched = 0;
      const settled = await settleReviewersWithRetry([
        async () => {
          launched += 1;
          return 'ran';
        },
        async () => {
          launched += 1;
          return 'ran';
        },
      ], { concurrency: 1 });
      expect(launched).toBe(0);
      expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(String(settled[0].reason)).toContain('the watcher is stopping and new process launches are blocked');
    } finally {
      release();
    }
  });

  it('bounds concurrent reviewer launches while preserving result order', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 9 }, (_, index) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return index;
    });
    const { mapWithConcurrency } = await import('../gate.mjs');
    const results = await mapWithConcurrency(tasks, (task) => task(), 3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('merges exact duplicate candidates from independent reviewers before adjudication', () => {
    const candidate = (confidence, extra = {}) => ({
      id: `id-${confidence}-${Math.trunc(Math.random() * 1e6)}`,
      title: 'Stale capture',
      priority: 'P1',
      confidence,
      category: 'lifecycle',
      file: 'src/lib/example.ts',
      line: 10,
      scenario: 'switch during await',
      evidence: 'captured id used live',
      proposed_test: 'switch mid-probe',
      ...extra,
    });
    const merged = cleanCandidates([
      { candidates: [candidate(60)] },
      { candidates: [candidate(90, { scenario: 'better scenario' })] },
      { candidates: [candidate(70, { line: 99 })] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      confidence: 90,
      scenario: 'better scenario',
      corroboratingReviewers: 2,
    });
    // A line-less candidate never merges: without a location the identity of
    // "the same defect" cannot be established deterministically.
    const kept = cleanCandidates([
      { candidates: [candidate(60, { line: null })] },
      { candidates: [candidate(70, { line: null })] },
    ]);
    expect(kept).toHaveLength(2);
  });

  it('selects the closest reviewed ancestor head (pass or fail) whose report still exists', async () => {
    const { selectFollowUpBase } = await import('../gate.mjs');
    const distances = { aaa: 5, bbb: 2, ddd: 1 };
    const reviews = [
      { headSha: 'aaa', status: 'pass', reportId: 'r-a' },
      { headSha: 'bbb', status: 'fail', reportId: 'r-b' },
      { headSha: 'ddd', status: 'pass', reportId: null },
      { headSha: 'head', status: 'pass', reportId: 'r-h' },
    ];
    await expect(selectFollowUpBase('unused', reviews, 'head', {
      ancestorCheck: async (ancestor) => ancestor !== 'ccc',
      countCommits: async (from) => distances[from],
      reviewCheck: async (review) => Boolean(review.reportId),
    })).resolves.toBe('bbb');
    await expect(selectFollowUpBase('unused', ['ccc'], 'head', {
      ancestorCheck: async () => false,
      countCommits: async () => 1,
    })).resolves.toBeNull();
    await expect(selectFollowUpBase('unused', [], 'head', {})).resolves.toBeNull();
  });

  it('keeps the cleanup classification even when the error report cannot be persisted', async () => {
    const { buildFailClosedError } = await import('../gate.mjs');
    const error = await buildFailClosedError({
      // A paths object whose reports directory cannot exist forces the
      // report write to fail; the classification must survive that.
      paths: { reports: path.join('\0invalid', 'reports') },
      baseReport: { identity: {} },
      summary: 'Cleanup failed.',
      errors: ['tree lost'],
      code: 'ORPHANED_PROCESS_TREE',
    });
    expect(error.code).toBe('ORPHANED_PROCESS_TREE');
    expect(error.reportId).toBeNull();
    expect(error.message).toContain('tree lost');
  });

  it('fails closed instead of dropping candidates beyond the global bound', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      id: `candidate-${index}`,
      confidence: 90,
    }));
    expect(() => cleanCandidates([
      { candidates },
      { candidates: candidates.map((candidate) => ({ ...candidate, id: `other-${candidate.id}` })) },
    ])).toThrow('refuses to drop candidates');
  });

  it('refuses a direct review without a trusted installed policy snapshot', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);

    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      dryRun: true,
    })).rejects.toThrow('no installed policy snapshot');
  });

  it('attests an exact clean SHA and reuses only that attestation', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider,
      roleIndex,
      summary: 'No findings.',
      candidates: [],
    }));
    const coordinator = vi.fn();
    const first = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      reviewer,
      coordinator,
    });
    expect(first.status).toBe('pass');
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(coordinator).not.toHaveBeenCalled();

    const second = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      reviewer,
      coordinator,
    });
    expect(second).toMatchObject({ status: 'pass', cached: true });
    expect(reviewer).toHaveBeenCalledTimes(1);
  });

  it('tags an all-reviewers-failed error with a process-tree cleanup code', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const orphan = Object.assign(new Error('provider tree lost'), {
      code: 'ORPHANED_PROCESS_TREE',
    });
    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      reviewer: async () => {
        throw orphan;
      },
    })).rejects.toMatchObject({
      code: 'ORPHANED_PROCESS_TREE',
    });
  });

  it('fails closed when one reviewer leaves an unverified process tree even though a sibling succeeded', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const orphan = Object.assign(new Error('provider tree lost'), {
      code: 'ORPHANED_PROCESS_TREE',
    });
    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => {
        throw new Error('scout unavailable');
      },
      reviewer: async ({ provider, roleIndex }) => {
        if (roleIndex === 0) throw orphan;
        return { provider, roleIndex, summary: 'Clean.', candidates: [] };
      },
      coordinator: vi.fn(),
    })).rejects.toMatchObject({ code: 'ORPHANED_PROCESS_TREE' });
  });

  it('keeps same-location candidates with different titles as distinct defects', () => {
    const base = {
      priority: 'P2',
      confidence: 80,
      category: 'correctness',
      file: 'src/lib/example.ts',
      line: 12,
      scenario: 's',
      evidence: 'e',
      proposed_test: 't',
    };
    const distinct = cleanCandidates([
      { candidates: [{ ...base, id: 'a', title: 'Missing rollback' }] },
      { candidates: [{ ...base, id: 'b', title: 'Wrong workspace id' }] },
    ]);
    expect(distinct).toHaveLength(2);
    const merged = cleanCandidates([
      { candidates: [{ ...base, id: 'a', title: 'Missing  Rollback' }] },
      { candidates: [{ ...base, id: 'b', title: 'missing rollback', confidence: 95, scenario: 'stronger' }] },
    ]);
    expect(merged).toHaveLength(1);
    // The survivor is the highest-confidence candidate kept WHOLE — id and
    // scenario travel together, never a stitched hybrid.
    expect(merged[0]).toMatchObject({
      id: 'b', confidence: 95, scenario: 'stronger', corroboratingReviewers: 2,
    });
  });

  it('fails closed without a lens fallback when the scout leaves an unverified process tree', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const orphan = Object.assign(new Error('scout tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    let scoutAttempts = 0;
    const reviewer = vi.fn();
    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => {
        scoutAttempts += 1;
        throw orphan;
      },
      reviewer,
      coordinator: vi.fn(),
    })).rejects.toMatchObject({ code: 'ORPHANED_PROCESS_TREE' });
    // No retry on a cleanup failure. The shard wave starts beside the scout,
    // so at most the already-launched shard ran; nothing else (hypotheses,
    // lens fallback, adjudication) is launched on top of the unverified tree.
    expect(scoutAttempts).toBe(1);
    expect(reviewer.mock.calls.length).toBeLessThanOrEqual(1);
    expect(reviewer).not.toHaveBeenCalledWith(expect.objectContaining({ hypothesis: expect.anything() }));
  });

  it('does not retry a coordinator whose first attempt left an unverified process tree', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const orphan = Object.assign(new Error('coordinator tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    const coordinator = vi.fn(async () => {
      throw orphan;
    });
    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      reviewer: async ({ provider, roleIndex }) => ({
        provider,
        roleIndex,
        summary: 'candidate',
        candidates: [{
          id: 'candidate', provider, roleIndex, title: 'Race', priority: 'P1', confidence: 95,
          category: 'lifecycle', file: 'src/lib/example.ts', line: 1,
          scenario: 'late completion', evidence: 'write after close', proposed_test: 'close first',
        }],
      }),
      coordinator,
    })).rejects.toMatchObject({ code: 'ORPHANED_PROCESS_TREE' });
    expect(coordinator).toHaveBeenCalledTimes(1);
  });

  it('follows up on a reviewed head even without a live PASS, but escalates when its report is gone', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const branch = 'codex/revoked-pass';
    const cleanReviewer = async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'Clean.', candidates: [],
    });
    const first = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      branch,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => ({ summary: 'nothing', hypotheses: [] }),
      reviewer: cleanReviewer,
    });
    // Revoke the PASS (as cleanup-failure revocation does). The head was still
    // REVIEWED — its report exists — so the next head is a focused follow-up.
    const paths = await ensureState(stateRoot);
    const { removeAttestation } = await import('../storage.mjs');
    await removeAttestation(paths, attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.base,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    }));
    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 45;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'follow-up on a revoked pass');
    const nextHead = git(repository.root, 'rev-parse', 'HEAD');
    const scout = vi.fn(async () => ({ summary: 'nothing', hypotheses: [] }));
    const followUp = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: nextHead,
      branch,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout,
      reviewer: cleanReviewer,
    });
    expect(followUp).toMatchObject({ status: 'pass', round: 'follow-up' });
    expect(scout).not.toHaveBeenCalled();

    // Prune the prior report: the lineage record alone must not grant the
    // reduced plan, so a further head gets a full medium review (which scouts).
    await rm(path.join(paths.reports, `${first.reportId}.json`), { force: true });
    await rm(path.join(paths.reports, `${followUp.reportId}.json`), { force: true });
    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 46;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'after pruned reports');
    const thirdHead = git(repository.root, 'rev-parse', 'HEAD');
    const full = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: thirdHead,
      branch,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout,
      reviewer: cleanReviewer,
    });
    expect(full).toMatchObject({ status: 'pass', round: 'full' });
    expect(scout).toHaveBeenCalledTimes(1);
  }, REAL_GIT_TEST_TIMEOUT);

  it('escalates a rebased lineage to a full review instead of an unfocused cheap follow-up', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const branch = 'codex/rebased-follow-up';
    const cleanReviewer = async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'Clean.', candidates: [],
    });
    await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      branch,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => ({ summary: 'nothing', hypotheses: [] }),
      reviewer: cleanReviewer,
    });
    // Rewrite history: the new head shares the base but is NOT a descendant
    // of the passed head, so there is no incremental focus diff.
    git(repository.root, 'reset', '--hard', repository.base);
    await mkdir(path.join(repository.root, 'src', 'lib'), { recursive: true });
    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 99;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'rewritten change');
    const rebasedHead = git(repository.root, 'rev-parse', 'HEAD');
    const scout = vi.fn(async () => ({ summary: 'nothing', hypotheses: [] }));
    const result = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: rebasedHead,
      branch,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout,
      reviewer: cleanReviewer,
      coordinator: vi.fn(),
    });
    expect(result.status).toBe('pass');
    // A cheap follow-up never scouts; a full medium review does.
    expect(scout).toHaveBeenCalledTimes(1);
  });

  it('continues when the scout is down and a shard reviewer needs its one retry', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    let attempts = 0;
    const reviewer = vi.fn(async ({ provider, roleIndex }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('structured output failed');
      return { provider, roleIndex, summary: 'No findings.', candidates: [] };
    });
    const result = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => {
        throw new Error('scout unavailable');
      },
      reviewer,
      coordinator: vi.fn(),
    });
    expect(result.status).toBe('pass');
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ lane: 'shard', roleIndex: 0 }));
    expect(result.stages.map((stage) => stage.name)).toEqual(expect.arrayContaining(['reference-map', 'shards', 'scout', 'deterministic-lanes']));
  });

  it('reviews a head after a lineage PASS as a focused follow-up that still adjudicates a P2', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const cleanReviewer = async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'Clean.', candidates: [],
    });
    await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      branch: 'codex/cheap-follow-up',
      author: 'codex',
      policy: repository.policy,
      reviewer: cleanReviewer,
    });
    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 43;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'advisory follow-up');
    const secondHead = git(repository.root, 'rev-parse', 'HEAD');
    const candidate = (provider, roleIndex, priority) => ({
      id: `${provider}-${roleIndex}-candidate`,
      provider,
      roleIndex,
      title: `${priority} defect`,
      priority,
      confidence: 95,
      category: 'correctness',
      file: 'src/lib/example.ts',
      line: 1,
      scenario: 'The changed value is rejected.',
      evidence: 'The branch returns the wrong value.',
      proposed_test: 'Exercise the rejected value.',
    });
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'One bounded defect.', candidates: [candidate(provider, roleIndex, 'P2')],
    }));
    const coordinator = vi.fn(async ({ candidates }) => ({
      summary: 'Verified.',
      findings: candidates.map((entry) => ({
        candidate_id: entry.id, title: entry.title, priority: 'P2', file: entry.file, line: entry.line,
        disposition: 'verified', reason: entry.evidence, scenario: entry.scenario, proposed_test: entry.proposed_test,
      })),
    }));
    const result = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: secondHead,
      branch: 'codex/cheap-follow-up',
      author: 'codex',
      policy: repository.policy,
      reviewer,
      coordinator,
    });
    // One cross-model shard over the incremental diff, no scout; the P2 is
    // adjudicated and, being inside the increment, blocks the repaired head.
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ lane: 'shard', provider: 'claude' }));
    expect(coordinator).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'fail',
      round: 'follow-up',
      followUpBaseSha: repository.head,
      findings: [expect.objectContaining({ priority: 'P2', blockingReason: 'introduced-by-repair' })],
    });

    // A P3-only follow-up skips adjudication and passes with an advisory the
    // author must still fix or defer before pushing.
    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 44;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'p3 follow-up');
    const thirdHead = git(repository.root, 'rev-parse', 'HEAD');
    const p3Reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'Polish.', candidates: [candidate(provider, roleIndex, 'P3')],
    }));
    const skipped = vi.fn(async () => { throw new Error('coordinator should not run on a P3-only follow-up'); });
    const third = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: thirdHead,
      branch: 'codex/cheap-follow-up',
      author: 'codex',
      policy: repository.policy,
      reviewer: p3Reviewer,
      coordinator: skipped,
    });
    expect(skipped).not.toHaveBeenCalled();
    expect(third).toMatchObject({
      status: 'pass',
      mode: 'reviewed-with-advisories',
      advisoryCount: 1,
      findings: [expect.objectContaining({ adjudicatedDisposition: 'unadjudicated', requiresDisposition: false })],
    });
  }, REAL_GIT_TEST_TIMEOUT);

  it('dispatches hypothesis reviewers per scout claim alongside the shard wave', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const hypothesisReviewer = vi.fn(async ({ provider, roleIndex, hypothesis }) => ({
      provider,
      roleIndex,
      summary: `Checked ${hypothesis.title}`,
      candidates: [],
    }));
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider,
      roleIndex,
      summary: 'Coverage sweep clean.',
      candidates: [],
    }));
    const result = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => ({
        summary: 'two claims',
        hypotheses: [
          { title: 'A', file: 'src/lib/example.ts', line: 1, lens: 'lifecycle', claim: 'a', why: 'a' },
          { title: 'B', file: 'src/lib/example.ts', line: 2, lens: 'tests', claim: 'b', why: 'b' },
        ],
      }),
      reviewer,
      hypothesisReviewer,
      coordinator: vi.fn(),
    });
    expect(result.status).toBe('pass');
    expect(hypothesisReviewer).toHaveBeenCalledTimes(2);
    // The single-file diff is one shard, reviewed by the cross-model lead;
    // hypothesis role indexes are offset past the shard wave so candidate
    // ids cannot collide.
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({
      lane: 'shard',
      roleIndex: 0,
      provider: 'claude',
      shard: expect.objectContaining({ kind: 'code', files: ['src/lib/example.ts'] }),
    }));
    expect(hypothesisReviewer).toHaveBeenCalledWith(expect.objectContaining({ roleIndex: 1 }));
    expect(hypothesisReviewer).toHaveBeenCalledWith(expect.objectContaining({ roleIndex: 2 }));
    expect(result.shards).toEqual([expect.objectContaining({ kind: 'code', files: 1, provider: 'claude' })]);
  });

  it('fails closed when a shard reviewer dies after its retry, because nothing else covers its hunks', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const reviewer = vi.fn(async () => { throw new Error('structured output failed'); });
    const hypothesisReviewer = vi.fn(async ({ provider, roleIndex }) => ({ provider, roleIndex, summary: 'ok', candidates: [] }));
    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => ({ summary: 'one', hypotheses: [{ title: 'A', file: 'src/lib/example.ts', line: 1, lens: 'l', claim: 'c', why: 'w' }] }),
      reviewer,
      hypothesisReviewer,
      coordinator: vi.fn(),
    })).rejects.toThrow(/shard reviewer\(s\) failed after retry/);
    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it('hands the scout the first pool slot so eight shards cannot serialize it', async () => {
    const order: string[] = [];
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    const { runGate: run } = await import('../gate.mjs');
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    await run({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      risk: 'high',
      policy: repository.policy,
      scout: async () => { order.push('scout'); await settle(); return { summary: 'none', hypotheses: [] }; },
      reviewer: async ({ provider, roleIndex }) => { order.push(`shard-${roleIndex}`); await settle(); return { provider, roleIndex, summary: 'Clean.', candidates: [] }; },
      coordinator: vi.fn(),
    });
    expect(order[0]).toBe('scout');
  });

  it('runs the shard wave even when the scout sees nothing', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const hypothesisReviewer = vi.fn();
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'Coverage sweep clean.', candidates: [],
    }));
    const result = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      risk: 'medium',
      policy: repository.policy,
      scout: async () => ({ summary: 'nothing plausible', hypotheses: [] }),
      reviewer,
      hypothesisReviewer,
      coordinator: vi.fn(),
    });
    expect(result.status).toBe('pass');
    expect(hypothesisReviewer).not.toHaveBeenCalled();
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ lane: 'shard' }));
  });

  it('re-blocks a persisting P2 on the repaired head, then passes once the author records a deferral', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const branch = 'codex/convergence-test';
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider,
      roleIndex,
      summary: 'One bounded defect.',
      candidates: [{
        id: `${provider}-${roleIndex}-candidate`,
        provider,
        roleIndex,
        title: 'Bounded defect',
        priority: 'P2',
        confidence: 95,
        category: 'correctness',
        file: 'src/lib/example.ts',
        line: 1,
        scenario: 'The changed value is rejected.',
        evidence: 'The branch returns the wrong value.',
        proposed_test: 'Exercise the rejected value.',
      }],
    }));
    const coordinator = async ({ candidates }) => ({
      summary: 'Verified bounded defect.',
      findings: candidates.map((candidate) => ({
        candidate_id: candidate.id,
        title: candidate.title,
        priority: 'P2',
        file: candidate.file,
        line: candidate.line,
        disposition: 'verified',
        reason: candidate.evidence,
        scenario: candidate.scenario,
        proposed_test: candidate.proposed_test,
      })),
    });
    const review = (head, force = false) => runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head,
      branch,
      author: 'codex',
      policy: repository.policy,
      force,
      reviewer,
      coordinator,
    });

    const first = await review(repository.head);
    expect(first).toMatchObject({ status: 'fail', round: 'full' });
    expect(first.findings[0]).toMatchObject({ blockingReason: 'first-review' });

    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 43;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'repair one');
    const secondHead = git(repository.root, 'rev-parse', 'HEAD');
    // The adjudicator may paraphrase a title; identity stays the reviewer's.
    const paraphrasing = async ({ candidates }) => {
      const verdict = await coordinator({ candidates });
      return { ...verdict, findings: verdict.findings.map((finding) => ({ ...finding, title: `Paraphrased: ${finding.title}` })) };
    };
    const second = await runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head: secondHead, branch, author: 'codex',
      policy: repository.policy, reviewer, coordinator: paraphrasing,
    });
    expect(second.findings[0].title).toBe('Bounded defect');
    // The repair is reviewed as a repair: the shard reviewer is told which
    // findings to re-verify, and the same finding still present re-blocks.
    expect(reviewer).toHaveBeenLastCalledWith(expect.objectContaining({
      priorBlocking: [expect.objectContaining({ title: 'Bounded defect', file: 'src/lib/example.ts' })],
    }));
    expect(second).toMatchObject({
      status: 'fail', round: 'follow-up', followUpBaseSha: repository.head,
      findings: [expect.objectContaining({ blockingReason: 'persisting' })],
    });
    // A forced rerun of the same head cannot change its verdict.
    await expect(review(secondHead, true)).resolves.toMatchObject({ status: 'fail' });

    // The author's bounded exit: a recorded deferral with a reason, bound to
    // the report that printed the candidate ids. The same head then passes,
    // carrying the deferral as a visible advisory.
    const paths = await ensureState(stateRoot);
    const { readDispositions } = await import('../storage.mjs');
    const { deferFindings } = await import('../dispositions.mjs');
    const lineage = (await import('../convergence.mjs')).convergenceLineage(second.identity, branch);
    await expect(deferFindings({
      repoRoot: repository.root, stateRoot, base: repository.base, head: secondHead, branch,
      findingIds: ['all'], reason: 'Tracked elsewhere.', policy: repository.policy,
    })).rejects.toThrow(/--report <id> is required/);
    await expect(deferFindings({
      repoRoot: repository.root, stateRoot, base: repository.base, head: secondHead, branch,
      reportId: 'not-a-report', findingIds: ['all'], reason: 'Tracked elsewhere.', policy: repository.policy,
    })).rejects.toThrow(/no longer exists/);
    await expect(deferFindings({
      repoRoot: repository.root, stateRoot, base: repository.base, head: secondHead, branch,
      reportId: second.reportId, findingIds: ['nope'], reason: 'Tracked elsewhere.', policy: repository.policy,
    })).rejects.toThrow(/Not deferrable/);
    // A report from another branch cannot write into this branch's lineage.
    await expect(deferFindings({
      repoRoot: repository.root, stateRoot, base: repository.base, head: secondHead, branch: 'codex/other',
      reportId: second.reportId, findingIds: ['all'], reason: 'Tracked elsewhere.', policy: repository.policy,
    })).rejects.toThrow(/produced on branch/);
    const deferralResult = await deferFindings({
      repoRoot: repository.root, stateRoot, base: repository.base, head: secondHead, branch,
      reportId: second.reportId, findingIds: [second.findings[0].candidate_id],
      reason: 'Tracked in docs/bugs/open/bounded-defect.md; out of scope for this branch.', policy: repository.policy,
    });
    expect(deferralResult.deferred).toEqual([expect.objectContaining({ title: 'Bounded defect', priority: 'P2' })]);
    expect(deferralResult.next).toContain('Rerun npx --no-install rove-sentinel gate');
    expect((await readDispositions(paths, lineage)).size).toBe(1);
    const deferred = await review(secondHead, true);
    expect(deferred).toMatchObject({
      status: 'pass',
      mode: 'reviewed-with-advisories',
      actionableCount: 0,
      advisoryCount: 1,
      lineage,
      findings: [expect.objectContaining({
        priority: 'P2', disposition: 'advisory', adjudicatedDisposition: 'verified', requiresDisposition: false,
        deferral: expect.objectContaining({ headSha: secondHead }),
      })],
    });
    expect(formatGateResult(deferred)).toContain('Deferred by the author');
    expect(formatGateResult(deferred)).toContain('Stages:');
  }, REAL_GIT_TEST_TIMEOUT);

  it('keeps a follow-up wave within the shard cap even with re-verification shards', async () => {
    const { followUpShards } = await import('../gate.mjs');
    const section = (file: string, lines: number) => [
      `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,0 +1,${lines} @@`,
      ...Array.from({ length: lines }, (_, index) => `+line ${index}`),
    ].join('\n');
    const incrementFiles = Array.from({ length: 12 }, (_, index) => `src/inc${index}.ts`);
    const blockerFiles = Array.from({ length: 12 }, (_, index) => `src/old${index}.ts`);
    const followUpPatch = incrementFiles.map((file) => section(file, 400)).join('\n');
    const patch = [...incrementFiles, ...blockerFiles].map((file) => section(file, 400)).join('\n');
    const shards = followUpShards({
      followUpPatch, patch, incrementFiles,
      priorBlocking: blockerFiles.map((file) => ({ file, title: 't', priority: 'P2' })),
      maxShards: 4,
    });
    expect(shards.length).toBeLessThanOrEqual(4);
    expect(shards.some((shard) => shard.reverify)).toBe(true);
    expect(new Set(shards.flatMap((shard) => shard.files)).size).toBe(24);
    expect(shards.map((shard) => shard.index)).toEqual(shards.map((_, index) => index));
    // Without uncovered blockers the whole cap goes to the increment.
    expect(followUpShards({ followUpPatch, patch, incrementFiles, priorBlocking: [], maxShards: 4 }).every((shard) => !shard.reverify)).toBe(true);
    // A blocker whose file the repair renamed is re-verified through the new path.
    const renamed = [
      'diff --git a/src/old.ts b/src/new.ts', 'similarity index 90%', 'rename from src/old.ts', 'rename to src/new.ts',
      '--- a/src/old.ts', '+++ b/src/new.ts', '@@ -1,0 +1,1 @@', '+x',
    ].join('\n');
    const followed = followUpShards({
      followUpPatch: renamed, patch: renamed, incrementFiles: ['src/new.ts'],
      priorBlocking: [{ file: 'src/old.ts', title: 't', priority: 'P2' }], maxShards: 4,
    });
    expect(followed.flatMap((shard) => shard.files)).toEqual(['src/new.ts']);
    expect(followed.some((shard) => shard.reverify)).toBe(false);
    const { renamedPaths, renameMapFor } = await import('../shards.mjs');
    expect([...renamedPaths(renamed)]).toEqual([['src/old.ts', 'src/new.ts']]);
    // A full round (no incremental patch) still maps the branch's renames, so
    // a recorded deferral follows its file when retention forced the full review.
    expect([...renameMapFor(renamed, null)]).toEqual([['src/old.ts', 'src/new.ts']]);
    expect([...renameMapFor('', renamed)]).toEqual([['src/old.ts', 'src/new.ts']]);
    expect([...renameMapFor('', null)]).toEqual([]);
  });

  it('keeps a deferred P0/P1 in the prior-blocker set and drops a deferred P2', async () => {
    const { priorBlockingFromReviews } = await import('../gate.mjs');
    const reviews = [{
      blockingFindings: [
        { key: 'k2', title: 'Deferred P2', file: 'a.ts', priority: 'P2' },
        // A P2 deferred earlier, re-adjudicated to P1 under the same key.
        { key: 'k1', title: 'Escalated', file: 'b.ts', priority: 'P1' },
        { key: 'kz', title: 'Deferred P0', file: 'd.ts', priority: 'P0' },
        { key: 'k0', title: 'Kept', file: 'c.ts', priority: 'P2' },
      ],
    }];
    const deferrals = new Map([['k2', { reason: 'r' }], ['k1', { reason: 'r' }], ['kz', { reason: 'r' }]]);
    expect([...priorBlockingFromReviews(reviews, deferrals).keys()]).toEqual(['k1', 'kz', 'k0']);
  });

  it('hands a prior blocker outside the repair increment to a re-verification shard', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const branch = 'codex/reverify';
    // The branch touches two files; the blocker lives in other.ts.
    await writeFile(path.join(repository.root, 'src', 'lib', 'other.ts'), 'export const other = 1;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'add other');
    const firstHead = git(repository.root, 'rev-parse', 'HEAD');
    const reviewer = vi.fn(async ({ provider, roleIndex, shard }) => ({
      provider,
      roleIndex,
      summary: `Shard ${shard.files.join(',')}`,
      candidates: shard.files.includes('src/lib/other.ts') ? [{
        id: `${provider}-${roleIndex}-other`, provider, roleIndex, title: 'Other defect', priority: 'P2', confidence: 95,
        category: 'correctness', file: 'src/lib/other.ts', line: 1, scenario: 's', evidence: 'e', proposed_test: 't',
      }] : [],
    }));
    const coordinator = async ({ candidates }) => ({
      summary: 'Verified.',
      findings: candidates.map((candidate) => ({
        candidate_id: candidate.id, title: candidate.title, priority: 'P2', file: candidate.file, line: candidate.line,
        disposition: 'verified', reason: 'r', scenario: 's', proposed_test: 't',
      })),
    });
    const review = (head) => runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head, branch, author: 'codex',
      policy: repository.policy, reviewer, coordinator,
    });
    await expect(review(firstHead)).resolves.toMatchObject({ status: 'fail' });

    // The repair touches only example.ts: the increment has no other.ts hunk,
    // yet the blocker must still reach a reviewer.
    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 77;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'repair example only');
    const secondHead = git(repository.root, 'rev-parse', 'HEAD');
    reviewer.mockClear();
    const second = await review(secondHead);
    const shardCalls = reviewer.mock.calls.map(([args]) => args.shard);
    expect(shardCalls.some((shard) => shard.files.includes('src/lib/example.ts') && !shard.reverify)).toBe(true);
    expect(shardCalls.some((shard) => shard.files.includes('src/lib/other.ts') && shard.reverify === true)).toBe(true);
    expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ round: 'follow-up' }));
    expect(second).toMatchObject({
      status: 'fail', round: 'follow-up',
      findings: [expect.objectContaining({ title: 'Other defect', blockingReason: 'persisting' })],
      shards: expect.arrayContaining([expect.objectContaining({ reverify: true })]),
    });

    const paths = await ensureState(stateRoot);
    const lineage = (await import('../convergence.mjs')).convergenceLineage(second.identity, branch);
    // Renaming the blocker's file keeps its identity: the reviewer reports
    // the unchanged title at the new path and it is still persisting.
    git(repository.root, 'mv', 'src/lib/other.ts', 'src/lib/renamed.ts');
    git(repository.root, 'commit', '-m', 'rename other');
    const thirdHead = git(repository.root, 'rev-parse', 'HEAD');
    const renamedReviewer = vi.fn(async ({ provider, roleIndex, shard, priorBlocking }) => ({
      provider,
      roleIndex,
      summary: `Shard ${shard.files.join(',')}`,
      candidates: shard.files.includes('src/lib/renamed.ts') ? [{
        id: `${provider}-${roleIndex}-renamed`, provider, roleIndex, title: priorBlocking[0].title, priority: 'P2', confidence: 95,
        category: 'correctness', file: 'src/lib/renamed.ts', line: 1, scenario: 's', evidence: 'e', proposed_test: 't',
      }] : [],
    }));
    const third = await runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head: thirdHead, branch, author: 'codex',
      policy: repository.policy, reviewer: renamedReviewer, coordinator,
    });
    expect(renamedReviewer).toHaveBeenCalledWith(expect.objectContaining({
      priorBlocking: [expect.objectContaining({ file: 'src/lib/renamed.ts', title: 'Other defect' })],
      priorBlockingPath: expect.stringContaining('prior-blocking.md'),
    }));
    expect(third.findings[0]).toMatchObject({ file: 'src/lib/renamed.ts', blockingReason: 'persisting' });
    // Deferring it and renaming again: the deferral follows the file, and the
    // decision is re-recorded under the new key so the attestation's snapshot
    // points at a record the pre-push check will find.
    const { deferFindings: defer } = await import('../dispositions.mjs');
    await defer({
      repoRoot: repository.root, stateRoot, base: repository.base, head: thirdHead, branch,
      reportId: third.reportId, findingIds: ['all'], reason: 'Tracked in docs/bugs/open/other-defect.md for a later PR.', policy: repository.policy,
    });
    git(repository.root, 'mv', 'src/lib/renamed.ts', 'src/lib/final.ts');
    git(repository.root, 'commit', '-m', 'rename again');
    const fourthHead = git(repository.root, 'rev-parse', 'HEAD');
    const finalReviewer = vi.fn(async ({ provider, roleIndex, shard }) => ({
      provider, roleIndex, summary: 'x',
      candidates: shard.files.includes('src/lib/final.ts') ? [{
        id: `${provider}-${roleIndex}-final`, provider, roleIndex, title: 'Other defect', priority: 'P2', confidence: 95,
        category: 'correctness', file: 'src/lib/final.ts', line: 1, scenario: 's', evidence: 'e', proposed_test: 't',
      }] : [],
    }));
    const fourth = await runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head: fourthHead, branch, author: 'codex',
      policy: repository.policy, reviewer: finalReviewer, coordinator,
    });
    expect(fourth).toMatchObject({ status: 'pass', findings: [expect.objectContaining({ file: 'src/lib/final.ts', requiresDisposition: false })] });
    const { readDispositions: readAll } = await import('../storage.mjs');
    const { findingKey: keyOf } = await import('../convergence.mjs');
    expect((await readAll(paths, lineage)).has(keyOf({ file: 'src/lib/final.ts', title: 'Other defect' }))).toBe(true);
    const { undisposedRefusal: refusal } = await import('../dispositions.mjs');
    await expect(refusal(paths, fourth, fourthHead, { branch })).resolves.toBeNull();
  }, REAL_GIT_TEST_TIMEOUT * 2);

  it('spends the late-discovery quota on P2s outside the increment, then leaves them as advisories that need a disposition', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const branch = 'codex/late-discovery';
    let title = 'none';
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider,
      roleIndex,
      summary: title,
      candidates: title === 'none' ? [] : [{
        id: `${provider}-${roleIndex}-${title}`,
        provider,
        roleIndex,
        title,
        priority: 'P2',
        confidence: 95,
        category: 'correctness',
        // A file the repair increment never touches (it exists on the branch).
        file: 'src/lib/other.ts',
        line: 1,
        scenario: 'A stale capture survives.',
        evidence: 'The untouched consumer still reads the old value.',
        proposed_test: 'Exercise the consumer.',
      }],
    }));
    const coordinator = async ({ candidates }) => ({
      summary: 'Verified.',
      findings: candidates.map((candidate) => ({
        candidate_id: candidate.id, title: candidate.title, priority: 'P2', file: candidate.file, line: candidate.line,
        disposition: 'verified', reason: candidate.evidence, scenario: candidate.scenario, proposed_test: candidate.proposed_test,
      })),
    });
    const commit = async (value) => {
      await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), `export const answer = ${value};\n`);
      git(repository.root, 'add', '.');
      git(repository.root, 'commit', '-m', `repair ${value}`);
      return git(repository.root, 'rev-parse', 'HEAD');
    };
    const review = (head) => runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head, branch, author: 'codex',
      policy: repository.policy, reviewer, coordinator,
    });

    await writeFile(path.join(repository.root, 'src', 'lib', 'other.ts'), 'export const other = 1;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'add other');
    await expect(review(git(repository.root, 'rev-parse', 'HEAD'))).resolves.toMatchObject({ status: 'pass', round: 'full' });
    title = 'Late one';
    const late1 = await review(await commit(50));
    expect(late1).toMatchObject({ status: 'fail', convergence: { lateDiscoveriesUsed: 1 } });
    expect(late1.findings[0]).toMatchObject({ blockingReason: 'late-discovery-quota' });
    title = 'Late two';
    const late2 = await review(await commit(51));
    expect(late2).toMatchObject({ status: 'fail', convergence: { lateDiscoveriesUsed: 2 } });
    title = 'Late three';
    const late3 = await review(await commit(52));
    expect(late3).toMatchObject({
      status: 'pass',
      advisoryCount: 1,
      convergence: { lateDiscoveriesUsed: 2, undisposedAdvisories: 1 },
      findings: [expect.objectContaining({
        priority: 'P2', disposition: 'advisory', adjudicatedDisposition: 'verified', requiresDisposition: true,
      })],
    });
    expect(formatGateResult(late3)).toContain('npx --no-install rove-sentinel defer');
  }, REAL_GIT_TEST_TIMEOUT * 2);

  it('refuses to infer a lineage for a head that is not on the checked-out branch', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    // A commit on another branch, while main stays checked out.
    git(repository.root, 'checkout', '-q', '-b', 'codex/elsewhere');
    await writeFile(path.join(repository.root, 'src', 'lib', 'example.ts'), 'export const answer = 7;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'elsewhere');
    const elsewhere = git(repository.root, 'rev-parse', 'HEAD');
    git(repository.root, 'checkout', '-q', 'main');
    await expect(runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head: elsewhere, author: 'codex',
      policy: repository.policy, reviewer: async ({ provider, roleIndex }) => ({ provider, roleIndex, summary: 'x', candidates: [] }),
    })).rejects.toThrow(/not on the checked-out branch main/);
    // An explicit --branch settles the lineage without the inference.
    await expect(runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head: elsewhere, branch: 'codex/elsewhere', author: 'codex',
      policy: repository.policy, reviewer: async ({ provider, roleIndex }) => ({ provider, roleIndex, summary: 'x', candidates: [] }),
    })).resolves.toMatchObject({ status: 'pass' });
  }, REAL_GIT_TEST_TIMEOUT);

  it('keys the attestation to the canonical merge base rather than a moving base tip', async () => {
    const repository = await makeRepository();
    git(repository.root, 'branch', 'feature', repository.head);
    git(repository.root, 'reset', '--hard', repository.base);
    await writeFile(path.join(repository.root, 'docs', 'main-note.md'), '# Main advanced\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'advance main');
    const advancedMain = git(repository.root, 'rev-parse', 'HEAD');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);

    const result = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: advancedMain,
      head: repository.head,
      // The head lives on 'feature' while main is checked out: name it.
      branch: 'feature',
      author: 'codex',
      policy: repository.policy,
      reviewer: async ({ provider, roleIndex }) => ({
        provider, roleIndex, summary: 'Clean.', candidates: [],
      }),
    });

    expect(result.identity.baseSha).toBe(repository.base);
  });

  it('fails closed and removes a forced stale pass attestation', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const cleanReviewer = async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'clean', candidates: [],
    });
    await runGate({
      repoRoot: repository.root, stateRoot, base: repository.base, head: repository.head,
      author: 'codex', policy: repository.policy, reviewer: cleanReviewer,
    });
    const result = await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      force: true,
      reviewer: async ({ provider, roleIndex }) => ({
        provider,
        roleIndex,
        summary: 'candidate',
        candidates: [{
          id: 'candidate', provider, roleIndex, title: 'Race', priority: 'P1', confidence: 95,
          category: 'lifecycle', file: 'src/lib/example.ts', line: 1,
          scenario: 'late completion', evidence: 'write after close', proposed_test: 'close first',
        }],
      }),
      coordinator: async () => ({
        summary: 'Verified race.',
        findings: [{
          candidate_id: 'candidate',
          title: 'Race', priority: 'P1', file: 'src/lib/example.ts', line: 1,
          disposition: 'verified', reason: 'write after close', scenario: 'late completion',
          proposed_test: 'close first',
        }],
      }),
    });
    expect(result.status).toBe('fail');
    const paths = await ensureState(stateRoot);
    const identity = attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.base,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    });
    expect(await readAttestation(paths, identity)).toBeNull();
  });

  it('keeps an existing PASS attestation during a forced dry run', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const reviewer = async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'Clean.', candidates: [],
    });
    await runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      reviewer,
    });

    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      force: true,
      dryRun: true,
    })).resolves.toMatchObject({ status: 'planned' });

    const paths = await ensureState(stateRoot);
    await expect(readAttestation(paths, attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.base,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    }))).resolves.toMatchObject({ status: 'pass' });
  });

  it('discards a corrupt attestation and performs a fresh review', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const paths = await ensureState(stateRoot);
    const identity = attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.base,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    });
    await writeFile(path.join(paths.attestations, attestationFileName(identity)), '{');
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
      provider, roleIndex, summary: 'Clean.', candidates: [],
    }));

    await expect(runGate({
      repoRoot: repository.root,
      stateRoot,
      base: repository.base,
      head: repository.head,
      author: 'codex',
      policy: repository.policy,
      reviewer,
    })).resolves.toMatchObject({ status: 'pass' });
    expect(reviewer).toHaveBeenCalledTimes(1);
  });

  it('processes an automatic queued documentation attestation without a model call', async () => {
    const repository = await makeRepository();
    git(repository.root, 'reset', '--hard', repository.base);
    await writeFile(path.join(repository.root, 'docs', 'note.md'), '# Note\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'docs');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const context = await createGateContext(repository.root, { stateRoot });
    await installTestPolicy(stateRoot, repository.policy);
    const request = await submitRequest(context.paths, {
      type: 'gate',
      options: { base: repository.base, head, author: 'human' },
    });
    await runWatcher({ repoRoot: repository.root, stateRoot, once: true, github: false });
    const response = await waitForResult(context.paths, request.id, { timeoutMs: 2_000, pollMs: 10 });
    expect(response).toMatchObject({ status: 'pass', result: { mode: 'skipped' } });
  });

  it('processes a queued request from a second checkout of the same repository', async () => {
    const owner = await makeRepository();
    const second = await mkdtemp(path.join(os.tmpdir(), 'rove-review-second-checkout-'));
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(second, stateRoot);
    execFileSync('git', ['clone', owner.root, second], { encoding: 'utf8' });
    git(second, 'config', 'user.email', 'test@example.com');
    git(second, 'config', 'user.name', 'Test');
    git(second, 'remote', 'set-url', 'origin', 'https://github.com/example/rove.git');
    await writeFile(path.join(second, 'docs', 'second-checkout.md'), '# Shared checkout\n');
    git(second, 'add', '.');
    git(second, 'commit', '-m', 'docs from second checkout');
    const head = git(second, 'rev-parse', 'HEAD');
    const context = await createGateContext(owner.root, { stateRoot });
    await installTestPolicy(stateRoot, owner.policy);
    const request = await submitRequest(context.paths, {
      type: 'gate',
      options: {
        repoRoot: second,
        base: owner.head,
        head,
        author: 'human',
      },
    });

    await runWatcher({ repoRoot: owner.root, stateRoot, once: true, github: false });
    await expect(waitForResult(context.paths, request.id, {
      timeoutMs: 2_000,
      pollMs: 10,
    })).resolves.toMatchObject({ status: 'pass', result: { mode: 'skipped' } });
  });

  it('quarantines a corrupt interrupted claim and keeps the watcher available', async () => {
    const repository = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-gate-state-'));
    temporaryDirectories.push(stateRoot);
    const context = await createGateContext(repository.root, { stateRoot });
    await installTestPolicy(stateRoot, repository.policy);
    await writeFile(path.join(context.paths.claims, 'truncated.claim'), '{');

    await expect(runWatcher({
      repoRoot: repository.root,
      stateRoot,
      once: true,
      github: false,
    })).resolves.toMatchObject({ alreadyRunning: false });
    await expect(access(context.paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('launch refusals name their cause (PR #519)', () => {
  it('names the process whose cleanup failure latched the fence', async () => {
    const { latchProviderCleanupFailure, resetProviderCleanupLatch } = await import('../process.mjs');
    const { launchFenceReason } = await import('../gate.mjs');
    resetProviderCleanupLatch();
    try {
      latchProviderCleanupFailure({ command: 'git', pid: 346852, reason: 'git exceeded its 4259840-byte output limit' });
      let launched = 0;
      const settled = await settleReviewersWithRetry([
        async () => {
          launched += 1;
          return 'ran';
        },
      ], { concurrency: 1 });
      expect(launched).toBe(0);
      expect(String(settled[0].reason)).toContain('Reviewer launch skipped: a provider cleanup failure is active (git (pid 346852): git exceeded its 4259840-byte output limit).');
      expect(launchFenceReason('Provider')).toContain('Provider launch skipped: a provider cleanup failure is active (git (pid 346852)');
    } finally {
      resetProviderCleanupLatch();
    }
  });

  it('names the latching process to reviewers queued behind a halted lane', async () => {
    const { latchProviderCleanupFailure, resetProviderCleanupLatch } = await import('../process.mjs');
    resetProviderCleanupLatch();
    try {
      let launched = 0;
      const settled = await settleReviewersWithRetry([
        async () => {
          launched += 1;
          latchProviderCleanupFailure({ command: 'codex', pid: 4242, reason: 'taskkill timed out' });
          throw Object.assign(new Error('provider tree left behind'), { code: 'ORPHANED_PROCESS_TREE' });
        },
        async () => {
          launched += 1;
          return 'ran';
        },
      ], { concurrency: 1 });
      expect(launched).toBe(1);
      expect(String(settled[1].reason)).toContain('Reviewer launch skipped: a provider cleanup failure is active (codex (pid 4242): taskkill timed out).');
    } finally {
      resetProviderCleanupLatch();
    }
  });
});
