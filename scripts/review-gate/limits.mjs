import { GATE_VERSION, LIMITS } from './constants.mjs';

// What this engine version accepts and where it stops (1.13.0), from the
// limits it enforces, so an agent in a consuming project can ask the
// installed engine (`rove-sentinel limits`) instead of carrying a rule it
// learned from an earlier version. Every release reviews this file: the
// `superseded` list names the workarounds earlier versions needed and this
// one does not, with the version that made each unnecessary.

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const mib = (bytes) => `${bytes / (1024 * 1024)} MiB`;
const minutes = (ms) => `${Math.round(ms / 60_000)} min`;

export function sentinelLimits() {
  return {
    version: GATE_VERSION,
    review: [
      {
        id: 'patch-size',
        limit: mib(LIMITS.maxPatchBytes),
        text: `Git's diff of the change under review, with ${LIMITS.patchContextLines} context lines a side, is at most ${mib(LIMITS.maxPatchBytes)} (reviewers then get at most ${kb(LIMITS.patchContextSideBytes)} of context a side). A larger change fails closed: split it into several pushes.`,
      },
      {
        id: 'file-size',
        limit: 'none',
        text: `No limit on a changed file's size or a line's length. A shard larger than one read is written in parts of at most ${kb(LIMITS.shardPartMaxBytes)} and a longer line is cut across parts; a shard of up to ${kb(LIMITS.inlineShardMaxBytes)} travels in the reviewer's prompt and is not read at all.`,
      },
      {
        id: 'prompt-material',
        limit: kb(LIMITS.inlineRequiredMaxBytes),
        text: `The context, charter, selected lessons and open briefs travel in every prompt when together they fit ${kb(LIMITS.inlineRequiredMaxBytes)}; otherwise reviewers read them from files in parts. A larger charter or lessons file costs reads, not correctness.`,
      },
      {
        id: 'shards',
        limit: `${LIMITS.shardMaxCountHigh}/${LIMITS.shardMaxCountMedium}/2`,
        text: `A change is reviewed in shards of about ${LIMITS.shardTargetLines} changed lines, at most ${LIMITS.shardMaxCountHigh} in a high-risk round, ${LIMITS.shardMaxCountMedium} in a medium one and 2 in a low one; a larger change gets larger shards. A shard's reviewer has ${minutes(LIMITS.shardTimeoutMs)}, a minute more per further ${kb(LIMITS.shardTimeoutStepBytes)}, at most ${minutes(LIMITS.shardTimeoutMaxMs)}.`,
      },
      {
        id: 'candidates',
        limit: String(LIMITS.maxCandidates),
        text: `At most ${LIMITS.maxCandidates} distinct candidates per round reach adjudication (${LIMITS.shardMaxCandidates} per shard, ${LIMITS.maxHypothesisCandidates} per hypothesis); more fails the round closed. Candidates under confidence ${LIMITS.candidateConfidenceFloor} are not adjudicated; the report keeps up to ${LIMITS.maxReportedLowConfidence} of them.`,
      },
      {
        id: 'skip',
        limit: '.md .markdown .rst .adoc',
        text: 'A change of only Markdown, reStructuredText or AsciiDoc files outside the review policy is skipped without a model call. Plain .txt and .mdx files are reviewed.',
      },
    ],
    workflow: [
      {
        id: 'push',
        limit: `${LIMITS.maxPushCandidateRefs} refs, 1 unreviewed`,
        text: `One push may carry at most ${LIMITS.maxPushCandidateRefs} refs to check and at most one that still needs a review; the hook waits at most ${minutes(LIMITS.hookWaitTimeoutMs)} for it.`,
      },
      {
        id: 'repair-rounds',
        limit: String(LIMITS.lineageRepairRoundBudget),
        text: `After ${LIMITS.lineageRepairRoundBudget} reviewed heads on one base, a blocking P2 a repair introduced may be deferred with a published reason; ${LIMITS.lateDiscoveryBlockingQuota} late discoveries may block before later ones become advisories. P0 and P1 always block.`,
      },
      {
        id: 'rerun',
        limit: `${Math.round(LIMITS.shardCheckpointMaxAgeMs / 3_600_000)} hours`,
        text: `A round that failed closed keeps its completed shard reviews for ${Math.round(LIMITS.shardCheckpointMaxAgeMs / 3_600_000)} hours for the exact head; a rerun reviews only the rest.`,
      },
    ],
    superseded: [
      {
        rule: 'Split a changed source file over about 40 KB before a review',
        unnecessarySince: '1.13.0',
        why: 'A follow-up reviewer had to read each prior blocker\'s whole file, and a file over one tool output (~38 KB) failed the round closed. It now reads the code around the reported location, by line range.',
      },
      {
        rule: 'Keep changed lines under about 2 KB (table rows, minified text)',
        unnecessarySince: '1.12.0',
        why: 'Context is bounded by bytes, and a line longer than a part is cut across parts.',
      },
      {
        rule: 'Keep a follow-up delta small so the adjudicator can read it whole',
        unnecessarySince: '1.13.0',
        why: 'The patch is a lookup, not a required read, and an adjudicator is told it is assigned candidates, not a diff.',
      },
      {
        rule: 'Avoid shards of about 70 KB (Codex never saw them whole)',
        unnecessarySince: '1.11.1',
        why: 'Shards are written in parts that each fit one read; since 1.13.0 a shard of up to 96 KB is in the prompt.',
      },
    ],
  };
}

export function formatLimits(limits = sentinelLimits()) {
  const section = (title, entries) => [
    title,
    ...entries.map((entry) => `  - ${entry.text}`),
  ];
  return [
    `Rove Sentinel ${limits.version}: what this installed engine accepts and where it stops.`,
    'These come from the engine itself. A rule an agent learned under an earlier version does not apply unless it is listed here.',
    '',
    ...section('Review', limits.review),
    '',
    ...section('Workflow', limits.workflow),
    '',
    'No longer needed (workarounds for earlier versions):',
    ...limits.superseded.map((entry) => `  - ${entry.rule}: unnecessary since ${entry.unnecessarySince}. ${entry.why}`),
  ].join('\n');
}
