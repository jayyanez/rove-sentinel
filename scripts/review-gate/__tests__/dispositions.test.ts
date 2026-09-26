import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyRecordedDeferrals,
  formatDispositionRefusal,
  selectDeferrableFindings,
  undisposedRefusal,
} from '../dispositions.mjs';
import { ensureState, recordDisposition } from '../storage.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function finding(id: string, priority: string, disposition: string, extra: Record<string, unknown> = {}) {
  return {
    candidate_id: id, title: `Finding ${id}`, file: 'src/a.ts', line: 1, priority, disposition,
    findingKey: `src/a.ts\u0000finding ${id}`, reason: 'r', ...extra,
  };
}

describe('author dispositions', () => {
  it('selects verified advisories needing a disposition and blocking findings below P1, never P0/P1', () => {
    const findings = [
      finding('a', 'P3', 'advisory', { requiresDisposition: true }),
      finding('b', 'P2', 'verified', { blockingReason: 'persisting' }),
      finding('c', 'P1', 'verified', { blockingReason: 'always' }),
      finding('d', 'P2', 'advisory', { requiresDisposition: false, deferral: { reason: 'x' } }),
      finding('e', 'P3', 'dismissed'),
      finding('f', 'P2', 'verified', { blockingReason: 'first-review' }),
      finding('g', 'P2', 'verified', { blockingReason: 'introduced-by-repair' }),
      finding('h', 'P2', 'verified', { blockingReason: 'late-discovery-quota' }),
      finding('i', 'P2', 'verified', { blockingReason: 'introduced-by-repair', deferrable: true }),
    ];
    // Among blockers, the repair-loop exits are deferrable: persisting, late
    // discovery, and a repair-introduced P2 once the lineage's repair-round
    // budget is used; a first-review P2 (or one within budget) is fixed.
    expect(selectDeferrableFindings(findings, ['all']).selected.map((entry) => entry.candidate_id)).toEqual(['a', 'b', 'h', 'i']);
    const partial = selectDeferrableFindings(findings, ['a', 'c', 'f', 'zzz']);
    expect(partial.selected.map((entry) => entry.candidate_id)).toEqual(['a']);
    expect(partial.unknown).toEqual(['c', 'f', 'zzz']);
  });

  it('formats a refusal that names every pending advisory and the exact defer command', () => {
    const text = formatDispositionRefusal([finding('codex-0-1', 'P3', 'advisory', { line: 7 })], 'a'.repeat(40));
    expect(text).toContain('aaaaaaaaaaaa passed with 1 verified advisory that has no recorded disposition');
    expect(text).toContain('P3 src/a.ts:7 — Finding codex-0-1 (codex-0-1)');
    expect(text).toContain('npx --no-install rove-sentinel defer --head aaaaaaaaaaaa --finding codex-0-1 --reason');
    // With the issuing report known, the command binds the ids to it.
    expect(formatDispositionRefusal([finding('codex-0-1', 'P3', 'advisory')], 'a'.repeat(40), '1788-abc'))
      .toContain('--head aaaaaaaaaaaa --report 1788-abc --finding codex-0-1');
    expect(formatDispositionRefusal([finding('codex-0-1', 'P3', 'advisory')], 'a'.repeat(40), '../x'))
      .not.toContain('--report');
    // The printed command reproduces the reviewed base and branch too.
    expect(formatDispositionRefusal([finding('codex-0-1', 'P3', 'advisory')], 'a'.repeat(40), 'r-1', { baseSha: 'b'.repeat(40), branch: 'codex/x' }))
      .toContain(`--head aaaaaaaaaaaa --report r-1 --base ${'b'.repeat(40)} --branch codex/x --finding codex-0-1`);
    // A branch name with shell metacharacters is never interpolated.
    expect(formatDispositionRefusal([finding('codex-0-1', 'P3', 'advisory')], 'a'.repeat(40), 'r-1', { branch: 'x;rm' })).not.toContain('--branch');
    expect(formatDispositionRefusal([finding('codex-0-1', 'P3', 'advisory')], 'a'.repeat(40), 'r-1', { branch: '$(x)' })).not.toContain('--branch');
  });

  it('refuses only while an advisory that requires a disposition has no deferral in its lineage', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-dispositions-'));
    temporaryDirectories.push(stateRoot);
    const paths = await ensureState(stateRoot);
    const lineage = {
      repository: 'repo', baseSha: 'a'.repeat(40), policyDigest: 'c'.repeat(64),
      charterVersion: '1.7.0', gateVersion: '1.8.0', branch: 'codex/x',
    };
    const pending = finding('codex-0-0', 'P3', 'advisory', { requiresDisposition: true });
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [pending] }, 'b'.repeat(40))).resolves.toContain('no recorded disposition');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [pending] }, 'b'.repeat(40))).resolves.toContain('--report r-1 --branch codex/x --finding codex-0-0');
    // A reviewed result without a report id, or with a malformed finding, fails closed.
    await expect(undisposedRefusal(paths, { lineage, findings: [pending] }, 'b'.repeat(40))).resolves.toContain('report id');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, requiresDisposition: 'true' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ title: 'x' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, disposition: 'advisorie' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    // requiresDisposition:false must be justified by a deferral or an
    // unadjudicated follow-up P3; a borrowed findingKey is malformed too.
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, requiresDisposition: false }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', round: 'follow-up', findings: [{ ...pending, requiresDisposition: false, adjudicatedDisposition: 'unadjudicated' }] }, 'b'.repeat(40))).resolves.toBeNull();
    // ...but only on a follow-up round, and a PASS never carries a non-advisory.
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', round: 'full', findings: [{ ...pending, requiresDisposition: false, adjudicatedDisposition: 'unadjudicated' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, disposition: 'verified' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, priority: 'P1' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    // A well-shaped embedded deferral still needs its recorded decision in
    // this lineage; the snapshot alone does not authorize a push.
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, requiresDisposition: false, deferral: { reason: 'Tracked in a brief.', headSha: 'c'.repeat(40) } }] }, 'b'.repeat(40))).resolves.toContain('no recorded disposition');
    // An embedded deferral must have the recorded shape; an unadjudicated
    // advisory is only ever a follow-up P3.
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, requiresDisposition: false, deferral: { reason: 'x', headSha: 'c'.repeat(40) } }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, requiresDisposition: false, deferral: { reason: 'Tracked in a brief.' } }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, priority: 'P2', requiresDisposition: false, adjudicatedDisposition: 'unadjudicated' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    // The same commit on another branch does not inherit this lineage's decisions.
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [] }, 'b'.repeat(40), { branch: 'codex/x' })).resolves.toBeNull();
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [] }, 'b'.repeat(40), { branch: 'codex/y' })).resolves.toContain('reviewed on branch codex/x');
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, findingKey: 'src/other.ts\u0000stale' }] }, 'b'.repeat(40))).resolves.toContain('malformed finding');
    // Findings that do not require a disposition never refuse; a skipped
    // (docs-only) attestation carries no review; but a REVIEWED result that
    // lost its lineage or findings is refused rather than waved through.
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', round: 'follow-up', findings: [finding('x', 'P3', 'advisory', { requiresDisposition: false, adjudicatedDisposition: 'unadjudicated' })] }, 'b'.repeat(40))).resolves.toBeNull();
    await expect(undisposedRefusal(paths, { mode: 'skipped', risk: 'skip' }, 'b'.repeat(40))).resolves.toBeNull();
    await expect(undisposedRefusal(paths, { mode: 'skipped', risk: 'skip', reportId: 'r-0', findings: [] }, 'b'.repeat(40))).resolves.toBeNull();
    // A skip attestation that carries review findings or a lineage is malformed.
    await expect(undisposedRefusal(paths, { mode: 'skipped', risk: 'skip', findings: [pending] }, 'b'.repeat(40))).resolves.toContain('skipped review cannot have');
    await expect(undisposedRefusal(paths, { mode: 'skipped', risk: 'skip', lineage }, 'b'.repeat(40))).resolves.toContain('skipped review cannot have');
    await expect(undisposedRefusal(paths, { mode: 'skipped', risk: 'skip', findings: {} }, 'b'.repeat(40))).resolves.toContain('skipped review cannot have');
    await expect(undisposedRefusal(paths, { mode: 'skipped', risk: 'skip', lineage: '' }, 'b'.repeat(40))).resolves.toContain('skipped review cannot have');
    // Contradictory skip markers are a malformed attestation, never a pass.
    await expect(undisposedRefusal(paths, { mode: 'skipped', risk: 'high' }, 'b'.repeat(40))).resolves.toContain('contradictory skip markers');
    await expect(undisposedRefusal(paths, { mode: 'reviewed', risk: 'skip', lineage, reportId: 'r-1', findings: [] }, 'b'.repeat(40))).resolves.toContain('contradictory skip markers');
    await expect(undisposedRefusal(paths, { findings: [pending], reportId: 'r-1' }, 'b'.repeat(40))).resolves.toContain('carries no lineage, findings, or report id');
    await expect(undisposedRefusal(paths, { lineage, mode: 'reviewed', reportId: 'r-1' }, 'b'.repeat(40))).resolves.toContain('carries no lineage, findings, or report id');
    await recordDisposition(paths, lineage, {
      key: pending.findingKey, title: pending.title, file: pending.file, priority: 'P3',
      reason: 'Deferred deliberately for the follow-up PR.', headSha: 'b'.repeat(40),
    });
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [pending] }, 'b'.repeat(40))).resolves.toBeNull();
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, requiresDisposition: false, deferral: { reason: 'Deferred deliberately for the follow-up PR.', headSha: 'b'.repeat(40) } }] }, 'b'.repeat(40))).resolves.toBeNull();
    // The record is authoritative: an older snapshot still passes (and is
    // refreshed at publish time), a snapshot without a record does not.
    await expect(undisposedRefusal(paths, { lineage, reportId: 'r-1', findings: [{ ...pending, requiresDisposition: false, deferral: { reason: 'Some other older reason.', headSha: 'b'.repeat(40) } }] }, 'b'.repeat(40))).resolves.toBeNull();
    const refreshed = await applyRecordedDeferrals(paths, { lineage, findings: [{ ...pending, requiresDisposition: false, deferral: { reason: 'Some other older reason.', headSha: 'b'.repeat(40) } }] });
    expect(refreshed.findings[0].deferral.reason).toBe('Deferred deliberately for the follow-up PR.');
    // A lineage that does not match the attestation's own identity is refused.
    const identity = { repository: 'repo', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64), charterVersion: '1.7.0', gateVersion: '1.8.0' };
    await expect(undisposedRefusal(paths, { lineage, identity, reportId: 'r-1', findings: [] }, 'b'.repeat(40))).resolves.toBeNull();
    await expect(undisposedRefusal(paths, { lineage, identity: { ...identity, baseSha: 'd'.repeat(40) }, reportId: 'r-1', findings: [] }, 'b'.repeat(40))).resolves.toContain('does not match its identity (baseSha)');

    // A stored result that predates the deferral is annotated at publish time.
    const applied = await applyRecordedDeferrals(paths, { lineage, findings: [pending, finding('other', 'P3', 'advisory', { requiresDisposition: true })] });
    expect(applied.findings[0]).toMatchObject({ requiresDisposition: false, deferral: { headSha: 'b'.repeat(40) } });
    expect(applied.findings[0].advisoryReason).toContain('Deferred by the author');
    expect(applied.findings[1]).toMatchObject({ requiresDisposition: true });
    expect(applied.findings[1].deferral).toBeUndefined();
    expect(applied.deferredCount).toBe(1);
    const withConvergence = await applyRecordedDeferrals(paths, { lineage, convergence: { deferrals: 0 }, findings: [pending] });
    expect(withConvergence.convergence.deferrals).toBe(1);
    await expect(applyRecordedDeferrals(paths, { findings: [pending] })).resolves.toEqual({ findings: [pending] });
  });
});
