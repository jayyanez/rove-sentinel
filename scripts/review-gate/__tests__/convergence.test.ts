import { describe, expect, it } from 'vitest';

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
} from '../convergence.mjs';

function finding(priority: string, disposition = 'verified', extra: Record<string, unknown> = {}) {
  return {
    candidate_id: `${priority}-${disposition}-${extra.title ?? ''}`,
    priority,
    disposition,
    title: 'Finding',
    file: 'src/example.ts',
    line: 1,
    reason: 'Concrete failure.',
    ...extra,
  };
}

describe('the repair-round budget on a full round', () => {
  it('makes a new P2 deferrable only once the branch has spent its budget', () => {
    const finding = { candidate_id: 'c', title: 'T', file: 'src/a.ts', priority: 'P2', disposition: 'verified' };
    expect(applyConvergencePolicy([finding], { round: 'full', repairRoundsUsed: 5, repairRoundBudget: 6 })[0]).toMatchObject({ blockingReason: 'first-review', deferrable: false });
    expect(applyConvergencePolicy([finding], { round: 'full', repairRoundsUsed: 6, repairRoundBudget: 6 })[0]).toMatchObject({ blockingReason: 'first-review', deferrable: true });
    expect(applyConvergencePolicy([{ ...finding, priority: 'P1' }], { round: 'full', repairRoundsUsed: 6, repairRoundBudget: 6 })[0]).toMatchObject({ blockingReason: 'always', deferrable: false });
  });
});

describe('rename targets for recorded deferrals', () => {
  it('follows the current file or any earlier path of the record, chains included', () => {
    const full = new Map([['src/old.ts', 'src/final.ts']]);
    expect(renameTargetFor({ file: 'src/old.ts' }, full)).toBe('src/final.ts');
    // Recorded at the intermediate path; the full round's diff only shows old → final.
    expect(renameTargetFor({ file: 'src/mid.ts', previousFiles: ['src/old.ts'] }, full)).toBe('src/final.ts');
    // The record's own file still exists: a rename from a reused old name is another file's.
    expect(renameTargetFor({ file: 'src/mid.ts', previousFiles: ['src/old.ts'] }, full, { currentFileExists: true })).toBeNull();
    expect(renameTargetFor({ file: 'src/old.ts' }, full, { currentFileExists: true })).toBe('src/final.ts');
    expect(renameTargetFor({ file: 'src/final.ts', previousFiles: ['src/old.ts'] }, full)).toBeNull();
    expect(renameTargetFor({ file: 'src/other.ts' }, full)).toBeNull();
    expect(renameTargetFor({ file: 'src/old.ts' }, new Map())).toBeNull();
    expect(renameTargetFor(null, full)).toBeNull();
  });
});

describe('carried blockers', () => {
  it('carries a prior blocker as persisting, deferrable unless it is P0/P1, advisory once deferred', () => {
    const p2 = carriedFinding({ title: 'T', file: 'src/a.ts', priority: 'P2' }, 0);
    expect(p2).toMatchObject({ candidate_id: 'carried-0', enforcement: 'blocking', blockingReason: 'persisting', deferrable: true, line: null });
    for (const priority of ['P0', 'P1']) {
      expect(carriedFinding({ title: 'T', file: 'src/a.ts', priority }, 1)).toMatchObject({ enforcement: 'blocking', blockingReason: 'always', deferrable: false });
      // A recorded deferral never softens a P0/P1.
      expect(carriedFinding({ title: 'T', file: 'src/a.ts', priority }, 1, { deferral: { headSha: 'a'.repeat(40), reason: 'why', at: 't' } }))
        .toMatchObject({ enforcement: 'blocking', deferrable: false });
    }
    const deferred = carriedFinding({ title: 'T', file: 'src/a.ts', priority: 'P2' }, 2, { deferral: { headSha: 'a'.repeat(40), reason: 'why', at: 't' } });
    expect(deferred).toMatchObject({ enforcement: 'advisory', requiresDisposition: false });
    expect(deferred.advisoryReason).toContain('why');
    expect(deferred).not.toHaveProperty('deferrable');
  });
});

describe('bounded review convergence (1.8.0)', () => {
  it('keys a finding by verbatim file and case/space-folded title, never by line', () => {
    const key = findingKey({ file: 'src/a.ts', title: 'Stale  Tab: handler!' });
    expect(key).toBe(findingKey({ file: 'src/a.ts', title: 'stale tab: handler!', line: 99 }));
    expect(key).not.toBe(findingKey({ file: 'src/b.ts', title: 'stale tab: handler!' }));
    // Git tracks case-distinct paths on case-sensitive systems and a
    // backslash is a legal POSIX filename character; folding either would let
    // one file's deferral suppress another file's finding.
    expect(key).not.toBe(findingKey({ file: 'src/A.ts', title: 'stale tab: handler!' }));
    expect(key).not.toBe(findingKey({ file: 'src\\a.ts', title: 'stale tab: handler!' }));
    // Operators carry meaning: "!= null" and "== null" are distinct defects.
    expect(findingKey({ file: 'src/a.ts', title: 'Reject when value != null' }))
      .not.toBe(findingKey({ file: 'src/a.ts', title: 'Reject when value == null' }));
  });

  it('keeps P0 and P1 blocking under every round and quota state', () => {
    const result = applyConvergencePolicy(
      [finding('P0'), finding('P1')],
      { round: 'follow-up', incrementFiles: new Set(), lateDiscoveriesUsed: 99, priorBlockingKeys: new Set() },
    );
    expect(blockingFindings(result).map(({ priority }) => priority)).toEqual(['P0', 'P1']);
    expect(result.every(({ blockingReason }) => blockingReason === 'always')).toBe(true);
  });

  it('blocks every new verified P2 on a full review', () => {
    const result = applyConvergencePolicy([finding('P2'), finding('P2', 'verified', { title: 'Other' })]);
    expect(blockingFindings(result)).toHaveLength(2);
    expect(result[0].blockingReason).toBe('first-review');
  });

  it('on a follow-up, blocks a P2 inside the increment, spends the late-discovery quota outside it, then goes advisory', () => {
    const inside = finding('P2', 'verified', { file: 'src/fixed.ts', title: 'Introduced by repair' });
    const late1 = finding('P2', 'verified', { file: 'src/other.ts', title: 'Late one' });
    const late2 = finding('P2', 'verified', { file: 'src/other.ts', title: 'Late two' });
    const late3 = finding('P2', 'verified', { file: 'src/other.ts', title: 'Late three' });
    const result = applyConvergencePolicy([inside, late1, late2, late3], {
      round: 'follow-up',
      incrementFiles: new Set(['src/fixed.ts']),
      lateDiscoveriesUsed: 0,
      lateDiscoveryQuota: 2,
    });
    // The quota counts blocking ROUNDS: every late discovery of this review
    // shares the review's single slot, so all three block and one round is
    // consumed.
    expect(result.map((entry) => entry.blockingReason ?? entry.disposition)).toEqual([
      'introduced-by-repair', 'late-discovery-quota', 'late-discovery-quota', 'late-discovery-quota',
    ]);
    expect(lateDiscoveriesConsumed(result)).toBe(1);
    expect(lateDiscoveriesConsumed(applyConvergencePolicy([inside], { round: 'follow-up', incrementFiles: new Set(['src/fixed.ts']) }))).toBe(0);

    // A lineage that already spent its quota gets no more late blocks; the
    // findings become advisories that still need a disposition.
    const spent = applyConvergencePolicy([late1, late2], {
      round: 'follow-up', incrementFiles: new Set(), lateDiscoveriesUsed: 2, lateDiscoveryQuota: 2,
    });
    expect(blockingFindings(spent)).toEqual([]);
    const advisory = advisoryFindings(spent)[0];
    expect(advisory).toMatchObject({
      priority: 'P2', adjudicatedDisposition: 'verified', requiresDisposition: true,
    });
    expect(advisory.advisoryReason).toContain('Late discovery');
  });

  it('treats every new P2 in a repaired file as repair-introduced, wherever it manifests', () => {
    const inHunk = finding('P2', 'verified', { file: 'src/fixed.ts', title: 'In hunk', line: 12 });
    const farAway = finding('P2', 'verified', { file: 'src/fixed.ts', title: 'Far away', line: 400 });
    const unlocated = finding('P2', 'verified', { file: 'src/fixed.ts', title: 'No line', line: null });
    const elsewhere = finding('P2', 'verified', { file: 'src/other.ts', title: 'Elsewhere', line: 3 });
    const result = applyConvergencePolicy([inHunk, farAway, unlocated, elsewhere], {
      round: 'follow-up',
      incrementFiles: new Set(['src/fixed.ts']),
      lateDiscoveriesUsed: 2,
      lateDiscoveryQuota: 2,
    });
    expect(result.map((entry) => entry.blockingReason ?? entry.disposition)).toEqual([
      'introduced-by-repair', 'introduced-by-repair', 'introduced-by-repair', 'advisory',
    ]);
  });

  it('marks repair-introduced blockers deferrable once the lineage spent its repair-round budget', () => {
    const inHunk = finding('P2', 'verified', { file: 'src/fixed.ts', title: 'In hunk', line: 12 });
    const options = { round: 'follow-up', incrementFiles: new Set(['src/fixed.ts']) };
    const early = applyConvergencePolicy([inHunk], { ...options, repairRoundsUsed: 2, repairRoundBudget: 6 });
    expect(early[0]).toMatchObject({ blockingReason: 'introduced-by-repair', deferrable: false });
    const late = applyConvergencePolicy([inHunk], { ...options, repairRoundsUsed: 6, repairRoundBudget: 6 });
    expect(late[0]).toMatchObject({ blockingReason: 'introduced-by-repair', deferrable: true, disposition: 'verified' });
    // Persisting and late-discovery blockers are deferrable from the start.
    const persisting = applyConvergencePolicy([inHunk], { ...options, priorBlockingKeys: new Set([findingKey(inHunk)]) });
    expect(persisting[0]).toMatchObject({ blockingReason: 'persisting', deferrable: true });
  });

  it('re-blocks a previously blocking P2 that is still present, regardless of quota', () => {
    const persisting = finding('P2', 'verified', { file: 'src/other.ts', title: 'Still here' });
    const result = applyConvergencePolicy([persisting], {
      round: 'follow-up',
      incrementFiles: new Set(),
      priorBlockingKeys: new Set([findingKey(persisting)]),
      lateDiscoveriesUsed: 5,
    });
    expect(result[0]).toMatchObject({ enforcement: 'blocking', blockingReason: 'persisting' });
  });

  it('turns a deferred finding into a non-blocking advisory that carries the recorded reason', () => {
    const deferred = finding('P2', 'verified', { title: 'Deferred one' });
    const deferrals = new Map([[findingKey(deferred), {
      reason: 'Tracked in docs/bugs/open/deferred-one.md', headSha: 'c'.repeat(40), at: '2026-09-01T00:00:00Z',
    }]]);
    const result = applyConvergencePolicy([deferred], { deferrals });
    expect(result[0]).toMatchObject({
      disposition: 'advisory', requiresDisposition: false, adjudicatedDisposition: 'verified',
      deferral: { headSha: 'c'.repeat(40) },
    });
    expect(result[0].advisoryReason).toContain('Deferred by the author at cccccccccccc');
    expect(undisposedAdvisories(result, deferrals)).toEqual([]);
  });

  it('makes P3 advisory immediately but still requires a disposition; dismissed and native findings are untouched', () => {
    const dismissed = finding('P2', 'dismissed');
    const native = finding('P1', 'needs_native_evidence');
    const deterministic = finding('P3', 'verified', { title: 'MD028', adjudicatedDisposition: 'deterministic' });
    const result = applyConvergencePolicy([finding('P3'), dismissed, native, deterministic]);
    expect(result[0]).toMatchObject({ disposition: 'advisory', enforcement: 'advisory', requiresDisposition: true });
    expect(result[1]).toBe(dismissed);
    expect(result[2]).toBe(native);
    expect(result[3]).toMatchObject({ disposition: 'advisory', adjudicatedDisposition: 'deterministic', requiresDisposition: true });
    expect(undisposedAdvisories(result)).toHaveLength(2);
  });

  it('resets the lineage when branch, base, or installed policy changes', () => {
    const identity = {
      repository: 'https://github.com/example/rove',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      policyDigest: 'c'.repeat(64),
      charterVersion: '1.1.0',
      gateVersion: '1.1.0',
    };
    const baseline = convergenceLineage(identity, 'codex/feature');

    expect(convergenceLineage({ ...identity, headSha: 'd'.repeat(40) }, 'codex/feature')).toEqual(baseline);
    expect(convergenceLineage({ ...identity, baseSha: 'd'.repeat(40) }, 'codex/feature')).not.toEqual(baseline);
    expect(convergenceLineage({ ...identity, policyDigest: 'e'.repeat(64) }, 'codex/feature')).not.toEqual(baseline);
    expect(convergenceLineage(identity, 'codex/other')).not.toEqual(baseline);
  });
});
