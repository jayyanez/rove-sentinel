import {
  changedFiles,
  changedFilesWithStatus,
  currentBranch,
  defaultBaseForPush,
  inferAuthor,
  isAncestor,
  mergeBase,
  parsePrePushInput,
  readPatch,
  resolveCommit,
  showBlobAtCommit,
  showFileAtCommit,
} from './git.mjs';
import { startDaemonDetached } from './daemon.mjs';
import { acquireReviewLease } from './maintenance.mjs';
import { CHARTER_VERSION, GATE_VERSION, LIMITS } from './constants.mjs';
import { loadInstalledReviewPolicy } from './context.mjs';
import { undisposedRefusal } from './dispositions.mjs';
import { createGateContext, formatGateResult, runGate } from './gate.mjs';
import {
  CONTROL_REGISTRY,
  evidenceScreenshotPaths,
  isPngBlob,
  formatGuiEvidenceRefusal,
  guiEvidenceProblems,
  isGuiDiff,
  isTagRefType,
  reviewDocPath,
} from './guiEvidence.mjs';
import { isOrdinaryDocumentationSkip } from './risk.mjs';
import {
  attestationIdentity,
  cancelQueuedRequest,
  clearDaemonError,
  daemonOwnerIsHealthy,
  pruneDirectory,
  readAttestation,
  readJson,
  readPause,
  recordEvent,
  removeAttestation,
  submitRequest,
  waitForDaemonHeartbeat,
  waitForResult,
} from './storage.mjs';

export function assertReviewIdentity(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) {
      throw new Error(`Shared review daemon returned a mismatched ${key}; expected ${value}, received ${actual?.[key] ?? 'missing'}. Refusing to authorize this push with stale review evidence.`);
    }
  }
}

function branchFromRef(localRef, fallback) {
  if (localRef.startsWith('refs/heads/')) return localRef.slice('refs/heads/'.length);
  if (localRef.startsWith('refs/tags/')) return `tag/${localRef.slice('refs/tags/'.length)}`;
  return localRef.startsWith('refs/') ? localRef.slice('refs/'.length) : fallback;
}

/**
 * The pushed ref's TYPE, decided by its namespace and nothing else:
 * `refs/tags/…` is a tag; everything else (including a branch literally
 * named `tag/release`, i.e. `refs/heads/tag/release`) is a branch. The
 * display name `branchFromRef` derives must never be sniffed for this.
 */
export function refTypeFromRef(localRef) {
  return String(localRef || '').startsWith('refs/tags/') ? 'tag' : 'branch';
}

export function nonPassRemediation(status) {
  if (status === 'needs_native_evidence') {
    return 'Push blocked pending native evidence. Complete the live-build checklist and rerun npx --no-install rove-sentinel gate with --native-evidence "<concise observed result>".';
  }
  return 'Push blocked by the shared review gate. Resolve the findings and rerun npx --no-install rove-sentinel gate.';
}

export function buildGateRequestOptions({ repoRoot, identity, branch }) {
  if (!identity?.baseSha || !identity?.headSha) {
    throw new Error('Shared review request requires an exact immutable review identity.');
  }
  return {
    repoRoot,
    base: identity.baseSha,
    head: identity.headSha,
    branch,
    author: inferAuthor(branch),
  };
}

export async function submitAndStartReview(
  context,
  options,
  {
    submit = submitRequest,
    clearError = clearDaemonError,
    start = startDaemonDetached,
    cancel = cancelQueuedRequest,
  } = {},
) {
  const request = await submit(context.paths, { type: 'gate', options });
  try {
    await clearError(context.paths);
    await start(context.repoRoot, context.stateRoot);
    return request;
  } catch (error) {
    try {
      await cancel(context.paths, request.id);
    } catch (cancelError) {
      throw new Error(`${error?.message || String(error)} The queued request also could not be cancelled: ${cancelError?.message || String(cancelError)}. Run npx --no-install rove-sentinel status before retrying.`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function waitForHookResult(
  paths,
  requestId,
  options,
  {
    wait = waitForResult,
    cancel = cancelQueuedRequest,
    signalHost = process,
  } = {},
) {
  const controller = new AbortController();
  let rejectInterruption;
  const interruption = new Promise((_, reject) => {
    rejectInterruption = reject;
  });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      const error = new Error(`Shared review gate wait interrupted by ${signal}; the unclaimed request was cancelled.`);
      controller.abort(error);
      void cancel(paths, requestId).catch(() => {});
      rejectInterruption(error);
    };
    handlers.set(signal, handler);
    signalHost.once(signal, handler);
  }
  try {
    return await Promise.race([
      wait(paths, requestId, { ...options, signal: controller.signal }),
      interruption,
    ]);
  } finally {
    for (const [signal, handler] of handlers) signalHost.removeListener(signal, handler);
  }
}

export async function waitingWatcherProblem(paths, expectedPolicyDigest) {
  const [lock, heartbeat] = await Promise.all([
    readJson(paths.lock).catch(() => null),
    readJson(paths.heartbeat).catch(() => null),
  ]);
  if (!daemonOwnerIsHealthy(lock, heartbeat)) {
    return 'The shared review watcher stopped or lost its healthy owner heartbeat while this push was waiting. Run npx --no-install rove-sentinel status, then retry after recovery.';
  }
  if (
    heartbeat.gateVersion !== GATE_VERSION ||
    heartbeat.charterVersion !== CHARTER_VERSION ||
    (expectedPolicyDigest && heartbeat.policyDigest !== expectedPolicyDigest)
  ) {
    return `The shared review watcher changed to incompatible policy identity ${heartbeat.gateVersion || 'unknown'}/${heartbeat.charterVersion || 'unknown'}/${heartbeat.policyDigest || 'unknown'} while this push was waiting. Run npx --no-install rove-sentinel install from your trusted main checkout.`;
  }
  if (heartbeat.activity === 'error') {
    return `The shared review watcher reported an internal loop error: ${String(heartbeat.error || 'unknown error').slice(0, 1000)}. Run npx --no-install rove-sentinel status and retry after recovery.`;
  }
  return null;
}

/**
 * The whole decision table for the one-unattested-ref rule, pure and exported so
 * every outcome is testable — 0 and 1 must proceed, 2+ must refuse. Inline, the
 * boundary was unverifiable: the suite covered 2, 0, and 1-blocked-by-pause, so
 * changing `> 1` to `>= 1` would have blocked every ordinary push and left every
 * test green.
 */
export async function attestOrdinaryDocsSkipIfNeeded({
  repoRoot,
  stateRoot,
  identity,
  branch,
  policy,
  listChanged = changedFiles,
  isDocsSkip = isOrdinaryDocumentationSkip,
  attest = runGate,
}) {
  if (!identity?.baseSha || !identity?.headSha) return null;
  const files = await listChanged(repoRoot, identity.baseSha, identity.headSha);
  if (!isDocsSkip(files, policy?.config)) return null;
  return await attest({
    repoRoot,
    stateRoot,
    base: identity.baseSha,
    head: identity.headSha,
    branch,
    policy,
  });
}

/**
 * GUI evidence gate (visual-redesign-plan.md §5.1): a GUI diff must commit its
 * own screenshots and registry rows. Committed files only, read off the exact
 * base...head identity, and decided BEFORE any attestation read or reviewer —
 * cheap, offline, and fail-closed. Docs-only diffs never match `isGuiDiff`,
 * deletions never reach here, and the bypass skips planning entirely, so none
 * of those semantics change. A tag push (`refType` `'tag'`, decided by the
 * ref namespace in `refTypeFromRef`, never by the display name) is checked too: git never requires a tagged commit to have been pushed
 * through a branch, so the tag's own base...head diff must carry evidence —
 * a PNG under ANY docs/design/reviews/<slug>/ folder, since a tag has no
 * branch slug (the registry rule applies unchanged). The changed-file list
 * carries git statuses so a deleted screenshot never counts, the registry is
 * read AS COMMITTED AT HEAD so a new control needs a real row, not a touched
 * file, and every evidence PNG is read AS COMMITTED AT HEAD (binary-safe) so
 * a text file named `.png` is refused. A branch's REVIEW.md must be added or
 * modified in the diff itself (it is in the status-carrying list); a tag's
 * REVIEW.md (the one next to each counted PNG) is read at head the same way
 * as the PNGs, so the review document must exist in the pushed history, not
 * only in a working tree.
 */
export async function guiEvidenceRefusal({
  config,
  repoRoot,
  identity,
  branch,
  refType = 'branch',
  listChanged = changedFilesWithStatus,
  readDiff = readPatch,
  readRegistry = showFileAtCommit,
  readBlobAtHead = showBlobAtCommit,
}) {
  if (config && config.guiEvidence !== 'rove') return null;
  if (!identity?.baseSha || !identity?.headSha) return null;
  const files = await listChanged(repoRoot, identity.baseSha, identity.headSha);
  if (!isGuiDiff(files)) return null;
  const patch = await readDiff(repoRoot, identity.baseSha, identity.headSha);
  const registry = await readRegistry(repoRoot, identity.headSha, CONTROL_REGISTRY);
  // Screenshots are read ONE AT A TIME inside the validator's `readBlob`
  // callback and dropped right after their PNG check, so a large visual
  // branch never holds more than one screenshot in memory at once.
  const screenshots = evidenceScreenshotPaths(files, branch, refType);
  const pngVerdicts = new Map();
  for (const file of screenshots) {
    const blob = await readBlobAtHead(repoRoot, identity.headSha, file);
    pngVerdicts.set(file, isPngBlob(blob));
  }
  // Only a tag reads its review documents at head; a branch decides from the
  // diff's own entries (added/modified), which need no blob read.
  const reviewDocs = isTagRefType(refType)
    ? [...new Set(screenshots.map((file) => reviewDocPath(file.split('/')[3])))]
    : [];
  const docs = new Map();
  for (const file of reviewDocs) {
    docs.set(file, await readBlobAtHead(repoRoot, identity.headSha, file));
  }
  const problems = guiEvidenceProblems({
    files,
    branch,
    refType,
    patch,
    registry,
    pngValid: (file) => pngVerdicts.get(file) === true,
    hasFile: (file) => docs.get(file) != null,
  });
  return problems.length ? formatGuiEvidenceRefusal(branch, problems) : null;
}

export function unattestedRefusal(branches) {
  if (branches.length <= 1) return null;
  const named = branches.slice(0, 3).join(', ');
  return `Shared review gate reviews one unattested ref per push; this push carries ${branches.length} (${named}${branches.length > 3 ? ', …' : ''}). Each review may take up to ${Math.round(LIMITS.hookWaitTimeoutMs / 60000)} minutes, and together they would exceed that bound. Attest them first with npx --no-install rove-sentinel gate, or push them one at a time.`;
}

export async function runPrePush({
  repoRoot = process.cwd(),
  stateRoot,
  input,
  env = process.env,
  output = (message) => process.stderr.write(`${message}\n`),
  remoteName,
  // Seam: both the planning read and the pre-count re-read go through this, so
  // a test can interleave a PASS between them the way a concurrent
  // `npx --no-install rove-sentinel gate` does.
  readAttestationFor = readAttestation,
  attestDocsSkip = attestOrdinaryDocsSkipIfNeeded,
  checkGuiEvidence = guiEvidenceRefusal,
  // Seams for the audit trail: bypass/deletion events are still written one
  // per ref (durability ordering unchanged), but their retention prune runs
  // ONCE per invocation instead of once per event — a deletion batch of
  // thousands of refs used to stat the whole audit directory after every
  // single write.
  writeAuditEvent = recordEvent,
  pruneAuditEvents = pruneDirectory,
} = {}) {
  const refs = parsePrePushInput(input || '');
  if (!refs.length) return { reviewed: 0, bypassed: 0 };
  // Review evidence belongs to the checkout's canonical repository identity,
  // not to whichever push destination happened to invoke this hook.
  const context = await createGateContext(repoRoot, { stateRoot });
  const releaseReview = await acquireReviewLease(context.paths);
  // Every refusal below — including the earliest ones — must still run the
  // audit-retention prune on the way out (Greptile P2 on 04aa959e): the
  // unconditional per-invocation prune exists to heal a ledger left above its
  // bound by a crash between event writes, and refused pushes are exactly the
  // invocations that never reach the execution loop's own path.
  try {
    // Bound the ordinary-ref candidate count BEFORE any planning (#4): planning
    // each ref resolves its target and merge base, so an over-wide push could
    // pay that cost for every ref it will inevitably refuse. Deletion batches
    // never plan and stay exempt. A raw-SHA bypass match is honored here too;
    // an annotated tag pointing at the bypass SHA would count as a candidate —
    // acceptable for a generous bound whose refusal is immediate and explained.
    const bypassSha = String(env.ROVE_REVIEW_BYPASS_SHA || '');
    const candidates = refs.filter(
      (ref) => !ref.deletion && !(bypassSha && ref.localSha === bypassSha),
    );
    if (candidates.length > LIMITS.maxPushCandidateRefs) {
      throw new Error(
        `Shared review gate plans at most ${LIMITS.maxPushCandidateRefs} ordinary refs per push; this push carries ${candidates.length}. Push in smaller batches (ref deletions are exempt), or attests heads with npx --no-install rove-sentinel gate first.`,
      );
    }
  const pushRemoteName = pushRemoteNameForHook(remoteName, context.remoteName);
  const paused = await readPause(context.paths);
  const fallbackBranch = await currentBranch(context.repoRoot);
  let reviewed = 0;
  let bypassed = 0;

  const bypassReason = String(env.ROVE_REVIEW_BYPASS_REASON || '').trim();
  const plans = [];
  let reviewPolicy = null;
  for (const ref of refs) {
    const branch = ref.deletion
      ? branchFromRef(ref.remoteRef, fallbackBranch)
      : branchFromRef(ref.localRef, fallbackBranch);
    const targetSha = ref.deletion
      ? ref.remoteSha
      : await resolveCommit(context.repoRoot, ref.localSha);
    const bypass = env.ROVE_REVIEW_BYPASS_SHA === targetSha;
    if (!bypass && ref.remoteRef === 'refs/heads/main' && ref.deletion) {
      throw new Error('Shared review gate blocks deletion of main. Use the documented exact-SHA emergency bypass only if deleting the protected branch is intentional.');
    }
    if (!bypass && ref.remoteRef === 'refs/heads/main' && !/^0+$/.test(ref.remoteSha)) {
      if (!(await isAncestor(context.repoRoot, ref.remoteSha, ref.localSha))) {
        throw new Error('Shared review gate blocks a non-fast-forward update of main. Use the documented exact-SHA emergency bypass only if this destructive rollback is intentional.');
      }
    }
    if (ref.deletion) {
      plans.push({ ref, branch, bypass, deletion: true, targetSha });
      continue;
    }
    const base = defaultBaseForPush(ref, ref.remoteSha, pushRemoteName);
    let identity = null;
    let attestation = null;
    if (!bypass) {
      reviewPolicy ||= await loadInstalledReviewPolicy(context.paths);
      const baseSha = await resolveCommit(context.repoRoot, base);
      const canonicalBaseSha = await mergeBase(context.repoRoot, baseSha, targetSha);
      identity = attestationIdentity({
        repository: context.repository,
        baseSha: canonicalBaseSha,
        headSha: targetSha,
        policyDigest: reviewPolicy.policyDigest,
      });
      // Refuse a GUI diff without committed evidence here, before the first
      // attestation read: no reviewer, daemon, or PASS can stand in for the
      // screenshots and registry rows the branch itself must carry.
      const evidenceRefusal = await checkGuiEvidence({
        config: reviewPolicy.config,
        repoRoot: context.repoRoot,
        identity,
        branch,
        refType: refTypeFromRef(ref.localRef),
      });
      if (evidenceRefusal) throw new Error(evidenceRefusal);
      try {
        attestation = await readAttestationFor(context.paths, identity);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        await removeAttestation(context.paths, identity);
      }
    }
    plans.push({
      ref,
      branch,
      bypass,
      deletion: false,
      targetSha,
      identity,
      attestation,
    });
  }
  // Each unattested ref below starts its OWN hookWaitTimeoutMs, so N of them in
  // one push could hold that push for N times the charter's bound. Carrying a
  // remaining-time budget across the refs was implemented and reverted: it left
  // planning and the audit branches unbounded, a sliver of remaining time still
  // submitted work the hook then abandoned mid-claim, and a PASS written by an
  // earlier ref was not re-read, so a later ref was falsely blocked.
  //
  // Admitting at most ONE unattested ref per push makes the charter's bound
  // literally true instead, and removes both of those failure modes with it:
  // there is no shortened wait and no second ref to hold stale evidence.
  // Re-read before counting. The snapshots above were taken one ref at a time,
  // and a concurrent `npx --no-install rove-sentinel gate` can write an exact PASS in between;
  // counting a stale null would refuse a push that already has its evidence.
  // The refreshed value is stored back on the plan, so the loop below reuses it
  // instead of requiring a live watcher for a PASS that already exists.
  const unattested = [];
  for (const plan of plans) {
    if (plan.deletion || plan.bypass || plan.attestation) continue;
    if (plan.identity) {
      try {
        plan.attestation = await readAttestationFor(context.paths, plan.identity);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        await removeAttestation(context.paths, plan.identity);
      }
    }
    if (!plan.attestation && plan.identity) {
      plan.attestation = await attestDocsSkip({
        repoRoot: context.repoRoot,
        stateRoot: context.stateRoot,
        identity: plan.identity,
        branch: plan.branch,
        policy: reviewPolicy,
      });
    }
    if (!plan.attestation) unattested.push(plan);
  }

  // Decide on a FRESH read (#2). The refresh above reads each candidate in
  // sequence, so a PASS written after an EARLIER ref's refresh was invisible to
  // the length check that follows — the window grew with the per-ref planning
  // in between. One tight re-read pass over exactly the collected misses,
  // immediately before the checks below, shrinks that window to the instant
  // between the last read and the decision.
  for (const plan of unattested) {
    if (plan.attestation || !plan.identity) continue;
    try {
      plan.attestation = await readAttestationFor(context.paths, plan.identity);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await removeAttestation(context.paths, plan.identity);
    }
  }

  // Both refusals below read the SAME refreshed set — the plans still missing
  // an attestation AFTER the decision-time re-read above, not the array the
  // refresh loop happened to collect into (a plan whose PASS just landed there
  // must not trip the pause guard; review 1.7.0).
  const stillUnattested = unattested.filter((plan) => !plan.attestation);
  if (paused && stillUnattested.length) {
    throw new Error(`Shared review gate is paused: ${paused.reason}. Resume it or use the documented exact-SHA emergency bypass.`);
  }
  const refusal = unattestedRefusal(stillUnattested.map((plan) => plan.branch));
  if (refusal) throw new Error(refusal);

  for (const { branch, bypass, deletion, targetSha, identity, attestation } of plans) {
      if (bypass) {
        if (bypassReason.length < 12) {
          throw new Error('ROVE_REVIEW_BYPASS_REASON must explain the exact-SHA emergency bypass (minimum 12 characters).');
        }
        await writeAuditEvent(
          context.paths,
          {
            type: 'emergency-bypass',
            headSha: targetSha,
            branch,
            operation: deletion ? 'delete' : 'update',
            reason: bypassReason,
          },
          { deferPrune: true },
        );
        output(`Shared review gate: emergency bypass recorded for ${targetSha.slice(0, 12)}.${deletion ? '' : ' The PR watcher will still review it.'}`);
        bypassed += 1;
        continue;
      }
      if (deletion) {
        await writeAuditEvent(
          context.paths,
          {
            type: 'ref-deletion',
            headSha: targetSha,
            branch,
          },
          { deferPrune: true },
        );
        output(`Shared review gate: ref deletion recorded for ${branch}; no code diff requires review.`);
        continue;
      }
      if (attestation) {
        // A PASS whose verified advisories were neither fixed nor deferred
        // is not pushable (v1.8.0): the decision must be recorded, not
        // skipped — and the refusal is decided before a PASS line is printed.
        const pendingRefusal = await undisposedRefusal(context.paths, attestation, targetSha, { branch });
        if (pendingRefusal) throw new Error(pendingRefusal);
        output(formatGateResult({ ...attestation, cached: true }));
        reviewed += 1;
        continue;
      }

      const request = await submitAndStartReview(
        context,
        buildGateRequestOptions({ repoRoot: context.repoRoot, identity, branch }),
      );
      let response;
      try {
        await waitForDaemonHeartbeat(context.paths, context.repoRoot, {
          policyDigest: reviewPolicy.policyDigest,
        });
        output(`Shared review gate: checking ${branch} at ${targetSha.slice(0, 12)}…`);
        response = await waitForHookResult(context.paths, request.id, {
          onProgress(elapsedMs) {
            output(`Shared review gate: still reviewing (${Math.round(elapsedMs / 1000)}s elapsed)…`);
          },
          async shouldCancel() {
            const currentPause = await readPause(context.paths);
            if (currentPause) {
              return `Shared review gate was paused while this push was waiting: ${currentPause.reason}`;
            }
            return await waitingWatcherProblem(context.paths, reviewPolicy.policyDigest);
          },
        });
      } catch (error) {
        await cancelQueuedRequest(context.paths, request.id);
        throw error;
      }
      if (response.status === 'error') {
        throw new Error(`Shared review gate failed closed: ${response.error}`);
      }
      if (response.status !== response.result?.status) {
        throw new Error('Shared review daemon returned inconsistent envelope and result statuses; refusing to authorize this push.');
      }
      assertReviewIdentity(response.result?.identity, identity);
      if (response.status !== 'pass') {
        output(formatGateResult(response.result));
        throw new Error(nonPassRemediation(response.status));
      }
      const freshRefusal = await undisposedRefusal(context.paths, response.result, targetSha, { branch });
      if (freshRefusal) throw new Error(freshRefusal);
      output(formatGateResult(response.result));
      reviewed += 1;
    }
    return { reviewed, bypassed };
  } finally {
    // ONE retention prune per invocation for the audit directory, UNCONDITIONAL
    // and covering EVERY exit above — early refusals included (Greptile P2 on
    // 04aa959e): a crash between the per-event writes of a PREVIOUS invocation
    // leaves the ledger above its bound, and a later push that refuses early
    // or records no audit event must still heal it. One readdir + stats per
    // push is trivial next to the per-event pruning this replaced. A prune
    // FAILURE must stay visible — retention silently disabled is how the
    // ledger grows forever — but it must not fail an otherwise-complete push
    // over hygiene.
    await pruneAuditEvents(context.paths.auditEvents, {
      maxFiles: LIMITS.maxAuditEvents,
      maxAgeMs: LIMITS.auditRetentionMs,
    }).catch((error) => {
      process.stderr.write(`Shared review gate: audit retention prune failed: ${error?.message || error}\n`);
    });
    await releaseReview();
  }
}

export function pushRemoteNameForHook(remoteName, configuredRemoteName) {
  const candidate = String(remoteName || '').trim();
  const looksLikeUrlOrPath = (
    candidate.includes('://') ||
    /^[^@\s]+@[^:\s]+:/.test(candidate) ||
    /[\\/]/.test(candidate) ||
    /^[.~]/.test(candidate)
  );
  return candidate && !looksLikeUrlOrPath
    ? candidate
    : String(configuredRemoteName || '').trim();
}
