import { LIMITS } from './constants.mjs';

const ALWAYS_BLOCKING = new Set(['P0', 'P1']);

// Titles fold case and whitespace only: operators and punctuation carry
// meaning ("!= null" vs "== null" are distinct defects), so they stay.
function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Paths are used verbatim: Git prints them with forward slashes on every
// platform, case-distinct files exist on case-sensitive systems, and a
// backslash is a legal POSIX filename character — any folding would let one
// path's deferral suppress another path's finding (gate self-review, 1.8.0).
function normalizeFile(file) {
  return String(file || '');
}

/**
 * Stable identity of a finding across heads: file plus normalized title.
 * Line numbers move with every repair, so they are deliberately excluded.
 */
export function findingKey(finding) {
  return `${normalizeFile(finding?.file)}\0${normalizeTitle(finding?.title)}`;
}

/**
 * Bounded convergence, v1.8.0. The model decides whether a candidate is real;
 * this code decides whether that real finding may block THIS head, and it
 * must satisfy two contradictory histories at once: the gate that never
 * finished (every repair round was a fresh, nondeterministic full review that
 * "discovered" new P2s in code it had already passed) and the gate that let
 * nine verified findings leak to CodeRabbit as silent advisories.
 *
 * - P0/P1 verified: always block.
 * - P2 verified, deferred by the author earlier in the lineage: advisory,
 *   carrying the recorded reason.
 * - P2 verified, previously blocking and still present: blocks again (the
 *   repair was incomplete); the author's exit is an explicit deferral.
 * - P2 verified, new, on a full review: blocks.
 * - P2 verified, new, on a follow-up round: blocks when its file is inside
 *   the incremental diff (the repair introduced it) or while the lineage's
 *   late-discovery quota allows; afterwards it is a late-discovery advisory.
 *   The quota counts blocking ROUNDS, not findings: every late discovery of
 *   one review shares that review's single slot.
 * - P3 verified: advisory from the first review.
 *
 * Every verified advisory that is not deferred is marked
 * `requiresDisposition`: the head cannot be pushed until the author fixes it
 * (a later head no longer reports it) or defers it with a recorded reason.
 * That is what turns "advisory" from a silent drop into a visible decision.
 */
export function applyConvergencePolicy(
  findings,
  {
    round = 'full',
    incrementFiles = null,
    priorBlockingKeys = new Set(),
    deferrals = new Map(),
    lateDiscoveriesUsed = 0,
    lateDiscoveryQuota = LIMITS.lateDiscoveryBlockingQuota,
    // Reviewed ancestor heads of the branch on this base so far; past the
    // budget, repair-introduced blockers — and a full round's new P2, since
    // a policy bump the branch carried restarts the lineage but not the
    // author's repair effort — carry `deferrable: true`.
    repairRoundsUsed = 0,
    repairRoundBudget = LIMITS.lineageRepairRoundBudget,
  } = {},
) {
  const budgetReached = repairRoundsUsed >= repairRoundBudget;
  const lateRoundAvailable = lateDiscoveriesUsed < lateDiscoveryQuota;
  const increment = incrementFiles ? new Set([...incrementFiles].map(normalizeFile)) : null;
  return findings.map((finding) => {
    if (finding.disposition !== 'verified') return finding;
    const key = findingKey(finding);
    const adjudicatedDisposition = finding.adjudicatedDisposition || 'verified';
    const blocking = (blockingReason, { deferrable = false } = {}) => ({
      ...finding, enforcement: 'blocking', adjudicatedDisposition, findingKey: key, blockingReason, deferrable,
    });
    const advisory = (advisoryReason, { requiresDisposition = true, deferral = null } = {}) => ({
      ...finding,
      disposition: 'advisory',
      enforcement: 'advisory',
      adjudicatedDisposition,
      findingKey: key,
      advisoryReason,
      requiresDisposition,
      ...(deferral ? { deferral } : {}),
    });
    if (ALWAYS_BLOCKING.has(finding.priority)) return blocking('always');
    const deferral = deferrals.get(key);
    if (deferral) {
      return advisory(
        `Deferred by the author at ${String(deferral.headSha || '').slice(0, 12)}: ${deferral.reason}`,
        { requiresDisposition: false, deferral: { headSha: deferral.headSha, reason: deferral.reason, at: deferral.at } },
      );
    }
    if (finding.priority === 'P3') {
      return advisory('P3 findings are non-blocking from the first review; fix or defer it with a recorded reason before pushing.');
    }
    // P2 from here on.
    if (priorBlockingKeys.has(key)) return blocking('persisting', { deferrable: true });
    if (round !== 'follow-up') return blocking('first-review', { deferrable: budgetReached });
    // The charter's rule is by FILE: a repaired file's new P2 is the
    // repair's, wherever in the file it manifests (a changed producer breaks
    // an unchanged consumer a hundred lines away). Line ranges were tried
    // and rejected: with 80 lines of unified context they were meaningless,
    // and without context they hid exactly those consumer-side defects.
    if (increment && increment.has(normalizeFile(finding.file))) {
      return blocking('introduced-by-repair', { deferrable: budgetReached });
    }
    if (lateRoundAvailable) return blocking('late-discovery-quota', { deferrable: true });
    return advisory(
      `Late discovery outside the incremental diff after the lineage used its ${lateDiscoveryQuota} late-discovery blocking rounds; fix it or defer it with a recorded reason before pushing.`,
    );
  });
}

/**
 * A prior blocker no reviewer could re-verify this round, carried forward
 * as still present. Deferred by the author → advisory; otherwise it blocks
 * as persisting and, like every persisting finding, may be deferred — except
 * a P0/P1, which no disposition can ever defer.
 */
export function carriedFinding(finding, index, { deferral: recorded = null } = {}) {
  const key = finding.findingKey || findingKey(finding);
  // P0/P1 always block: a recorded deferral cannot soften them (the defer
  // path refuses those priorities, but a record could predate a priority
  // change), so it is ignored here exactly as applyConvergencePolicy does.
  const alwaysBlocking = finding.priority === 'P0' || finding.priority === 'P1';
  const deferral = alwaysBlocking ? null : recorded;
  return {
    candidate_id: `carried-${index}`,
    title: finding.title,
    priority: finding.priority,
    file: finding.file,
    line: null,
    disposition: deferral ? 'advisory' : 'verified',
    enforcement: deferral ? 'advisory' : 'blocking',
    reason: 'Not re-verified this round (no reviewer had capacity to own it); carried forward from the previous reviewed head as still present.',
    scenario: 'See the earlier report that verified it.',
    proposed_test: 'Re-verify in a later round.',
    adjudicatedDisposition: 'carried',
    findingKey: key,
    ...(deferral
      ? { requiresDisposition: false, advisoryReason: `Deferred by the author at ${String(deferral.headSha || '').slice(0, 12)}: ${deferral.reason}`, deferral: { headSha: deferral.headSha, reason: deferral.reason, at: deferral.at } }
      : { blockingReason: alwaysBlocking ? 'always' : 'persisting', deferrable: !alwaysBlocking }),
  };
}

/**
 * The path a recorded disposition follows under the head's renames: its
 * current file, or any earlier path it was recorded under (a chain
 * old → mid → final collapses to old → final in a full round's diff, and a
 * record keyed to mid still carries old in previousFiles). Null when no
 * rename touches it.
 */
export function renameTargetFor(record, renamedTo, { currentFileExists = false } = {}) {
  if (!record || !(renamedTo instanceof Map) || renamedTo.size === 0) return null;
  if (typeof record.file === 'string' && renamedTo.has(record.file)) {
    const target = renamedTo.get(record.file);
    return target === record.file ? null : target;
  }
  // Earlier paths count only when the record's own file is gone from the
  // head: while it still exists, a rename that starts from a reused old
  // name belongs to an unrelated file.
  if (currentFileExists) return null;
  for (const candidate of Array.isArray(record.previousFiles) ? record.previousFiles : []) {
    if (typeof candidate === 'string' && renamedTo.has(candidate)) {
      const target = renamedTo.get(candidate);
      return target === record.file ? null : target;
    }
  }
  return null;
}

export function blockingFindings(findings) {
  return findings.filter((finding) => finding.disposition === 'verified');
}

export function advisoryFindings(findings) {
  return findings.filter((finding) => finding.disposition === 'advisory');
}

/** Advisories the author must still fix or defer before the head can be pushed. */
export function undisposedAdvisories(findings, deferrals = new Map()) {
  return (findings || []).filter((finding) => (
    finding.disposition === 'advisory' &&
    finding.requiresDisposition === true &&
    !deferrals.has(finding.findingKey || findingKey(finding))
  ));
}

/** 1 when this review spent a late-discovery blocking round, else 0. */
export function lateDiscoveriesConsumed(findings) {
  return (findings || []).some((finding) => finding.blockingReason === 'late-discovery-quota') ? 1 : 0;
}

export function convergenceLineage(identity, branch) {
  return {
    repository: identity.repository,
    baseSha: identity.baseSha,
    policyDigest: identity.policyDigest,
    charterVersion: identity.charterVersion,
    gateVersion: identity.gateVersion,
    branch: String(branch || '(detached)'),
  };
}
