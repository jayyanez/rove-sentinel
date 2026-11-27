import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reviewPolicySnapshot } from '../context.mjs';
import { convergenceLineage, findingKey, settledFindings } from '../convergence.mjs';
import { deferFindings, undisposedRefusal } from '../dispositions.mjs';
import { formatGateResult, runGate, settleSourceMismatch } from '../gate.mjs';
import { ensureState, readAttestation, readLineageReviews, readReport } from '../storage.mjs';

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

// One reviewer that names whatever titles the test sets, and a coordinator
// that verifies every candidate at the priority the reviewer gave.
function providers(titles: { value: Array<{ title: string; priority?: string }> }) {
  const reviewer = vi.fn(async ({ provider, roleIndex }) => ({
    provider,
    roleIndex,
    summary: 'Reviewed.',
    candidates: titles.value.map(({ title, priority = 'P2' }, index) => ({
      id: `${provider}-${roleIndex}-${index}`, provider, roleIndex, title, priority, confidence: 95,
      category: 'correctness', file: 'src/lib/example.ts', line: 1,
      scenario: 'The changed value is rejected.', evidence: 'The branch returns the wrong value.', proposed_test: 'Exercise it.',
    })),
  }));
  const coordinator = vi.fn(async ({ candidates }) => ({
    summary: 'Verified.',
    findings: candidates.map((candidate) => ({
      candidate_id: candidate.id, title: candidate.title, priority: candidate.priority, file: candidate.file, line: candidate.line,
      disposition: 'verified', reason: candidate.evidence, scenario: candidate.scenario, proposed_test: candidate.proposed_test,
    })),
  }));
  return { reviewer, coordinator };
}

describe('a rerun of an unchanged head after a deferral', () => {
  it('settles from the round that reviewed it: no reviewer runs, the deferral applies, and the budgets do not grow', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle';
    const titles = { value: [{ title: 'Bounded defect' }] };
    const { reviewer, coordinator } = providers(titles);
    const deterministicLanes = vi.fn(async () => ({ lanes: [], findings: [] }));
    const review = (head: string, extra: Record<string, unknown> = {}) => runGate({
      repoRoot: repository.root, stateRoot: repository.stateRoot, base: repository.base, head, branch, author: 'claude',
      policy: repository.policy, availableProviders: ['codex'], reviewer, coordinator, deterministicLanes, ...extra,
    });

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

    const deferral = await deferFindings({
      repoRoot: repository.root, stateRoot: repository.stateRoot, base: repository.base, head: secondHead, branch,
      reportId: second.reportId, findingIds: ['all'], reason: 'Tracked as a follow-up issue; out of scope here.', policy: repository.policy,
    });
    expect(deferral.next).toContain(`settles from report ${second.reportId}`);

    // A different sample of the same code would name another defect.
    titles.value = [{ title: 'A defect nobody named before' }];
    reviewer.mockClear();
    coordinator.mockClear();
    deterministicLanes.mockClear();
    const progress = vi.fn();
    const settled = await review(secondHead, { progress });
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
    titles.value = [];
    reviewer.mockClear();
    const third = await review(await commit(repository.root, 44));
    expect(reviewer).toHaveBeenCalled();
    expect(third).toMatchObject({ status: 'pass', round: 'follow-up', followUpBaseSha: secondHead });
    expect(third.convergence.repairRoundsUsed).toBe(second.convergence.repairRoundsUsed + 1);
  });

  it('gives an unchanged head the same verdict without a review, and reviews it afresh only under --force', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-force';
    const titles = { value: [{ title: 'Bounded defect' }, { title: 'Escalated defect', priority: 'P1' }] };
    const { reviewer, coordinator } = providers(titles);
    const deterministicLanes = vi.fn(async () => ({ lanes: [], findings: [] }));
    const review = (head: string, extra: Record<string, unknown> = {}) => runGate({
      repoRoot: repository.root, stateRoot: repository.stateRoot, base: repository.base, head, branch, author: 'claude',
      policy: repository.policy, availableProviders: ['codex'], reviewer, coordinator, deterministicLanes, ...extra,
    });
    await review(repository.head);
    const second = await review(await commit(repository.root, 43));
    const secondHead = second.identity.headSha;
    expect(second.status).toBe('fail');
    // The P2 is deferred; the P1 cannot be.
    await deferFindings({
      repoRoot: repository.root, stateRoot: repository.stateRoot, base: repository.base, head: secondHead, branch,
      reportId: second.reportId, findingIds: ['all'], reason: 'Tracked as a follow-up issue; out of scope here.', policy: repository.policy,
    });
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

    // A settled FAIL settles the next rerun too: still no reviewer.
    const twice = await review(secondHead);
    expect(reviewer).not.toHaveBeenCalled();
    expect(twice).toMatchObject({ status: 'fail', settledFrom: { reportId: again.reportId } });

    // --force is a fresh review, as before.
    const forced = await review(secondHead, { force: true });
    expect(reviewer).toHaveBeenCalled();
    expect(forced).not.toHaveProperty('settledFrom');
    expect(forced).toMatchObject({ round: 'follow-up', followUpBaseSha: repository.head });
  });

  it('runs the deterministic lanes again and enforces their hits as the settled round did', async () => {
    const repository = await makeRepository();
    const branch = 'claude/settle-lanes';
    const titles = { value: [{ title: 'Bounded defect' }] };
    const { reviewer, coordinator } = providers(titles);
    const laneHit = {
      candidate_id: 'deterministic-0', title: 'rule: a lane hit', priority: 'P2', file: 'src/lib/example.ts', line: 1,
      disposition: 'verified', reason: 'r', scenario: 's', proposed_test: 't', source: 'lint', adjudicatedDisposition: 'deterministic',
    };
    let hits = [laneHit];
    const deterministicLanes = vi.fn(async () => ({ lanes: [{ lane: 'lint', status: 'ran', note: 'ok' }], findings: hits }));
    const review = (head: string) => runGate({
      repoRoot: repository.root, stateRoot: repository.stateRoot, base: repository.base, head, branch, author: 'claude',
      policy: repository.policy, availableProviders: ['codex'], reviewer, coordinator, deterministicLanes,
    });
    const first = await review(repository.head);
    expect(first.findings.map((finding: { title: string }) => finding.title).sort()).toEqual(['Bounded defect', 'rule: a lane hit']);
    // Only the model finding is deferred; the lane's hit is gone at the rerun
    // (its tool changed), so nothing of the earlier hit is taken over.
    const modelFinding = first.findings.find((finding: { title: string }) => finding.title === 'Bounded defect');
    expect(modelFinding.deferrable).toBe(false);
    hits = [];
    reviewer.mockClear();
    const rerun = await review(repository.head);
    expect(reviewer).not.toHaveBeenCalled();
    expect(rerun).toMatchObject({ status: 'fail', settledFrom: { reportId: first.reportId } });
    expect(rerun.findings.map((finding: { title: string }) => finding.title)).toEqual(['Bounded defect']);
    expect(rerun.findings[0]).toMatchObject({ blockingReason: 'first-review' });
  });
});

describe('which report can settle a rerun', () => {
  const identity = { repository: 'r', baseSha: 'b', headSha: 'h', policyDigest: 'p', charterVersion: 'c', gateVersion: 'g' };
  const expected = { identity, branch: 'claude/x', author: 'claude', risk: 'high', round: 'follow-up', followUpBaseSha: 'f' };
  const report = {
    status: 'fail', identity, branch: 'claude/x', author: 'claude', risk: 'high', round: 'follow-up', followUpBaseSha: 'f',
    findings: [{ title: 'T', file: 'a.ts', priority: 'P2', disposition: 'verified' }],
  };

  it('accepts only a FAIL of the exact identity, branch, author, risk and classification', () => {
    expect(settleSourceMismatch(report, expected)).toBeNull();
    expect(settleSourceMismatch({ ...report, status: 'pass' }, expected)).toMatch(/status/);
    expect(settleSourceMismatch({ ...report, status: 'error' }, expected)).toMatch(/status/);
    expect(settleSourceMismatch({ ...report, identity: { ...identity, policyDigest: 'q' } }, expected)).toMatch(/policyDigest/);
    expect(settleSourceMismatch({ ...report, identity: { ...identity, gateVersion: 'older' } }, expected)).toMatch(/gateVersion/);
    expect(settleSourceMismatch({ ...report, branch: 'claude/y' }, expected)).toMatch(/branch/);
    expect(settleSourceMismatch({ ...report, author: 'human' }, expected)).toMatch(/author/);
    expect(settleSourceMismatch({ ...report, risk: 'medium' }, expected)).toMatch(/risk/);
    expect(settleSourceMismatch({ ...report, round: 'full' }, expected)).toMatch(/round/);
    expect(settleSourceMismatch({ ...report, followUpBaseSha: 'g' }, expected)).toMatch(/follow-up base/);
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
      { ...blocking('P2', 'Lane hit'), adjudicatedDisposition: 'deterministic' },
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
