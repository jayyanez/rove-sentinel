import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reviewPolicySnapshot } from '../context.mjs';
import { convergenceLineage, findingKey, settledFindings } from '../convergence.mjs';
import { deferFindings, undisposedRefusal } from '../dispositions.mjs';
import {
  deferralsFollowRenames, formatGateResult, runGate, settleAllowed, settleSourceMismatch,
} from '../gate.mjs';
import { ensureState, readAttestation, readLineageReviews, readReport, removeDisposition } from '../storage.mjs';
import { ProviderUsageLimitError } from '../usageLimits.mjs';

// A rerun of an unchanged head after a deferral settles from the round that
// reviewed it (1.21.1). Before, it reviewed the head again from scratch: the
// reviewers drew another sample of identical code, found other blockers, and
// a repair loop that had reached its exit started over. In 100 rounds
// across two consumer projects, 15 of 18 same-head reruns after a FAIL
// blocked again, each time on findings the round before had not named.

if (process.platform === 'win32') {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
}

const temporaryDirectories: string[] = [];
const REASON = 'Tracked as a follow-up issue; out of scope here.';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-settle-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Example\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'lib', 'example.ts'), 'export const answer = 42;\n');
  await writeFile(path.join(root, 'src', 'lib', 'other.ts'), 'export const other = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'change');
  const head = git(root, 'rev-parse', 'HEAD');
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-settle-state-'));
  temporaryDirectories.push(stateRoot);
  const policy = reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n' });
  return { root, base, head, stateRoot, policy };
}

async function commit(root: string, value: number) {
  await writeFile(path.join(root, 'src', 'lib', 'example.ts'), `export const answer = ${value};\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', `repair ${value}`);
  return git(root, 'rev-parse', 'HEAD');
}

type Named = { title: string; priority?: string; file?: string; disposition?: string };

// One reviewer that names whatever the test sets, and a coordinator that
// gives each candidate the disposition the test set (verified by default).
function providers(named: { value: Named[] }) {
  const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
    provider,
    roleIndex,
    summary: 'Reviewed.',
    candidates: named.value.map(({ title, priority = 'P2', file = 'src/lib/example.ts' }, index) => ({
      id: `${provider}-${roleIndex}-${index}`, provider, roleIndex, title, priority, confidence: 95,
      category: 'correctness', file, line: 1,
      scenario: 'The changed value is rejected.', evidence: 'The branch returns the wrong value.', proposed_test: 'Exercise it.',
    })),
  }));
  const coordinator = vi.fn(async ({ candidates }) => ({
    summary: 'Verified.',
    findings: candidates.map((candidate) => ({
      candidate_id: candidate.id, title: candidate.title, priority: candidate.priority, file: candidate.file, line: candidate.line,
      disposition: named.value.find((entry) => entry.title === candidate.title)?.disposition ?? 'verified',
      reason: candidate.evidence, scenario: candidate.scenario, proposed_test: candidate.proposed_test,
    })),
  }));
  return { reviewer, coordinator };
}

function harness(repository: Awaited<ReturnType<typeof makeRepository>>, branch: string, named: { value: Named[] }) {
  const { reviewer, coordinator } = providers(named);
  const lanes = { value: { lanes: [] as object[], findings: [] as object[] } };
  const deterministicLanes = vi.fn(async () => lanes.value);
  const review = (head: string, extra: Record<string, unknown> = {}) => runGate({
    repoRoot: repository.root, stateRoot: repository.stateRoot, base: repository.base, head, branch, author: 'claude',
    policy: repository.policy, availableProviders: ['codex'], reviewer, coordinator, deterministicLanes, ...extra,
  });
  const defer = (head: string, reportId: string) => deferFindings({
    repoRoot: repository.root, stateRoot: repository.stateRoot, base: repository.base, head, branch,
    reportId, findingIds: ['all'], reason: REASON, policy: repository.policy,
  });
  return { reviewer, coordinator, deterministicLanes, lanes, review, defer };
}

describe('a rerun of an unchanged head after a deferral', () => {
  it('settles from the round that reviewed it: no reviewer runs, the deferral applies, and the budgets do not grow', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle';
    const named = { value: [{ title: 'Bounded defect' }] as Named[] };
    const { reviewer, coordinator, deterministicLanes, review, defer } = harness(repository, branch, named);

    await expect(review(repository.head)).resolves.toMatchObject({ status: 'fail', round: 'full' });
    const second = await review(await commit(repository.root, 43));
    expect(second).toMatchObject({
      status: 'fail', round: 'follow-up', followUpBaseSha: repository.head,
      findings: [expect.objectContaining({ title: 'Bounded defect', blockingReason: 'persisting', deferrable: true })],
    });
    const secondHead = second.identity.headSha;
    const paths = await ensureState(repository.stateRoot);
    const lineage = convergenceLineage(second.identity, branch);
    const recordBefore = (await readLineageReviews(paths, lineage)).find((record) => record.headSha === secondHead);

    const deferral = await defer(secondHead, second.reportId);
    expect(deferral.next).toContain('settles from its latest round without another review');

    // A different sample of the same code would name another defect.
    named.value = [{ title: 'A defect nobody named before' }];
    reviewer.mockClear();
    coordinator.mockClear();
    deterministicLanes.mockClear();
    const progress = vi.fn();
    // No provider is available at all: settling needs none, and selects none.
    const settled = await review(secondHead, { progress, availableProviders: [] });
    expect(reviewer).not.toHaveBeenCalled();
    expect(coordinator).not.toHaveBeenCalled();
    // The lanes are deterministic but run again: a tool may have changed.
    expect(deterministicLanes).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining(`from report ${second.reportId}`));
    expect(settled).toMatchObject({
      status: 'pass',
      mode: 'reviewed-with-advisories',
      round: 'follow-up',
      followUpBaseSha: repository.head,
      settledFrom: { reportId: second.reportId },
      actionableCount: 0,
      findings: [expect.objectContaining({
        title: 'Bounded defect', disposition: 'advisory', requiresDisposition: false,
        deferral: expect.objectContaining({ headSha: secondHead }),
      })],
      convergence: expect.objectContaining({
        repairRoundsUsed: second.convergence.repairRoundsUsed,
        lateDiscoveriesUsed: second.convergence.lateDiscoveriesUsed,
      }),
    });
    expect(settled.findings[0]).not.toHaveProperty('blockingReason');
    // Who reviewed is the settled round's record, marked as reused (the
    // injected reviewers record no model passes of their own).
    expect(settled.providerSelection).toEqual(second.providerSelection);
    expect(settled.providerExecutions).toEqual((second.providerExecutions ?? []).map((record: object) => ({ ...record, reused: true })));
    expect(formatGateResult(settled)).toContain(`Settled from report ${second.reportId}`);
    // The attestation passes the pre-push disposition check.
    const attestation = await readAttestation(paths, settled.identity);
    expect(attestation).toMatchObject({ settledFrom: { reportId: second.reportId } });
    await expect(undisposedRefusal(paths, attestation, secondHead, { branch })).resolves.toBeNull();
    // The same head's record is replaced, not added: its count stays.
    const records = (await readLineageReviews(paths, lineage)).filter((record) => record.headSha === secondHead);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'pass', reviewedHeads: recordBefore?.reviewedHeads, blockingFindings: [] });
    const report = await readReport(paths, settled.reportId);
    expect(report).toMatchObject({ settledFrom: { reportId: second.reportId }, shards: [expect.objectContaining({ reused: true })] });

    // The next head counts the settled head once.
    named.value = [];
    reviewer.mockClear();
    const third = await review(await commit(repository.root, 44));
    expect(reviewer).toHaveBeenCalled();
    expect(third).toMatchObject({ status: 'pass', round: 'follow-up', followUpBaseSha: secondHead });
    expect(third.convergence.repairRoundsUsed).toBe(second.convergence.repairRoundsUsed + 1);
  });

  it('gives an unchanged head the same verdict without a review, and reviews it afresh under --force or a new intent', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-force';
    const named = { value: [{ title: 'Bounded defect' }, { title: 'Escalated defect', priority: 'P1' }] as Named[] };
    const { reviewer, review, defer } = harness(repository, branch, named);
    await review(repository.head);
    const second = await review(await commit(repository.root, 43));
    const secondHead = second.identity.headSha;
    expect(second.status).toBe('fail');
    // The P2 is deferred; the P1 cannot be.
    await defer(secondHead, second.reportId);
    const dryRun = await review(secondHead, { dryRun: true });
    expect(dryRun).toMatchObject({ status: 'planned', settlesFrom: second.reportId });
    expect(formatGateResult(dryRun)).toContain(`settles from report ${second.reportId}`);

    reviewer.mockClear();
    const again = await review(secondHead);
    expect(reviewer).not.toHaveBeenCalled();
    expect(again).toMatchObject({ status: 'fail', settledFrom: { reportId: second.reportId } });
    expect(again.findings.filter((finding: { disposition: string }) => finding.disposition === 'verified'))
      .toEqual([expect.objectContaining({ title: 'Escalated defect', priority: 'P1', blockingReason: 'always' })]);
    expect(again.findings).toContainEqual(expect.objectContaining({ title: 'Bounded defect', disposition: 'advisory', requiresDisposition: false }));

    // A settled FAIL settles the next rerun too, and still names the round
    // that reviewed, not the run that settled.
    const twice = await review(secondHead);
    expect(reviewer).not.toHaveBeenCalled();
    expect(twice).toMatchObject({ status: 'fail', settledFrom: { reportId: second.reportId } });
    await expect(review(secondHead, { dryRun: true, prIntent: '' })).resolves.toMatchObject({ settlesFrom: second.reportId });

    // A stated intent the round never read is reviewed.
    const intended = await review(secondHead, { prIntent: 'A pull request body the round never read' });
    expect(reviewer).toHaveBeenCalled();
    expect(intended).not.toHaveProperty('settledFrom');
    expect(intended).toMatchObject({ round: 'follow-up', prIntentDigest: expect.any(String) });

    // --force is a fresh review, as before, with the same classification.
    reviewer.mockClear();
    const forced = await review(secondHead, { force: true });
    expect(reviewer).toHaveBeenCalled();
    expect(forced).not.toHaveProperty('settledFrom');
    expect(forced).toMatchObject({ round: 'follow-up', followUpBaseSha: repository.head });
  });

  it('enforces a lane hit still present, drops one its lane no longer reports, and reviews afresh when a lane with hits cannot finish', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-lanes';
    const named = { value: [{ title: 'Bounded defect' }] as Named[] };
    const { reviewer, deterministicLanes, lanes, review } = harness(repository, branch, named);
    const laneHit = {
      candidate_id: 'deterministic-0', title: 'rule: a lane hit', priority: 'P2', file: 'src/lib/example.ts', line: 1,
      disposition: 'verified', reason: 'r', scenario: 's', proposed_test: 't', source: 'lint', adjudicatedDisposition: 'deterministic',
    };
    lanes.value = { lanes: [{ lane: 'lint', status: 'ok', note: '1 hit' }], findings: [laneHit] };
    const first = await review(repository.head);
    const titles = (result: { findings: Array<{ title: string; disposition: string }> }) => result.findings
      .filter((finding) => finding.disposition === 'verified').map((finding) => finding.title).sort();
    expect(titles(first)).toEqual(['Bounded defect', 'rule: a lane hit']);
    reviewer.mockClear();

    // Still there: enforced again, as a fresh round enforces it.
    const still = await review(repository.head);
    expect(reviewer).not.toHaveBeenCalled();
    expect(still).toMatchObject({ status: 'fail', settledFrom: { reportId: first.reportId } });
    expect(titles(still)).toEqual(['Bounded defect', 'rule: a lane hit']);
    expect(still.findings.find((finding: { title: string }) => finding.title === 'rule: a lane hit')).toMatchObject({ blockingReason: 'first-review' });

    // The lane that had hits stops part-way: it cannot say which remain, so
    // the head is reviewed afresh, which enforces what that run reported
    // without running the lanes again (a second run would report nothing).
    const partialHit = { ...laneHit, title: 'rule: another lane hit' };
    deterministicLanes.mockClear();
    deterministicLanes.mockImplementationOnce(async () => ({
      lanes: [{ lane: 'lint', status: 'timeout', note: 'lint exceeded 60 seconds' }], findings: [partialHit],
    }));
    lanes.value = { lanes: [{ lane: 'lint', status: 'ok', note: '0 hits' }], findings: [] };
    const progress = vi.fn();
    const partial = await review(repository.head, { progress });
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('lint could not recheck'));
    expect(deterministicLanes).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalled();
    expect(partial).not.toHaveProperty('settledFrom');
    expect(titles(partial)).toEqual(['Bounded defect', 'rule: another lane hit']);
    reviewer.mockClear();

    // The lane runs to completion and no longer reports it: the hit is gone,
    // and the fresh hits' ids are the only lane ids.
    const gone = await review(repository.head);
    expect(reviewer).not.toHaveBeenCalled();
    expect(gone).toMatchObject({ settledFrom: { reportId: partial.reportId } });
    expect(titles(gone)).toEqual(['Bounded defect']);
    expect(gone.findings.every((finding: { adjudicatedDisposition?: string }) => finding.adjudicatedDisposition !== 'deterministic')).toBe(true);
  });

  it('keeps the lane result a settlement handed over, and its time, through a provider restart', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-restart';
    const named = { value: [{ title: 'Bounded defect' }] as Named[] };
    const both = { availableProviders: ['claude', 'codex'] };
    const { reviewer, deterministicLanes, lanes, review } = harness(repository, branch, named);
    const laneHit = {
      candidate_id: 'deterministic-0', title: 'rule: a lane hit', priority: 'P2', file: 'src/lib/example.ts', line: 1,
      disposition: 'verified', reason: 'r', scenario: 's', proposed_test: 't', source: 'lint', adjudicatedDisposition: 'deterministic',
    };
    lanes.value = { lanes: [{ lane: 'lint', status: 'ok', note: '1 hit' }], findings: [laneHit] };
    const first = await review(repository.head, both);
    expect(first.status).toBe('fail');

    // The lane stops part-way on the rerun (after 40 ms): the settlement falls
    // through, the fresh review's Codex work reports its usage limit, and the
    // review restarts with Claude. A second lane run would report nothing.
    const partialHit = { ...laneHit, title: 'rule: another lane hit' };
    deterministicLanes.mockClear();
    deterministicLanes.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { lanes: [{ lane: 'lint', status: 'timeout', note: 'lint exceeded 60 seconds' }], findings: [partialHit] };
    });
    lanes.value = { lanes: [{ lane: 'lint', status: 'ok', note: '0 hits' }], findings: [] };
    reviewer.mockImplementation(async ({ provider, roleIndex }) => {
      if (provider === 'codex') throw new ProviderUsageLimitError('codex', { resetAt: Date.now() + 3_600_000, message: "You've hit your usage limit." });
      return { provider, roleIndex, summary: 'Reviewed.', candidates: [] };
    });
    const restarted = await review(repository.head, both);
    expect(restarted).toMatchObject({ providerFallback: { dropped: ['codex'], restarted: true } });
    expect(restarted).not.toHaveProperty('settledFrom');
    expect(deterministicLanes).toHaveBeenCalledTimes(1);
    expect(restarted.findings).toContainEqual(expect.objectContaining({ title: 'rule: another lane hit', disposition: 'verified' }));
    expect(restarted.status).toBe('fail');
    // The report keeps the time the lanes took, not the hand-over's.
    const laneStage = restarted.stages.find((stage: { name: string }) => stage.name === 'deterministic-lanes');
    expect(laneStage.ms).toBeGreaterThanOrEqual(30);
  });

  it('keeps a late-discovery round the head spent when its finding is deferred', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-late';
    const named = { value: [] as Named[] };
    const { review, defer } = harness(repository, branch, named);
    await expect(review(repository.head)).resolves.toMatchObject({ status: 'pass', round: 'full' });
    // A P2 in a file the repair never touched spends a late-discovery round.
    named.value = [{ title: 'Late one', file: 'src/lib/other.ts' }];
    const late = await review(await commit(repository.root, 50));
    expect(late).toMatchObject({ status: 'fail', convergence: { lateDiscoveriesUsed: 1 } });
    expect(late.findings[0]).toMatchObject({ blockingReason: 'late-discovery-quota', deferrable: true });
    await defer(late.identity.headSha, late.reportId);
    const settled = await review(late.identity.headSha);
    expect(settled).toMatchObject({ status: 'pass', settledFrom: { reportId: late.reportId }, convergence: { lateDiscoveriesUsed: 1 } });
    const paths = await ensureState(repository.stateRoot);
    const record = (await readLineageReviews(paths, convergenceLineage(late.identity, branch)))
      .find((entry) => entry.headSha === late.identity.headSha);
    expect(record).toMatchObject({ lateDiscoveries: 1 });
    // A fresh rerun of the same head keeps it as well.
    const forced = await review(late.identity.headSha, { force: true });
    expect(forced).toMatchObject({ convergence: { lateDiscoveriesUsed: 1 } });
    expect(forced).not.toHaveProperty('settledFrom');
  });

  it('reviews the head afresh when a deferral it applies is removed while the lanes run', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-pruned';
    const named = { value: [{ title: 'Bounded defect' }] as Named[] };
    const { reviewer, deterministicLanes, review, defer } = harness(repository, branch, named);
    await review(repository.head);
    const second = await review(await commit(repository.root, 43));
    await defer(second.identity.headSha, second.reportId);
    const paths = await ensureState(repository.stateRoot);
    const lineage = convergenceLineage(second.identity, branch);
    let removed = false;
    deterministicLanes.mockImplementation(async () => {
      if (!removed) {
        removed = true;
        await removeDisposition(paths, lineage, findingKey({ file: 'src/lib/example.ts', title: 'Bounded defect' }));
      }
      return { lanes: [], findings: [] };
    });
    reviewer.mockClear();
    const progress = vi.fn();
    const rerun = await review(second.identity.headSha, { progress });
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('is no longer recorded'));
    expect(reviewer).toHaveBeenCalled();
    expect(rerun).not.toHaveProperty('settledFrom');
    expect(rerun).toMatchObject({ status: 'fail' });
  });

  it('keeps the intent the reviewers read through a settlement that states none', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-intent';
    const named = { value: [{ title: 'Bounded defect' }, { title: 'Escalated defect', priority: 'P1' }] as Named[] };
    const { reviewer, review, defer } = harness(repository, branch, named);
    const intent = { prIntent: 'The pull request body the reviewers read' };
    await review(repository.head, intent);
    const second = await review(await commit(repository.root, 43), intent);
    expect(second).toMatchObject({ status: 'fail', prIntentDigest: expect.any(String) });
    await defer(second.identity.headSha, second.reportId);
    reviewer.mockClear();
    // The printed rerun command states no intent: it settles, and the
    // settlement keeps the digest of the intent that was read.
    const quiet = await review(second.identity.headSha);
    expect(reviewer).not.toHaveBeenCalled();
    expect(quiet).toMatchObject({ status: 'fail', settledFrom: { reportId: second.reportId }, prIntentDigest: second.prIntentDigest });
    // The same intent settles too; another one is reviewed with it.
    await expect(review(second.identity.headSha, intent)).resolves.toMatchObject({ settledFrom: { reportId: second.reportId } });
    expect(reviewer).not.toHaveBeenCalled();
    const other = await review(second.identity.headSha, { prIntent: 'A different pull request body' });
    expect(reviewer).toHaveBeenCalled();
    expect(other).not.toHaveProperty('settledFrom');
  });

  it('reviews again a round with a finding that waits for native evidence, and says so when deferring', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-native';
    const named = { value: [{ title: 'Bounded defect' }, { title: 'Needs a device', disposition: 'needs_native_evidence' }] as Named[] };
    const { reviewer, review, defer } = harness(repository, branch, named);
    await review(repository.head);
    const second = await review(await commit(repository.root, 43));
    expect(second.status).toBe('fail');
    expect(second.findings).toContainEqual(expect.objectContaining({ disposition: 'needs_native_evidence' }));
    const deferral = await defer(second.identity.headSha, second.reportId);
    expect(deferral.next).toContain('waits for native evidence, so the head is reviewed again');
    reviewer.mockClear();
    const rerun = await review(second.identity.headSha);
    expect(reviewer).toHaveBeenCalled();
    expect(rerun).not.toHaveProperty('settledFrom');
  });
});

describe('which report can settle a rerun', () => {
  const identity = { repository: 'r', baseSha: 'b', headSha: 'h', policyDigest: 'p', charterVersion: 'c', gateVersion: 'g' };
  const expected = { identity, branch: 'claude/x', author: 'claude', risk: 'high', round: 'follow-up', followUpBaseSha: 'f' };
  const report = {
    status: 'fail', identity, branch: 'claude/x', author: 'claude', risk: 'high', round: 'follow-up', followUpBaseSha: 'f',
    findings: [{ title: 'T', file: 'a.ts', priority: 'P2', disposition: 'verified' }],
  };

  it('accepts only a FAIL of the exact identity, branch, author, risk, intent and classification', () => {
    expect(settleSourceMismatch(report, expected)).toBeNull();
    expect(settleSourceMismatch({ ...report, status: 'pass' }, expected)).toMatch(/status/);
    expect(settleSourceMismatch({ ...report, status: 'error' }, expected)).toMatch(/status/);
    for (const key of Object.keys(identity)) {
      expect(settleSourceMismatch({ ...report, identity: { ...identity, [key]: 'other' } }, expected)).toBe(`its ${key} differs`);
    }
    expect(settleSourceMismatch({ ...report, branch: 'claude/y' }, expected)).toMatch(/branch/);
    expect(settleSourceMismatch({ ...report, author: 'human' }, expected)).toMatch(/author/);
    expect(settleSourceMismatch({ ...report, risk: 'medium' }, expected)).toMatch(/risk/);
    expect(settleSourceMismatch({ ...report, round: 'full' }, expected)).toMatch(/round/);
    expect(settleSourceMismatch({ ...report, followUpBaseSha: 'g' }, expected)).toMatch(/follow-up base/);
    // A rerun that states no intent settles; one that states another is reviewed.
    expect(settleSourceMismatch({ ...report, prIntentDigest: 'abc' }, expected)).toBeNull();
    expect(settleSourceMismatch({ ...report, prIntentDigest: 'abc' }, { ...expected, prIntentDigest: 'abc' })).toBeNull();
    expect(settleSourceMismatch({ ...report, prIntentDigest: 'abc' }, { ...expected, prIntentDigest: 'xyz' })).toMatch(/another intent/);
    expect(settleSourceMismatch(report, { ...expected, prIntentDigest: 'abc' })).toMatch(/another intent/);
    expect(settleSourceMismatch(report, { ...expected, pendingRenames: true })).toMatch(/renamed/);
    expect(settleSourceMismatch(null, expected)).toBe('no report');
  });

  it('reviews again a round that waits for native evidence, or whose findings are malformed', () => {
    expect(settleSourceMismatch({ ...report, findings: [...report.findings, { title: 'N', file: 'a.ts', priority: 'P2', disposition: 'needs_native_evidence' }] }, expected)).toMatch(/native evidence/);
    expect(settleSourceMismatch({ ...report, findings: [] }, expected)).toMatch(/no findings/);
    expect(settleSourceMismatch({ ...report, findings: [{ title: 'T', file: 'a.ts', priority: 'P9', disposition: 'verified' }] }, expected)).toMatch(/malformed/);
    expect(settleSourceMismatch({ ...report, findings: [{ title: 'T', file: 'a.ts', priority: 'P2', disposition: 'maybe' }] }, expected)).toMatch(/malformed/);
  });

  it('reviews again a round whose applied deferral is no longer recorded', () => {
    const deferred = { title: 'D', file: 'a.ts', priority: 'P2', disposition: 'advisory', requiresDisposition: false, deferral: { headSha: 'h', reason: 'Tracked elsewhere.' } };
    const withDeferral = { ...report, findings: [...report.findings, deferred] };
    expect(settleSourceMismatch(withDeferral, expected)).toMatch(/no longer recorded/);
    expect(settleSourceMismatch(withDeferral, { ...expected, deferrals: new Map([[findingKey(deferred), {}]]) })).toBeNull();
  });

  it('never settles under --force, on a provider or account restart, for a skipped change, or from a head that did not fail', () => {
    const ownRecord = { status: 'fail', reportId: 'r1' };
    expect(settleAllowed({ risk: 'high', ownRecord })).toBe(true);
    expect(settleAllowed({ risk: 'high', ownRecord, force: true })).toBe(false);
    expect(settleAllowed({ risk: 'high', ownRecord, providerFallback: { dropped: ['codex'] } })).toBe(false);
    expect(settleAllowed({ risk: 'high', ownRecord, accountFallback: { excluded: {}, switches: [] } })).toBe(false);
    expect(settleAllowed({ risk: 'skip', ownRecord })).toBe(false);
    expect(settleAllowed({ risk: 'high', ownRecord: { status: 'pass', reportId: 'r1' } })).toBe(false);
    expect(settleAllowed({ risk: 'high', ownRecord: { status: 'fail', reportId: null } })).toBe(false);
    expect(settleAllowed({ risk: 'high', ownRecord: undefined })).toBe(false);
  });

  it('reviews a head whose recorded deferral still has a renamed path to follow', () => {
    const renamedTo = new Map([['src/old.ts', 'src/new.ts']]);
    expect(deferralsFollowRenames(new Map([['k', { file: 'src/old.ts' }]]), renamedTo)).toBe(true);
    // Already moved to the path the head gives it.
    expect(deferralsFollowRenames(new Map([['k', { file: 'src/new.ts', previousFiles: ['src/old.ts'] }]]), renamedTo)).toBe(false);
    // A record keyed to a path between two renames follows through its history.
    expect(deferralsFollowRenames(new Map([['k', { file: 'src/mid.ts', previousFiles: ['src/old.ts'] }]]), renamedTo)).toBe(true);
    expect(deferralsFollowRenames(new Map([['k', { file: 'src/other.ts' }]]), renamedTo)).toBe(false);
    // A record whose own file exists at the head ignores its former paths,
    // as the fresh round does, however often the head is rerun.
    const reused = new Map([['k', { file: 'src/reused.ts', previousFiles: ['src/old.ts'] }]]);
    expect(deferralsFollowRenames(reused, renamedTo, { existingFiles: new Set(['src/reused.ts']) })).toBe(false);
    expect(deferralsFollowRenames(reused, renamedTo)).toBe(true);
    expect(deferralsFollowRenames(new Map([['k', { file: 'src/old.ts' }]]), new Map())).toBe(false);
  });
});

describe('the findings a settled round carries', () => {
  const deferral = { headSha: 'a'.repeat(40), reason: 'Tracked as a follow-up issue.', at: '2026-01-01T00:00:00.000Z' };
  const blocking = (priority: string, title: string, extra: Record<string, unknown> = {}) => ({
    candidate_id: `c-${title}`, title, file: 'src/a.ts', priority, disposition: 'verified', enforcement: 'blocking',
    adjudicatedDisposition: 'verified', blockingReason: 'persisting', deferrable: true, reason: 'r', ...extra,
  });

  it('applies a deferral recorded since the round, never to a P0/P1, and drops the lanes\' hits', () => {
    const findings = [
      blocking('P2', 'Deferred'),
      blocking('P2', 'Kept'),
      blocking('P1', 'Never softened', { blockingReason: 'always', deferrable: false }),
      { ...blocking('P2', 'Lane hit'), adjudicatedDisposition: 'deterministic', source: 'lint' },
      { candidate_id: 'p3', title: 'Advisory', file: 'src/a.ts', priority: 'P3', disposition: 'advisory', requiresDisposition: true, adjudicatedDisposition: 'verified' },
      { candidate_id: 'x', title: 'Dismissed', file: 'src/a.ts', priority: 'P2', disposition: 'dismissed', reason: 'no' },
    ];
    const deferrals = new Map([
      [findingKey({ file: 'src/a.ts', title: 'Deferred' }), deferral],
      [findingKey({ file: 'src/a.ts', title: 'Never softened' }), deferral],
      [findingKey({ file: 'src/a.ts', title: 'Advisory' }), deferral],
      [findingKey({ file: 'src/a.ts', title: 'Dismissed' }), deferral],
    ]);
    const settled = settledFindings(findings, deferrals);
    expect(settled.map((finding) => finding.title)).toEqual(['Deferred', 'Kept', 'Never softened', 'Advisory', 'Dismissed']);
    expect(settled[0]).toMatchObject({
      disposition: 'advisory', enforcement: 'advisory', requiresDisposition: false, adjudicatedDisposition: 'verified',
      findingKey: findingKey({ file: 'src/a.ts', title: 'Deferred' }), deferral: { headSha: deferral.headSha, reason: deferral.reason },
    });
    expect(settled[0]).not.toHaveProperty('blockingReason');
    expect(settled[0]).not.toHaveProperty('deferrable');
    expect(settled[1]).toBe(findings[1]);
    expect(settled[2]).toBe(findings[2]);
    expect(settled[3]).toMatchObject({ disposition: 'advisory', requiresDisposition: false, deferral: expect.any(Object) });
    expect(settled[4]).toBe(findings[5]);
  });
});
