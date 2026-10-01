export const GATE_VERSION = '1.11.2';
export const CHARTER_VERSION = '1.8.0';
export const COMMENT_MARKER = '<!-- rove-shared-review-gate -->';
export const TASK_PREFIX = 'Rove-Shared-Review-Gate';

export const LIMITS = Object.freeze({
  // Git's pre-push ref lines are ~100 bytes each, so this covers tens of
  // thousands of refs in one push. Past it the hook refuses in a controlled,
  // reported way rather than growing the buffer until Node's heap gives out.
  maxHookInputBytes: 4 * 1024 * 1024,
  maxPatchBytes: 4 * 1024 * 1024,
  maxProcessOutputBytes: 2 * 1024 * 1024,
  // One committed design-review screenshot read back at head to prove it is
  // a PNG; a capture past this is refused as unreadable, never buffered whole.
  maxEvidenceBlobBytes: 32 * 1024 * 1024,
  // Codex high-effort reasoning lands on stderr. Counting it toward the
  // structured-output bound killed coordinators that had already written JSON.
  maxProcessStderrBytes: 256 * 1024,
  maxCandidates: 50,
  maxReviewerCandidates: 12,
  // Hypothesis reviewers stay narrow: one primary claim plus up to three
  // same-class siblings observed in code they already read (v1.6.0).
  maxHypothesisCandidates: 4,
  maxScoutHypotheses: 8,
  reviewerToolCallBudget: 16,
  scoutToolCallBudget: 8,
  // A patch range the scout reads in one call: ~400 diff lines stay well
  // inside the ~38 KB a provider shows whole (1.11.2).
  scoutRangeMaxLines: 400,
  hypothesisToolCallBudget: 6,
  coverageToolCallBudget: 12,
  scoutTimeoutMs: 6 * 60 * 1000,
  hypothesisTimeoutMs: 6 * 60 * 1000,
  reviewerTimeoutMs: 12 * 60 * 1000,
  coverageTimeoutMs: 8 * 60 * 1000,
  coordinatorTimeoutMs: 10 * 60 * 1000,
  // Reviewer subprocesses launched at once. The hypothesis + coverage wave can
  // exceed what local CPU/network and subscription rate limits tolerate as one
  // burst; excess tasks queue and start as slots free (v1.6.0).
  providerConcurrency: 8,
  // Sharded coverage (v1.8.0): the textual patch is partitioned into
  // file-group shards of about this many changed lines, capped per risk
  // class, so every changed hunk is read by exactly one reviewer with its
  // whole shard in one bounded read instead of a 100-300 KB diff blob
  // behind a 12-read budget. A shard reviewer verifies, it does not hunt.
  shardTargetLines: 500,
  shardMaxCountHigh: 8,
  shardMaxCountMedium: 4,
  shardToolCallBudget: 8,
  // A shard is written in parts no larger than this, each read whole in one
  // call. Codex shows at most ~10k tokens of one command's output and elides
  // the middle of a larger one (measured 2026-09-30: a 70 KB read lost ~8k
  // tokens), so a 70 KB shard read "once" was never fully seen by Codex.
  shardPartMaxBytes: 24 * 1024,
  // A shard's time grows with what it must read: the base covers one part,
  // each further step of bytes adds a minute, up to the whole-diff reviewer's
  // bound. A reviewer that reads every part of a ~70 KB shard needs more than
  // the base (Codex timed out at 5 minutes on rove #584 once it read it all).
  shardTimeoutMs: 5 * 60 * 1000,
  shardTimeoutStepBytes: 12 * 1024,
  shardTimeoutMaxMs: 12 * 60 * 1000,
  // How long `taskkill /t /f` may take to end a timed-out provider tree on
  // Windows before the cleanup fence gives up. The old 2-second bound failed
  // on a loaded host (three Codex trees in two rove #584 runs, 2026-09-30),
  // turning a non-fatal scout timeout into a fail-closed gate.
  taskkillTimeoutMs: 30 * 1000,
  // How much of a reviewer's own summary an incomplete-review error keeps.
  incompleteSummaryChars: 400,
  shardMaxCandidates: 8,
  // Adjudication runs in fresh batches of at most this many candidates so the
  // coordinator stage is bounded by one small batch instead of one large one.
  coordinatorBatchSize: 5,
  // Deterministic lanes (v1.8.0): zero-model linters over changed lines. A
  // lane that times out degrades to an explicit note, never a failed review.
  markdownlintTimeoutMs: 2 * 60 * 1000,
  clippyTimeoutMs: 8 * 60 * 1000,
  maxDeterministicFindings: 40,
  // Bounded convergence (v1.8.0): a NEW verified P2 outside a follow-up
  // round's incremental diff is a late discovery — the code was already in
  // front of the previous round's reviewers. This many late discoveries may
  // still block per lineage; later ones are advisories that need a recorded
  // disposition before the head can be pushed.
  lateDiscoveryBlockingQuota: 2,
  // Repair-round budget (v1.8.0 follow-up): once a lineage has this many
  // reviewed ancestor heads, a P2 introduced by the latest repair still
  // blocks but becomes deferrable with a published reason. Two adversarial
  // models can find a corner in every repair of dense policy code; the
  // author's visible decision is what makes the loop terminate.
  lineageRepairRoundBudget: 6,
  // Dispositions share one directory across every lineage of the repository;
  // the bound must leave room for many branches' decisions at once.
  maxDispositions: 4_000,
  // Deterministic reference-map bounds (v1.6.0): symbols swept per review,
  // total reference lines inlined, per-symbol line cap, and the hit count past
  // which a symbol is reported as too common to enumerate.
  refMapMaxSymbols: 40,
  refMapMaxReferenceLines: 240,
  refMapMaxRefsPerSymbol: 12,
  refMapMaxHitsPerSymbol: 200,
  // Co-change sibling mining bounds (v1.6.0).
  coChangeScannedFiles: 20,
  coChangeCommitsPerFile: 30,
  coChangeMaxSiblings: 12,
  // Open bug briefs inlined into the review context (v1.6.0): documented
  // still-open invariants (e.g. non-global ID uniqueness) travel with the
  // review instead of depending on a reviewer read.
  openBriefsMaxIndexed: 40,
  openBriefsMaxInlined: 4,
  openBriefsMaxCharsEach: 6_000,
  providerRetryLimit: 1,
  // One active high-risk review plus one queued review can each consume the
  // full reviewer + coordinator budget. Keep the hook bound above that total.
  hookWaitTimeoutMs: 120 * 60 * 1000,
  hookProgressEveryMs: 30 * 1000,
  queuePollMs: 1000,
  githubPollMs: 60 * 1000,
  githubMaxBackoffMs: 10 * 60 * 1000,
  githubErrorRetryBaseMs: 60 * 1000,
  githubErrorMaxAttempts: 3,
  githubCommentFindings: 20,
  maxOpenPullRequests: 1_000,
  githubSummaryChars: 4_000,
  githubFindingChars: 1_000,
  heartbeatMs: 10 * 1000,
  cleanupRetries: 40,
  cleanupRetryMs: 250,
  maxAttestations: 80,
  maxReports: 50,
  maxEvents: 200,
  maxAuditEvents: 1_000,
  maxOutcomes: 80,
  // Lineage records (one per reviewed head) carry the follow-up base and
  // running counts (reviewed heads, late discoveries); several worktrees
  // share the directory. This bound is storage, not policy: a budget is read
  // from the closest ancestor's record, so pruning older records never
  // resets it.
  maxConvergenceEvents: 800,
  // A push carrying more ORDINARY refs (non-deletion, non-bypass) than this is
  // refused before ANY per-ref planning. Planning each ref resolves its target
  // and merge base (two git processes, each on a bounded timeout), so a burst
  // push of thousands of ordinary refs could spend hours planning refs it will
  // inevitably refuse — the charter reviews ONE unattested ref per push and a
  // legitimate multi-ref push carries attested heads, not thousands of
  // candidates. Deletion batches are exempt (they never plan). The bound is
  // generous: real pushes carry one branch plus occasional release tags.
  maxPushCandidateRefs: 16,
  // The daemon processes one request at a time. One queued request plus the
  // active claim is the largest backlog covered by hookWaitTimeoutMs.
  maxQueuedRequests: 1,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  auditRetentionMs: 365 * 24 * 60 * 60 * 1000,
});

// This profile is code-owned and therefore covered by GATE_VERSION. Do not
// accept ambient model/effort overrides: an exact-SHA PASS must not silently
// change strength according to whichever shell happened to launch the watcher.
export const PROVIDER_PROFILE = Object.freeze(Object.fromEntries(
  ['Scout', 'Hypothesis', 'Reviewer', 'Coordinator', 'Coverage', 'Shard'].flatMap((role) => [
    [`claude${role}`, Object.freeze({
      model: 'claude-opus-5-5', effort: 'high', maxEffort: 'xhigh',
      autocompact: '200k', maxBudgetUsd: role === 'Coordinator' ? 6 : 4,
    })],
    [`codex${role}`, Object.freeze({ model: 'gpt-6.1-sol', effort: 'high', maxEffort: 'xhigh' })],
  ]),
));

export const ZERO_SHA = /^0+$/;

export const SCOUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    review_complete: { type: 'boolean' },
    effort_request: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
    summary: { type: 'string' },
    hypotheses: {
      type: 'array',
      maxItems: LIMITS.maxScoutHypotheses,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['integer', 'null'], minimum: 1 },
          lens: { type: 'string' },
          claim: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['title', 'file', 'line', 'lens', 'claim', 'why'],
      },
    },
  },
  required: ['summary', 'hypotheses', 'effort_request', 'review_complete'],
});

export const REVIEWER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    review_complete: { type: 'boolean' },
    effort_request: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
    summary: { type: 'string' },
    candidates: {
      type: 'array',
      // The schema bound is the global adjudication bound; each role's own
      // tighter bound is enforced mechanically after parsing.
      maxItems: LIMITS.maxCandidates,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          category: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['integer', 'null'], minimum: 1 },
          scenario: { type: 'string' },
          evidence: { type: 'string' },
          proposed_test: { type: 'string' },
        },
        required: [
          'title',
          'priority',
          'confidence',
          'category',
          'file',
          'line',
          'scenario',
          'evidence',
          'proposed_test',
        ],
      },
    },
  },
  required: ['summary', 'candidates', 'effort_request', 'review_complete'],
});

export const COORDINATOR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    review_complete: { type: 'boolean' },
    effort_request: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      maxItems: LIMITS.maxCandidates,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidate_id: { type: 'string' },
          title: { type: 'string' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          file: { type: 'string' },
          line: { type: ['integer', 'null'], minimum: 1 },
          disposition: {
            type: 'string',
            enum: ['verified', 'dismissed', 'needs_native_evidence'],
          },
          reason: { type: 'string' },
          scenario: { type: 'string' },
          proposed_test: { type: 'string' },
        },
        required: [
          'candidate_id',
          'title',
          'priority',
          'file',
          'line',
          'disposition',
          'reason',
          'scenario',
          'proposed_test',
        ],
      },
    },
  },
  required: ['summary', 'findings', 'effort_request', 'review_complete'],
});

export function coordinatorSchemaForCandidates(candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    throw new Error('Coordinator schema requires at least one candidate id.');
  }
  return {
    ...COORDINATOR_SCHEMA,
    properties: {
      ...COORDINATOR_SCHEMA.properties,
      findings: {
        ...COORDINATOR_SCHEMA.properties.findings,
        minItems: candidateIds.length,
        maxItems: candidateIds.length,
        items: {
          ...COORDINATOR_SCHEMA.properties.findings.items,
          properties: {
            ...COORDINATOR_SCHEMA.properties.findings.items.properties,
            candidate_id: { type: 'string', enum: candidateIds },
          },
        },
      },
    },
  };
}
