import { LIMITS } from './constants.mjs';

const DOC_ONLY = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;

const HIGH_RISK_PATHS = [
  /^src-tauri\//,
  /^sidecar\//,
  /^\.githooks\//,
  /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/,
  /^\.(?:agents|claude|grok)\/skills\/rove-review\//,
  /^docs\/(?:shared-review-charter\.md|engineering-process\.md|review-gate-recall-ledger\.md|bugs\/lessons\.md)$/,
  /^scripts\/review-gate\//,
  /^\.rove-sentinel\.json$/,
  /^templates\//,
  /^(?!.*\.(?:md|mdx|markdown|rst|txt|adoc)$).*(?:permissions|capabilities)/i,
  /(?:package|pnpm-lock|vite\.config|svelte\.config|tauri\.conf)\.(?:json|yaml|yml|js|ts)$/i,
];

const HIGH_RISK_TOKENS = [
  /\b(?:credential|secret|certificate|sandbox|bypass|spawn_blocking)\b/i,
  /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|keyring)\b/,
];

const RISK_RANK = { skip: 0, low: 1, medium: 2, high: 3 };

export function changedPatchText(patch) {
  return String(patch || '')
    .split(/\r?\n/)
    .filter((line) => (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ))
    .join('\n');
}

function classifyAutomaticRisk({ files, patch, changedLines, config = {} }) {
  if (files.length === 0) return { level: 'skip', reasons: ['no changed files'] };
  const reasons = [];
  const riskyPaths = files.filter((file) => [config.charter, config.lessons].includes(file) || HIGH_RISK_PATHS.some((pattern) => pattern.test(file)));
  if (riskyPaths.length) reasons.push(`high-risk paths: ${riskyPaths.slice(0, 5).join(', ')}`);
  if (!riskyPaths.length && files.every((file) => DOC_ONLY.test(file))) {
    return { level: 'skip', reasons: ['documentation-only diff'] };
  }
  if (HIGH_RISK_TOKENS.some((pattern) => pattern.test(changedPatchText(patch)))) {
    reasons.push('credential, sandbox, or host-secret boundary changed');
  }
  if (files.length > 20 || changedLines > 1000) {
    reasons.push(`large change surface: ${files.length} files / ${changedLines} lines`);
  }
  if (reasons.length) return { level: 'high', reasons };

  if (files.every((file) => TEST_FILE.test(file)) && changedLines <= 250) {
    return { level: 'low', reasons: ['bounded test-only change'] };
  }
  if (files.length <= 2 && changedLines <= 80) {
    return { level: 'low', reasons: ['small non-trivial change'] };
  }
  return {
    level: 'medium',
    reasons: [`ordinary change surface: ${files.length} files / ${changedLines} lines`],
  };
}

export function isOrdinaryDocumentationSkip(files, config) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return false;
  return classifyAutomaticRisk({ files: list, patch: '', changedLines: 0, config }).level === 'skip'
    && list.every((file) => DOC_ONLY.test(file));
}

export function classifyRisk({ files, patch = '', changedLines = 0, override, config }) {
  if (override && !['low', 'medium', 'high'].includes(override)) {
    throw new Error(`Unknown risk override: ${override}`);
  }
  const automatic = classifyAutomaticRisk({ files, patch, changedLines, config });
  if (!override) return automatic;
  if (RISK_RANK[override] > RISK_RANK[automatic.level]) {
    return {
      level: override,
      reasons: [...automatic.reasons, `explicit minimum risk: ${override}`],
    };
  }
  return {
    ...automatic,
    reasons: [...automatic.reasons, `explicit risk floor ${override} did not reduce ${automatic.level}`],
  };
}

function decoratePlan(plan, risk, { followUp = false } = {}) {
  if (risk === 'skip') {
    return {
      ...plan, useScout: false, followUp: false, maxHypotheses: 0, maxShards: 0,
    };
  }
  // A follow-up round (v1.8.0) reviews the incremental diff since the closest
  // reviewed head with one cross-model shard wave — bounded, focused, and
  // re-verifying that head's blocking findings — instead of a fresh full
  // review of the whole branch. P2 candidates it finds are still adjudicated.
  if (followUp) {
    return {
      reviewers: [plan.reviewers[0]],
      coordinator: plan.coordinator,
      useScout: false,
      followUp: true,
      maxHypotheses: 0,
      maxShards: LIMITS.shardMaxCountMedium,
    };
  }
  // Sharded coverage (v1.8.0) replaces the whole-diff coverage lane: every
  // changed hunk is read in full by exactly one shard reviewer, and the shard
  // wave starts alongside the scout instead of after it. Low-risk work keeps
  // one reviewer and no scout, but still reads the diff as shards.
  const useScout = risk === 'medium' || risk === 'high';
  return {
    ...plan,
    useScout,
    followUp: false,
    maxHypotheses: risk === 'high' ? 8 : risk === 'medium' ? 4 : 0,
    maxShards: risk === 'high'
      ? LIMITS.shardMaxCountHigh
      : risk === 'medium'
        ? LIMITS.shardMaxCountMedium
        : 2,
  };
}

function sameFamilyPlan(provider, risk) {
  const count = risk === 'low' ? 1 : risk === 'medium' ? 2 : 3;
  return {
    reviewers: Array.from({ length: count }, () => provider),
    coordinator: provider,
  };
}

export function reviewPlan(risk, author, options = {}) {
  if (!['claude', 'codex', 'grok', 'human'].includes(author)) {
    throw new Error(`Unknown author family: ${author}. Expected claude, codex, grok, or human.`);
  }
  if (risk === 'skip') return decoratePlan({ reviewers: [], coordinator: null }, risk, options);
  if (options.providers) {
    if (!Array.isArray(options.providers) || !options.providers.length ||
        options.providers.some((provider) => !['claude', 'codex'].includes(provider))) throw new Error('Invalid review provider set.');
    if (new Set(options.providers).size === 1) {
      return decoratePlan(sameFamilyPlan(options.providers[0], risk), risk, options);
    }
  }
  // Grok is an implementer, not a review provider. Spend only the Claude
  // subscription: same lens counts as other agent work, no Codex calls.
  if (author === 'grok') return decoratePlan(sameFamilyPlan('claude', risk), risk, options);
  const crossModel = author === 'claude' ? 'codex' : 'claude';
  const authorModel = author === 'claude' ? 'claude' : 'codex';
  if (author === 'human') {
    if (risk === 'low') return decoratePlan({ reviewers: ['claude'], coordinator: 'codex' }, risk, options);
    if (risk === 'medium') return decoratePlan({ reviewers: ['claude', 'codex'], coordinator: 'codex' }, risk, options);
    return decoratePlan({ reviewers: ['claude', 'codex', 'claude'], coordinator: 'codex' }, risk, options);
  }
  if (risk === 'low') return decoratePlan({ reviewers: [crossModel], coordinator: crossModel }, risk, options);
  if (risk === 'medium') {
    return decoratePlan({ reviewers: [crossModel, authorModel], coordinator: crossModel }, risk, options);
  }
  return decoratePlan({
    reviewers: [crossModel, authorModel, crossModel],
    coordinator: crossModel,
  }, risk, options);
}
