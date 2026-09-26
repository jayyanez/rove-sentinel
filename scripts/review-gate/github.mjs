import { COMMENT_MARKER, LIMITS } from './constants.mjs';
import { ensureCommitAvailable, inferAuthor, mergeBase, repoSlugFromRemote } from './git.mjs';
import { applyRecordedDeferrals } from './dispositions.mjs';
import { processTreeCleanupFailureCode, runProcess } from './process.mjs';
import {
  attestationIdentity,
  readAttestation,
  readOutcome,
  recordEvent,
  pauseGate,
  removeAttestation,
  removeOutcome,
  writeOutcome,
} from './storage.mjs';

function truncate(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  if (max <= 0) return '';
  if (max === 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

function inlineText(value, max) {
  return truncate(value, max).replace(/[\r\n]+/g, ' ').replaceAll('`', "'");
}

function githubCodeText(value, max) {
  return inlineText(value, max).replaceAll('@', '@\u200b');
}

async function pauseForUnverifiedProcessTree(context, error, pause) {
  const cleanupCode = processTreeCleanupFailureCode(error);
  if (!cleanupCode) return false;
  await pause(
    context.paths,
    cleanupCode === 'ORPHANED_PROCESS_TREE'
      ? 'Windows provider parent exited before inherited pipes closed; inspect remaining provider processes before resuming.'
      : 'Provider process-tree cleanup could not be verified; inspect remaining provider processes before resuming.',
  );
  return true;
}

export function githubText(value, max) {
  // Every value passed here can contain model-produced text derived from an
  // explicitly untrusted patch. Flatten it and escape all CommonMark ASCII
  // punctuation so links, images, raw HTML, autolinks, headings, and lists are
  // rendered as inert text. Keep mention neutralization even after Markdown
  // escaping because GitHub applies its own @-mention layer.
  const escaped = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('`', "'")
    .replaceAll('@', '@\u200b')
    .replace(/[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/g, '\\$&');
  if (escaped.length <= max) return escaped;
  if (max <= 0) return '';
  if (max === 1) return '…';
  let prefix = escaped.slice(0, max - 1);
  let trailingBackslashes = 0;
  for (let index = prefix.length - 1; index >= 0 && prefix[index] === '\\'; index -= 1) {
    trailingBackslashes += 1;
  }
  if (trailingBackslashes % 2 === 1) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function compactFinding(finding) {
  return {
    disposition: finding.disposition,
    adjudicatedDisposition: finding.adjudicatedDisposition,
    enforcement: finding.enforcement,
    priority: inlineText(finding.priority, 8),
    file: inlineText(finding.file, 500),
    line: finding.line ?? null,
    title: inlineText(finding.title, 300),
    reason: inlineText(finding.reason, LIMITS.githubFindingChars),
    advisoryReason: finding.advisoryReason
      ? inlineText(finding.advisoryReason, LIMITS.githubFindingChars)
      : undefined,
    blockingReason: finding.blockingReason ? inlineText(finding.blockingReason, 32) : undefined,
    requiresDisposition: finding.requiresDisposition === true ? true : undefined,
    // The key must survive intact (file and title are each bounded at 4,000
    // characters upstream), or a republished comment cannot match its
    // recorded deferral.
    findingKey: typeof finding.findingKey === 'string' ? finding.findingKey.slice(0, 8_200) : undefined,
    deferral: finding.deferral
      ? { headSha: inlineText(finding.deferral.headSha || '', 40), reason: inlineText(finding.deferral.reason || '', LIMITS.githubFindingChars) }
      : undefined,
  };
}

function compactOutcomeResult(result) {
  const visible = (result.findings || [])
    .filter((finding) => finding.disposition !== 'dismissed');
  const actionable = visible.filter((finding) => finding.disposition !== 'advisory');
  const advisories = visible.filter((finding) => finding.disposition === 'advisory');
  return {
    status: result.status,
    identity: result.identity,
    risk: result.risk,
    summary: truncate(result.summary, LIMITS.githubSummaryChars),
    actionableCount: result.actionableCount ?? actionable.length,
    advisoryCount: result.advisoryCount ?? advisories.length,
    convergence: result.convergence,
    lineage: result.lineage,
    reportId: result.reportId,
    deferredCount: advisories.filter((finding) => finding.deferral).length,
    // The stored outcome keeps every finding up to the adjudication bound
    // (compact), not only the comment's row budget: a deferral recorded later
    // must still find its finding when the outcome is republished.
    findings: [...actionable, ...advisories]
      .slice(0, LIMITS.maxCandidates + LIMITS.maxDeterministicFindings)
      .map(compactFinding),
  };
}

async function runGh(repoRoot, args, { input, allowFailure = false } = {}) {
  return await runProcess('gh', args, {
    cwd: repoRoot,
    input,
    allowFailure,
    timeoutMs: 120_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
}

export async function listReadyPullRequests(
  repoRoot,
  { run = runGh, limit = LIMITS.maxOpenPullRequests, repoSlug, trustedAuthors = [] } = {},
) {
  if (!repoSlug) {
    throw new Error('Ready-PR discovery requires an explicit GitHub repository slug.');
  }
  const args = [
    'pr',
    'list',
    '--repo',
    repoSlug,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    'number,headRefOid,baseRefOid,isDraft,url,headRefName,baseRefName,author,isCrossRepository',
  ];
  const result = await run(repoRoot, args);
  const open = JSON.parse(result.stdout);
  if (!Array.isArray(open)) {
    throw new Error('GitHub CLI returned a non-array pull-request list.');
  }
  if (open.length >= limit) {
    throw new Error(`Ready-PR discovery reached its ${limit}-PR safety bound and cannot prove complete coverage. Reduce the open PR backlog or raise the reviewed bound deliberately.`);
  }
  const allowed = new Set((trustedAuthors.length ? trustedAuthors : [repoSlug.split('/')[0]]).map((name) => name.toLowerCase()));
  return open.filter((pr) => !pr.isDraft && pr.isCrossRepository === false && allowed.has(String(pr.author?.login || '').toLowerCase()));
}

export async function currentGitHubLogin(repoRoot) {
  const result = await runGh(repoRoot, ['api', 'user', '--jq', '.login']);
  const login = result.stdout.trim();
  if (!login) throw new Error('GitHub CLI did not report the authenticated login.');
  return login;
}

export function findOwnedGateComment(comments, publisherLogin) {
  const owner = String(publisherLogin || '').toLowerCase();
  return comments.find((comment) => (
    comment.body?.startsWith(`${COMMENT_MARKER}\n`) &&
    comment.user?.login?.toLowerCase() === owner
  ));
}

export function renderGateComment(result) {
  const advisoryFindings = (result.findings || [])
    .filter((finding) => finding.disposition === 'advisory');
  const status = result.status === 'pass'
    ? advisoryFindings.length ? 'PASS WITH ADVISORIES' : 'PASS'
    : result.status === 'fail'
      ? 'FAIL'
      : result.status === 'needs_native_evidence'
        ? 'NEEDS NATIVE EVIDENCE'
        : 'ERROR';
  const identity = result.identity || {};
  const lines = [
    COMMENT_MARKER,
    `## Shared review gate: ${status}`,
    '',
    `- Head: \`${(identity.headSha || '').slice(0, 12)}\``,
    `- Base: \`${(identity.baseSha || '').slice(0, 12)}\``,
    `- Risk: ${result.risk || 'unknown'}`,
    `- Gate: ${identity.gateVersion || 'unknown'} / charter ${identity.charterVersion || 'unknown'}`,
    '',
    githubText(result.summary || 'No summary was produced.', LIMITS.githubSummaryChars),
  ];
  if (result.convergence) {
    const convergence = result.convergence;
    lines.splice(7, 0,
      `- Round: ${convergence.round === 'follow-up' ? 'follow-up' : 'full'}; late-discovery blocks used: ${Number(convergence.lateDiscoveriesUsed) || 0}/${Number(convergence.lateDiscoveryQuota) || LIMITS.lateDiscoveryBlockingQuota}; deferrals: ${Number(convergence.deferrals) || 0}`,
    );
  }
  const allActionable = (result.findings || []).filter((finding) => (
    finding.disposition !== 'dismissed' && finding.disposition !== 'advisory'
  ));
  const actionable = allActionable.slice(0, LIMITS.githubCommentFindings);
  const actionableCount = Math.max(result.actionableCount || 0, allActionable.length);
  if (actionable.length) {
    lines.push('', '### Action required', '');
    for (const finding of actionable) {
      const why = finding.blockingReason && !['always', 'first-review'].includes(finding.blockingReason)
        ? ` [${githubText(finding.blockingReason, 32)}]`
        : '';
      lines.push(
        `- **${githubText(finding.priority, 8)}** \`${githubCodeText(finding.file, 500)}${finding.line ? `:${finding.line}` : ''}\` — ${githubText(finding.title, 300)}. ${githubText(finding.reason, LIMITS.githubFindingChars)}${why}`,
      );
    }
    if (actionableCount > actionable.length) {
      lines.push(`- ${actionableCount - actionable.length} additional finding(s) are available in the bounded local report.`);
    }
  }
  const deferred = advisoryFindings.filter((finding) => finding.deferral);
  const undeferred = advisoryFindings.filter((finding) => !finding.deferral);
  // ONE row budget for actionable, advisory and deferred rows: bounded rows
  // times bounded fields keeps the body under GitHub's 65,536-character
  // comment limit (20 rows × ≈2.8 KB + a 4 KB summary).
  const advisorySlots = Math.max(0, LIMITS.githubCommentFindings - actionable.length);
  const advisories = undeferred.slice(0, advisorySlots);
  const deferredSlots = Math.max(0, advisorySlots - advisories.length);
  const advisoryCount = Math.max(result.advisoryCount || 0, advisoryFindings.length);
  if (advisories.length) {
    lines.push('', '### Advisory follow-up (non-blocking)', '');
    for (const finding of advisories) {
      lines.push(
        `- **${githubText(finding.priority, 8)}** \`${githubCodeText(finding.file, 500)}${finding.line ? `:${finding.line}` : ''}\` — ${githubText(finding.title, 300)}. ${githubText(finding.reason, LIMITS.githubFindingChars)} ${githubText(finding.advisoryReason || '', LIMITS.githubFindingChars)}`.trimEnd(),
      );
    }
    const deferredTotal = Math.max(Number(result.deferredCount) || 0, deferred.length);
    if (advisoryCount - deferredTotal > advisories.length) {
      lines.push(`- ${advisoryCount - deferredTotal - advisories.length} additional advisory finding(s) are available in the bounded local report.`);
    }
  }
  // Author deferrals are published, never hidden: a verified finding the
  // author chose not to fix is a visible decision with its reason (v1.8.0).
  // Author deferrals never vanish behind the row budget: when no row fits,
  // or the stored result was compacted, the count still says they exist.
  // One heading, whatever fits under it.
  const shownDeferred = deferred.slice(0, deferredSlots);
  const deferredCount = Math.max(Number(result.deferredCount) || 0, deferred.length);
  if (shownDeferred.length || deferredCount > 0) {
    lines.push('', '### Deferred by the author (verified, not fixed)', '');
    for (const finding of shownDeferred) {
      lines.push(
        `- **${githubText(finding.priority, 8)}** \`${githubCodeText(finding.file, 500)}${finding.line ? `:${finding.line}` : ''}\` — ${githubText(finding.title, 300)}. ${githubText(finding.reason, LIMITS.githubFindingChars)} Reason: ${githubText(finding.deferral.reason || '', LIMITS.githubFindingChars)}`,
      );
    }
    if (deferredCount > shownDeferred.length) {
      lines.push(`- ${deferredCount - shownDeferred.length} additional deferred finding(s) are recorded in the bounded local report.`);
    }
  }
  lines.push('', '_Local subscription-backed review; exact-SHA attestation. No API key is stored in GitHub._');
  return lines.join('\n');
}

export async function publishGateComment(
  repoRoot,
  repoSlug,
  prNumber,
  result,
  { publisherLogin } = {},
) {
  const body = renderGateComment(result);
  const owner = (publisherLogin || await currentGitHubLogin(repoRoot)).toLowerCase();
  const commentsResult = await runGh(repoRoot, [
    'api',
    `repos/${repoSlug}/issues/${prNumber}/comments`,
    '--paginate',
    '--slurp',
  ]);
  const pages = JSON.parse(commentsResult.stdout);
  const comments = pages.flatMap((page) => page);
  const existing = findOwnedGateComment(comments, owner);
  if (existing?.body === body) return { changed: false, commentId: existing.id };
  const endpoint = existing
    ? `repos/${repoSlug}/issues/comments/${existing.id}`
    : `repos/${repoSlug}/issues/${prNumber}/comments`;
  const method = existing ? 'PATCH' : 'POST';
  const response = await runGh(
    repoRoot,
    ['api', endpoint, '--method', method, '--input', '-'],
    { input: JSON.stringify({ body }) },
  );
  return { changed: true, commentId: JSON.parse(response.stdout).id };
}

function retryDue(outcome, now) {
  if (outcome?.status !== 'error' || outcome.attempts >= LIMITS.githubErrorMaxAttempts) return false;
  const nextRetryAt = Date.parse(outcome.nextRetryAt);
  return !Number.isFinite(nextRetryAt) || nextRetryAt <= now;
}

function nextRetryAt(status, attempts, now) {
  if (status !== 'error' || attempts >= LIMITS.githubErrorMaxAttempts) return null;
  const delay = LIMITS.githubErrorRetryBaseMs * (2 ** (attempts - 1));
  return new Date(now + delay).toISOString();
}

export async function syncPullRequests({
  context,
  runGate,
  progress = () => {},
  listPullRequests = listReadyPullRequests,
  publish = publishGateComment,
  applyDeferrals = applyRecordedDeferrals,
  ensureCommit = ensureCommitAvailable,
  resolveMergeBase = mergeBase,
  now = Date.now,
  shouldStop = () => false,
  shouldYield = async () => false,
  pause = pauseGate,
}) {
  const repoSlug = repoSlugFromRemote(context.remote);
  if (!repoSlug) throw new Error(`GitHub publishing requires a github.com Git remote; found ${context.remote}`);
  let prs;
  let publisherLogin;
  try {
    prs = await listPullRequests(context.repoRoot, { repoSlug, trustedAuthors: context.policy.config?.trustedAuthors });
    publisherLogin = publish === publishGateComment
      ? await currentGitHubLogin(context.repoRoot)
      : null;
  } catch (error) {
    await pauseForUnverifiedProcessTree(context, error, pause);
    throw error;
  }
  const outcomes = [];
  const publishErrors = [];
  for (const pr of prs) {
    if (shouldStop()) break;
    if (await shouldYield()) break;
    let identity = attestationIdentity({
      repository: context.repository,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      policyDigest: context.policy.policyDigest,
    });
    let result;
    const setupIdentity = identity;
    let previousOutcome;
    let attempted = false;
    let stateError;
    try {
      previousOutcome = await readOutcome(context.paths, identity);
    } catch (error) {
      stateError = error;
    }
    if (previousOutcome?.status === 'error' && !retryDue(previousOutcome, now())) {
      result = previousOutcome.result;
    }
    try {
      if (!result) {
        await ensureCommit(context.repoRoot, pr.baseRefOid, pr.baseRefName, context.remoteName);
        await ensureCommit(context.repoRoot, pr.headRefOid, `refs/pull/${pr.number}/head`, context.remoteName);
        const canonicalBaseSha = await resolveMergeBase(
          context.repoRoot,
          pr.baseRefOid,
          pr.headRefOid,
        );
        if (canonicalBaseSha !== identity.baseSha) {
          await removeOutcome(context.paths, setupIdentity);
          identity = attestationIdentity({
            repository: context.repository,
            baseSha: canonicalBaseSha,
            headSha: pr.headRefOid,
            policyDigest: context.policy.policyDigest,
          });
          previousOutcome = undefined;
          stateError = undefined;
          try {
            previousOutcome = await readOutcome(context.paths, identity);
          } catch (error) {
            stateError = error;
          }
        }
        try {
          result = await readAttestation(context.paths, identity);
        } catch (error) {
          if (error instanceof SyntaxError) {
            await removeAttestation(context.paths, identity);
          } else {
            stateError ||= error;
          }
        }
        if (!result && ['fail', 'needs_native_evidence'].includes(previousOutcome?.status)) {
          result = previousOutcome.result;
        } else if (!result && previousOutcome && !retryDue(previousOutcome, now())) {
          result = previousOutcome.result;
        } else if (!result) {
          if (await shouldYield()) break;
          attempted = true;
          if (stateError) throw stateError;
          progress(`PR #${pr.number} head ${pr.headRefOid.slice(0, 12)} has no reusable outcome; reviewing it now.`);
          result = await runGate({
            repoRoot: context.repoRoot,
            stateRoot: context.stateRoot,
            base: pr.baseRefOid,
            head: pr.headRefOid,
            branch: pr.headRefName,
            author: inferAuthor(pr.headRefName),
            progress,
          });
        }
      }
    } catch (error) {
      if (await pauseForUnverifiedProcessTree(context, error, pause)) throw error;
      attempted = true;
      result = {
        status: 'error',
        identity,
        risk: 'unknown',
        summary: `The local review could not complete and did not produce an attestation: ${(error?.message || String(error)).slice(0, 1000)}`,
        findings: [],
      };
    }
    if (shouldStop()) throw new Error('GitHub review synchronization interrupted for watcher shutdown.');
    if (result.status === 'pass') {
      await removeOutcome(context.paths, identity);
    } else if (attempted) {
      const attempts = (previousOutcome?.attempts || 0) + 1;
      await writeOutcome(context.paths, identity, {
        status: result.status,
        attempts,
        nextRetryAt: nextRetryAt(result.status, attempts, now()),
        result: compactOutcomeResult(result),
      });
    }
    let published;
    try {
      // A deferral recorded AFTER the attestation must still reach the PR
      // comment: the stored result predates it, so it is applied at publish
      // time (gate self-review, 1.8.0). A lookup failure publishes NOTHING —
      // a comment that omits a recorded decision is worse than a late one.
      const publishedResult = await applyDeferrals(context.paths, result);
      published = await publish(
        context.repoRoot,
        repoSlug,
        pr.number,
        publishedResult,
        { publisherLogin },
      );
    } catch (error) {
      if (await pauseForUnverifiedProcessTree(context, error, pause)) throw error;
      const message = error?.message || String(error);
      publishErrors.push(`PR #${pr.number}: ${message}`);
      outcomes.push({ pr: pr.number, status: result.status, published: false, publishError: message });
      await recordEvent(context.paths, {
        type: 'github-publish-error',
        pr: pr.number,
        headSha: pr.headRefOid,
        message,
      });
      continue;
    }
    outcomes.push({ pr: pr.number, status: result.status, published: published.changed });
    if (published.changed) {
      await recordEvent(context.paths, {
        type: 'github-sync',
        pr: pr.number,
        headSha: pr.headRefOid,
        status: result.status,
        published: true,
      });
    }
  }
  if (publishErrors.length) {
    throw new Error(`GitHub review synchronization completed its PR reviews but could not publish ${publishErrors.length} comment(s): ${publishErrors.join(' | ')}`);
  }
  return outcomes;
}
