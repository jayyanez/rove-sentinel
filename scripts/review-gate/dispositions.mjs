import { loadInstalledReviewPolicy, reviewPolicySnapshot } from './context.mjs';
import { convergenceLineage, findingKey, undisposedAdvisories } from './convergence.mjs';
import { createGateContext } from './gate.mjs';
import { currentBranch, mergeBase, resolveCommit } from './git.mjs';
import {
  acquireDispositionLock,
  attestationIdentity,
  pruneDispositions,
  readDispositions,
  readReport,
  recordDisposition,
  removeDisposition,
} from './storage.mjs';

// Author dispositions (v1.8.0). The 2026-09-01 audit found nine verified
// findings that the gate had downgraded to advisories and the authoring
// agent then silently skipped — CodeRabbit raised every one of them as
// actionable after the push. An advisory is now a decision the author must
// make visibly: fix it, or defer it here with a reason that the gate records
// per finding identity and publishes in the PR comment.

const NEVER_DEFERRABLE = new Set(['P0', 'P1']);
// The only dispositions the policy writes; anything else in a stored result
// is a malformed payload, never a silently ignored one.
const KNOWN_DISPOSITIONS = new Set(['verified', 'dismissed', 'needs_native_evidence', 'advisory']);
const DEFERRABLE_BLOCKING_REASONS = new Set(['persisting', 'late-discovery-quota']);

/**
 * Findings on a report that an author may defer: verified advisories that
 * still need a disposition, and verified blocking findings below P1 (the
 * bounded exit from a repair loop). Pure.
 */
export function selectDeferrableFindings(findings, ids) {
  // Deferrable: an advisory awaiting its disposition, or a blocking P2 that
  // is the bounded exit from a repair loop (persisting or late-discovery).
  // A first-review or introduced-by-repair P2 is fixed, never deferred —
  // until the branch has spent its repair-round budget, when the policy
  // marks them `deferrable` too.
  const eligible = (findings || []).filter((finding) => (
    !NEVER_DEFERRABLE.has(finding.priority) && (
      (finding.disposition === 'advisory' && finding.requiresDisposition === true) ||
      (finding.disposition === 'verified' && (finding.deferrable === true || DEFERRABLE_BLOCKING_REASONS.has(finding.blockingReason)))
    )
  ));
  const wanted = new Set(ids || []);
  if (wanted.has('all')) return { selected: eligible, unknown: [] };
  const selected = eligible.filter((finding) => wanted.has(finding.candidate_id));
  const known = new Set(selected.map((finding) => finding.candidate_id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  return { selected, unknown };
}

export function deferCommand({ headSha, reportId, baseSha, branch, findingIds }) {
  const head = String(headSha || '').slice(0, 12);
  // Candidate ids are report-local: the printed command names the report
  // that issued them, so a later rerun cannot make it defer something else;
  // the reviewed base and branch travel too, so the command reproduces the
  // exact identity and lineage from any checkout state.
  const report = typeof reportId === 'string' && /^[A-Za-z0-9-]+$/.test(reportId) ? ` --report ${reportId}` : '';
  const base = typeof baseSha === 'string' && /^[a-f0-9]{40}$/.test(baseSha) ? ` --base ${baseSha}` : '';
  // A branch name is copied into a shell: only the plain ref alphabet is
  // interpolated; anything else (Git allows shell metacharacters) is left
  // for the user to pass quoted by hand.
  const ref = typeof branch === 'string' && /^[A-Za-z0-9._\/-]+$/.test(branch) && !branch.startsWith('-') ? ` --branch ${branch}` : '';
  return `npx --no-install rove-sentinel defer --head ${head}${report}${base}${ref} --finding ${(findingIds || []).join(',')} --reason "<why this stays open>"`;
}

export function formatDispositionRefusal(pending, headSha, reportId = null, { baseSha, branch } = {}) {
  const head = String(headSha || '').slice(0, 12);
  const lines = pending.map((finding) => (
    `  - ${finding.priority} ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.title} (${finding.candidate_id})`
  ));
  return [
    `Shared review gate: ${head} passed with ${pending.length} verified advisor${pending.length === 1 ? 'y' : 'ies'} that ${pending.length === 1 ? 'has' : 'have'} no recorded disposition:`,
    ...lines,
    'Fix them and rerun the gate, or defer each one deliberately with a reason:',
    `  ${deferCommand({ headSha, reportId, baseSha, branch, findingIds: pending.map((finding) => finding.candidate_id) })}`,
    'Deferrals are published in the PR comment; a silent advisory is how verified bugs reached CodeRabbit.',
  ].join('\n');
}

/**
 * The pre-push check: an attested PASS whose verified advisories are neither
 * fixed nor deferred does not push. Returns the refusal text or null.
 */
export async function undisposedRefusal(paths, result, headSha, { branch } = {}) {
  if (!result) return null;
  // Attestation identity excludes the branch, but lineages and deferrals are
  // branch-scoped: the same commit pushed on another branch must not reuse
  // the first branch's decisions.
  if (branch !== undefined && result.lineage && result.lineage.branch !== String(branch || '(detached)')) {
    return `Shared review gate: the attestation for ${String(headSha || '').slice(0, 12)} was reviewed on branch ${result.lineage.branch}, not ${branch}; a different branch starts a new lineage, so rerun npx --no-install rove-sentinel gate on this branch.`;
  }
  // The lineage the dispositions are read from must be THIS attestation's:
  // every lineage field other than the branch is an identity field.
  if (result.lineage && result.identity) {
    for (const key of ['repository', 'baseSha', 'policyDigest', 'charterVersion', 'gateVersion']) {
      if (result.lineage[key] !== result.identity[key]) {
        return `Shared review gate: the attestation for ${String(headSha || '').slice(0, 12)} carries a lineage that does not match its identity (${key}); rerun npx --no-install rove-sentinel gate on this head.`;
      }
    }
  }
  // A skipped (documentation-only) attestation carries no review and no
  // findings. Every REVIEWED result must carry its lineage and findings
  // array, or the disposition check would be fail-open on a malformed or
  // pre-1.8.0 payload (gate self-review).
  const skipped = result.mode === 'skipped' && result.risk === 'skip';
  if (skipped) {
    // A skip attestation carries no review: any lineage field, or any
    // findings value other than an empty array, is a malformed payload,
    // never a way past the advisory check.
    const findingsShape = result.findings === undefined || (Array.isArray(result.findings) && result.findings.length === 0);
    if (result.lineage !== undefined || !findingsShape) {
      return `Shared review gate: the skip attestation for ${String(headSha || '').slice(0, 12)} carries review findings or a lineage, which a skipped review cannot have; rerun npx --no-install rove-sentinel gate on this head.`;
    }
    return null;
  }
  if (result.mode === 'skipped' || result.risk === 'skip') {
    return `Shared review gate: the attestation for ${String(headSha || '').slice(0, 12)} carries contradictory skip markers (mode ${JSON.stringify(result.mode)}, risk ${JSON.stringify(result.risk)}); rerun npx --no-install rove-sentinel gate on this head.`;
  }
  const head = String(headSha || '').slice(0, 12);
  if (!result.lineage || !Array.isArray(result.findings) || typeof result.reportId !== 'string' || !/^[A-Za-z0-9-]+$/.test(result.reportId)) {
    return `Shared review gate: the reviewed result for ${head} carries no lineage, findings, or report id, so its advisory dispositions cannot be checked. Rerun npx --no-install rove-sentinel gate on this head.`;
  }
  // Every finding must have the shape the policy wrote; a malformed entry
  // (a string "true", a missing disposition) fails closed instead of being
  // skipped by the strict comparisons below.
  const malformed = result.findings.find((finding) => {
    if (!finding || typeof finding !== 'object') return true;
    // A PASS carries ONLY advisories: any other disposition in its findings
    // (a verified blocker, a dismissal, an unresolved native claim) is a
    // contradictory payload.
    if (!KNOWN_DISPOSITIONS.has(finding.disposition) || finding.disposition !== 'advisory') return true;
    // The policy never downgrades P0/P1 to advisory.
    if (NEVER_DEFERRABLE.has(finding.priority)) return true;
    // A stored key must be the key the policy computes for that finding;
    // a reused key would borrow another finding's deferral.
    if (finding.findingKey !== undefined && finding.findingKey !== findingKey(finding)) return true;
    if (finding.disposition !== 'advisory') return false;
    if (typeof finding.requiresDisposition !== 'boolean') return true;
    // An advisory that claims to need no disposition must say why: a recorded
    // deferral with the same shape recordDisposition enforces (a reason of at
    // least 12 characters and a head), or an unadjudicated follow-up P3 —
    // the only priority the policy ever leaves unadjudicated.
    if (finding.requiresDisposition === false) {
      const deferral = finding.deferral;
      const deferred = Boolean(deferral) && typeof deferral === 'object' &&
        typeof deferral.reason === 'string' && deferral.reason.trim().length >= 12 &&
        typeof deferral.headSha === 'string' && /^[a-f0-9]{40}$/.test(deferral.headSha);
      // ...and the policy leaves a P3 unadjudicated only on a follow-up round.
      const unadjudicatedP3 = finding.adjudicatedDisposition === 'unadjudicated' && finding.priority === 'P3' && result.round === 'follow-up';
      return !(deferred || unadjudicatedP3);
    }
    return false;
  });
  if (malformed) {
    return `Shared review gate: the reviewed result for ${head} carries a malformed finding entry, so its advisory dispositions cannot be checked. Rerun npx --no-install rove-sentinel gate on this head.`;
  }
  if (!result.findings.length) return null;
  const deferrals = await readDispositions(paths, result.lineage);
  // An embedded deferral is a snapshot of a recorded decision, never a
  // substitute for it: the record must exist in this lineage.
  // The recorded decision is authoritative; the embedded snapshot is only
  // what the comment displays and is refreshed from the record at publish
  // time. A snapshot without a record authorizes nothing.
  const unrecorded = result.findings.filter((finding) => (
    finding.disposition === 'advisory' && finding.requiresDisposition === false && finding.deferral &&
    !deferrals.has(finding.findingKey || findingKey(finding))
  ));
  const pending = [
    ...undisposedAdvisories(result.findings, deferrals),
    ...unrecorded,
  ];
  return pending.length
    ? formatDispositionRefusal(pending, headSha, result.reportId, { baseSha: result.identity?.baseSha, branch: result.lineage.branch })
    : null;
}

/**
 * Attach recorded deferrals to a stored result's findings so a comment
 * published after the deferral shows the author's decision. Pure apart from
 * the read; a result without a lineage is returned unchanged.
 */
export async function applyRecordedDeferrals(paths, result) {
  if (!result?.lineage || !Array.isArray(result.findings) || !result.findings.length) return result;
  const deferrals = await readDispositions(paths, result.lineage);
  if (!deferrals.size) return result;
  const findings = result.findings.map((finding) => {
      if (finding.disposition !== 'advisory') return finding;
      const deferral = deferrals.get(finding.findingKey || findingKey(finding));
      // A finding that already carries a snapshot is refreshed from the record
      // (a decision re-recorded later replaces the earlier text).
      if (!deferral) return finding;
      return {
        ...finding,
        requiresDisposition: false,
        advisoryReason: `Deferred by the author at ${String(deferral.headSha || '').slice(0, 12)}: ${deferral.reason}`,
        deferral: { headSha: deferral.headSha, reason: deferral.reason, at: deferral.at },
      };
    });
  // The published convergence count follows the findings it is printed with.
  const deferredNow = findings.filter((finding) => finding.deferral).length;
  return {
    ...result,
    findings,
    deferredCount: Math.max(Number(result.deferredCount) || 0, deferredNow),
    convergence: result.convergence
      ? { ...result.convergence, deferrals: Math.max(Number(result.convergence.deferrals) || 0, deferredNow) }
      : result.convergence,
  };
}

export async function deferFindings({
  repoRoot = process.cwd(),
  stateRoot,
  base = 'origin/main',
  head = 'HEAD',
  branch: branchOverride,
  reportId,
  findingIds,
  reason,
  policy,
} = {}) {
  if (!Array.isArray(findingIds) || !findingIds.length) {
    throw new Error('--finding needs one or more candidate ids from the gate output (comma-separated), or "all".');
  }
  // Candidate ids are positional within ONE report, so the report that
  // printed them is mandatory: without it a forced rerun could make the same
  // id denote a different finding.
  if (typeof reportId !== 'string' || !/^[A-Za-z0-9-]+$/.test(reportId)) {
    throw new Error('--report <id> is required: copy the full command the gate printed, which names the report that issued these candidate ids.');
  }
  const context = await createGateContext(repoRoot, { stateRoot });
  const reviewPolicy = policy
    ? reviewPolicySnapshot(policy)
    : await loadInstalledReviewPolicy(context.paths);
  const [requestedBaseSha, headSha, branch] = await Promise.all([
    resolveCommit(context.repoRoot, base),
    resolveCommit(context.repoRoot, head),
    branchOverride === undefined ? currentBranch(context.repoRoot) : Promise.resolve(branchOverride),
  ]);
  const baseSha = await mergeBase(context.repoRoot, requestedBaseSha, headSha);
  const identity = attestationIdentity({
    repository: context.repository,
    baseSha,
    headSha,
    policyDigest: reviewPolicy.policyDigest,
  });
  const lineage = convergenceLineage(identity, branch);
  // Candidate ids are positional per report, so a deferral binds to the
  // report that printed them when the caller names it (the gate output
  // does); otherwise the newest report for this exact identity is used.
  const report = await readReport(context.paths, reportId);
  if (!report) throw new Error(`Report ${reportId} no longer exists locally; rerun npx --no-install rove-sentinel gate and use the command it prints.`);
  for (const [key, expected] of Object.entries(identity)) {
    if (report.identity?.[key] !== expected) {
      throw new Error(`Report ${reportId} was produced for a different head, base, or policy than ${headSha.slice(0, 12)}; use the command from this head's own gate output.`);
    }
  }
  // Deferrals are lineage-scoped by branch: a report produced on another
  // branch must not write into this branch's lineage after a checkout
  // switch.
  if (typeof report.branch === 'string' && report.branch !== String(branch || '(detached)')) {
    throw new Error(`Report ${reportId} was produced on branch ${report.branch}, not ${branch}; switch back or pass --branch ${report.branch}.`);
  }
  const { selected, unknown } = selectDeferrableFindings(report.findings, findingIds);
  if (unknown.length) {
    throw new Error(`Not deferrable on ${headSha.slice(0, 12)}: ${unknown.join(', ')}. P0/P1 findings are never deferrable; other ids must match the latest gate output for this head.`);
  }
  if (!selected.length) {
    throw new Error(`Nothing to defer on ${headSha.slice(0, 12)}: the latest report has no verified advisory or blocking finding below P1.`);
  }
  // One writer per lineage at a time: a lock file (exclusive create, owner
  // token, pid liveness) guards the checkout check, the snapshot, the
  // writes and the rollback. Everything after acquisition runs under the
  // try/finally that releases it.
  const releaseLock = await acquireDispositionLock(context.paths, lineage);
  const keys = selected.map((finding) => finding.findingKey || findingKey(finding));
  const deferred = [];
  const written = [];
  let before;
  try {
    // The checkout must still name the branch the lineage was derived from
    // right before the durable writes (checked under the lock).
    if (branchOverride === undefined) {
      const liveBranch = await currentBranch(context.repoRoot);
      if (liveBranch !== branch) {
        throw new Error(`The checkout switched from ${branch} to ${liveBranch || '(detached)'} while recording; rerun the command on a settled checkout or pass --branch ${branch}.`);
      }
    }
    before = await readDispositions(context.paths, lineage);
    for (const [index, finding] of selected.entries()) {
      const record = await recordDisposition(context.paths, lineage, {
        key: keys[index],
        title: finding.title,
        file: finding.file,
        priority: finding.priority,
        reason,
        headSha,
        // A re-recorded decision keeps the rename history the propagated
        // record carried.
        previousFiles: before.get(keys[index])?.previousFiles || [],
      }, { prune: false });
      written.push(keys[index]);
      deferred.push(record);
    }
    // One retention pass for the whole batch, after every record is durable.
    await pruneDispositions(context.paths, {
      onPruneError: (error) => process.stderr.write(`Shared review gate: disposition retention prune failed: ${error?.message || error}\n`),
    });
  } catch (error) {
    const unrestored = [];
    for (const key of written) {
      if (!before) break;
      try {
        const previous = before.get(key);
        if (previous) {
          await recordDisposition(context.paths, lineage, {
            key, title: previous.title, file: previous.file, priority: previous.priority,
            reason: previous.reason, headSha: previous.headSha, source: previous.source || 'author',
            createdAt: previous.at, previousFiles: previous.previousFiles || [],
          }, { prune: false });
        } else {
          await removeDisposition(context.paths, lineage, key);
        }
      } catch {
        unrestored.push(key);
      }
    }
    throw new Error(`Recording the deferral(s) failed: ${error?.message || String(error)}.${unrestored.length ? ` Restoring these keys also failed and they now hold this batch's decision: ${unrestored.join(', ')}.` : ' Every key was restored to its previous state.'}`);
  } finally {
    // A release failure must not replace the batch's own result.
    try {
      await releaseLock();
    } catch (releaseError) {
      process.stderr.write(`Shared review gate: disposition lock release failed: ${releaseError?.message || releaseError}\n`);
    }
  }
  const blockedAny = selected.some((finding) => finding.disposition === 'verified');
  return {
    headSha,
    branch,
    reportId: report.id,
    deferred: deferred.map(({ key, title, file, priority, reason: why }) => ({ key, title, file, priority, reason: why })),
    next: blockedAny
      ? `Rerun npx --no-install rove-sentinel gate --base ${base} --head ${head} so the head is attested with the deferrals applied (a deferred blocking finding needs a fresh verdict).`
      : 'The deferrals apply immediately: the attested head can be pushed, and the PR comment will list them.',
  };
}
