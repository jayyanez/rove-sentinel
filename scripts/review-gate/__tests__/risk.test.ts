import { describe, expect, it } from 'vitest';

import { classifyRisk, isOrdinaryDocumentationSkip, reviewPlan } from '../risk.mjs';
import { LIMITS } from '../constants.mjs';

describe('shared review risk routing', () => {
  it('treats ordinary prose as a hook skip and policy Markdown as a review', () => {
    expect(isOrdinaryDocumentationSkip(['docs/design/example.md'])).toBe(true);
    expect(isOrdinaryDocumentationSkip([])).toBe(false);
    expect(isOrdinaryDocumentationSkip(['docs/shared-review-charter.md'])).toBe(false);
    expect(isOrdinaryDocumentationSkip(['docs/note.md', 'src/lib/example.ts'])).toBe(false);
  });

  it('skips documentation-only changes', () => {
    for (const file of ['docs/example.md', 'docs/example.markdown', 'docs/example.adoc']) {
      expect(classifyRisk({ files: [file], changedLines: 40 })).toEqual({
        level: 'skip',
        reasons: ['documentation-only diff'],
      });
    }
  });

  it('reviews Markdown that controls the gate or either agent adapter as high risk', () => {
    for (const file of [
      'docs/shared-review-charter.md',
      'docs/bugs/lessons.md',
      'docs/engineering-process.md',
      'docs/review-gate-recall-ledger.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.agents/skills/rove-review/SKILL.md',
      '.claude/skills/rove-review/SKILL.md',
      '.grok/skills/rove-review/SKILL.md',
      'src/AGENTS.md',
      'packages/CLAUDE.md',
    ]) {
      expect(classifyRisk({ files: [file], changedLines: 4 })).toMatchObject({ level: 'high' });
    }
  });

  it('does not let a risky word in an ordinary bug-brief path defeat the docs skip', () => {
    for (const file of [
      'docs/bugs/fixed/webview-cors-dev-toggle.md',
      'README-security.md',
    ]) {
      expect(classifyRisk({ files: [file], changedLines: 12 })).toEqual({
        level: 'skip',
        reasons: ['documentation-only diff'],
      });
    }
  });

  it('routes native and config changes as high risk', () => {
    const result = classifyRisk({
      files: ['src-tauri/src/lib.rs'],
      patch: '+const timer = setInterval(cleanup, 1000);',
      changedLines: 12,
    });
    expect(result.level).toBe('high');
    expect(result.reasons.some((reason) => reason.includes('src-tauri'))).toBe(true);
    expect(classifyRisk({
      files: ['vite.config.ts'], patch: '+export default {};', changedLines: 1,
    })).toMatchObject({ level: 'high' });
  });

  it('does not treat ordinary store or persist wording as high risk', () => {
    expect(classifyRisk({
      files: [
        'src/lib/stores/exampleStore.svelte.ts',
        'src/lib/stores/otherStore.svelte.ts',
        'src/lib/example.ts',
      ],
      patch: '+export function persist() { cleanup(); }',
      changedLines: 90,
    })).toMatchObject({ level: 'medium' });
  });

  it('still treats credential and sandbox tokens as high risk', () => {
    expect(classifyRisk({
      files: ['src/lib/example.ts'],
      patch: '+const credential = readSecret();',
      changedLines: 4,
    })).toMatchObject({ level: 'high' });
  });

  it('keeps a bounded test-only change low risk', () => {
    expect(
      classifyRisk({ files: ['src/lib/example/__tests__/small.test.ts'], changedLines: 25 }),
    ).toMatchObject({ level: 'low' });
  });

  it('does not call a visual-baseline-only commit an empty change', () => {
    expect(classifyRisk({
      files: ['tests/visual/chrome.spec.ts-snapshots/app-win32.png'],
      patch: '',
      changedLines: 0,
    })).toMatchObject({ level: 'low' });
  });

  it('ignores risky words that appear only in unchanged diff context', () => {
    expect(classifyRisk({
      files: ['src/lib/example.ts'],
      patch: [
        'diff --git a/src/lib/example.ts b/src/lib/example.ts',
        ' context uses writeFile and setTimeout',
        '-export const answer = 41;',
        '+export const answer = 42;',
      ].join('\n'),
      changedLines: 2,
    })).toMatchObject({ level: 'low' });
  });

  it('never allows an operator override to mint a skipped review', () => {
    expect(() => classifyRisk({ files: ['src/example.ts'], override: 'skip' })).toThrow(
      'Unknown risk override: skip',
    );
    expect(classifyRisk({ files: ['src/example.ts'], override: 'high' })).toMatchObject({
      level: 'high',
    });
    expect(classifyRisk({
      files: ['scripts/review-gate/gate.mjs'], changedLines: 5, override: 'low',
    })).toMatchObject({ level: 'high' });
  });

  it('inverts the lead model against the author family', () => {
    expect(reviewPlan('high', 'codex')).toEqual({
      reviewers: ['claude', 'codex', 'claude'],
      coordinator: 'claude',
      useScout: true,
      followUp: false,
      maxHypotheses: 8,
      maxShards: LIMITS.shardMaxCountHigh,
    });
    expect(reviewPlan('medium', 'claude')).toEqual({
      reviewers: ['codex', 'claude'],
      coordinator: 'codex',
      useScout: true,
      followUp: false,
      maxHypotheses: 4,
      maxShards: LIMITS.shardMaxCountMedium,
    });
    expect(reviewPlan('low', 'grok')).toEqual({
      reviewers: ['claude'],
      coordinator: 'claude',
      useScout: false,
      followUp: false,
      maxHypotheses: 0,
      maxShards: 2,
    });
    expect(reviewPlan('medium', 'grok')).toEqual({
      reviewers: ['claude', 'claude'],
      coordinator: 'claude',
      useScout: true,
      followUp: false,
      maxHypotheses: 4,
      maxShards: LIMITS.shardMaxCountMedium,
    });
    expect(reviewPlan('high', 'grok')).toEqual({
      reviewers: ['claude', 'claude', 'claude'],
      coordinator: 'claude',
      useScout: true,
      followUp: false,
      maxHypotheses: 8,
      maxShards: LIMITS.shardMaxCountHigh,
    });
    expect(reviewPlan('skip', 'grok')).toEqual({
      reviewers: [],
      coordinator: null,
      useScout: false,
      followUp: false,
      maxHypotheses: 0,
      maxShards: 0,
    });
    expect(reviewPlan('high', 'codex', { followUp: true })).toEqual({
      reviewers: ['claude'],
      coordinator: 'claude',
      useScout: false,
      followUp: true,
      maxHypotheses: 0,
      maxShards: LIMITS.shardMaxCountMedium,
    });
    expect(() => reviewPlan('skip', 'cluade')).toThrow('Unknown author family');
  });

  // Sharded coverage exists so recall is never capped at what the scout
  // imagined or at what a 12-read budget can reach in a 300 KB diff: every
  // scouted plan carries a bounded shard wave led by the cross-model
  // reviewer, and a follow-up round keeps a smaller cross-model wave.
  it('keeps the shard wave cross-model-led on every plan', () => {
    expect(reviewPlan('high', 'claude').reviewers[0]).toBe('codex');
    expect(reviewPlan('medium', 'codex').reviewers[0]).toBe('claude');
    expect(reviewPlan('low', 'claude').maxShards).toBe(2);
    expect(reviewPlan('medium', 'claude', { followUp: true })).toMatchObject({ reviewers: ['codex'], maxShards: LIMITS.shardMaxCountMedium });
  });
});
