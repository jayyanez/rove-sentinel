import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CHARTER_VERSION, GATE_VERSION } from '../constants.mjs';
import { coordinatorPrompt, hypothesisPrompt, reviewerPrompt, scoutPrompt, shardPrompt } from '../providers.mjs';

describe('standalone package contract', () => {
  it('ships a matching executable, package, and neutral charter', async () => {
    const charter = await readFile('templates/charter.md', 'utf8');
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    expect(pkg.version).toBe(GATE_VERSION);
    expect(charter).toContain(`**Charter version:** ${CHARTER_VERSION}`);
    expect(charter).toContain(`**Gate version:** ${GATE_VERSION}`);
    expect(pkg.bin['rove-sentinel']).toBe('scripts/review-gate/cli.mjs');
    expect(pkg.exports['./cli']).toBe('./scripts/review-gate/cli.mjs');
  });

  it('keeps incomplete claimed fixes in every reviewer scope', async () => {
    const charter = await readFile('templates/charter.md', 'utf8');
    expect(charter).toMatch(/Pre-existing\s+is NOT a valid ground/);
    const generated = [
      reviewerPrompt({ provider: 'claude', roleIndex: 0, contextPath: 'ctx.md' }),
      ...['code', 'scripts', 'config', 'tests', 'docs'].map((kind) => shardPrompt({
        provider: 'claude', contextPath: 'ctx.md', shardPath: 'shard.diff',
        shard: { index: 0, kind, files: ['f'], changedLines: 1, patch: '' },
      })),
      scoutPrompt({ provider: 'claude', contextPath: 'ctx.md', maxHypotheses: 3 }),
      hypothesisPrompt({ provider: 'claude', contextPath: 'ctx.md', hypothesis: {
        title: 't', file: 'f', line: 1, lens: 'l', claim: 'c', why: 'w',
      } }),
      coordinatorPrompt({ provider: 'codex', contextPath: 'ctx.md', candidatesPath: 'c.json' }),
    ];
    for (const prompt of generated) {
      expect(prompt).toMatch(/incomplete (claimed )?fix/);
      expect(prompt).not.toContain('PR description');
      expect(prompt).not.toMatch(/Action Catalog|nearCoord|Tauri ACL|mesh-edition/);
    }
    expect(generated.at(-1)).toContain('never dismiss as pre-existing');
    expect(charter).toContain('PR descriptions do not reach the review pipeline');
  });
});
