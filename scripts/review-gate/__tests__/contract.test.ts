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
    expect(pkg.bin['rove-sentinel']).toBe('scripts/review-gate/launcher.mjs');
    expect(pkg.exports['./cli']).toBe('./scripts/review-gate/launcher.mjs');
    expect(pkg.sentinelEngineProtocol).toBe(1);
  });

  it('documents the limits of this version, and the engine reports them (1.13.0)', async () => {
    // Every release reviews the limits page: its version line must match.
    const guide = await readFile('docs/limits.md', 'utf8');
    expect(guide).toContain(`**Engine version:** ${GATE_VERSION}`);
    expect(guide).toContain(`## Limits of ${GATE_VERSION}`);
    const { formatLimits, sentinelLimits } = await import('../limits.mjs');
    const limits = sentinelLimits();
    expect(limits.version).toBe(GATE_VERSION);
    // The guide lists exactly the workarounds the engine calls unnecessary.
    const rows = guide.match(/^\| .+ \| \d+\.\d+\.\d+ \| .+ \|$/gm) || [];
    expect(rows.length).toBe(limits.superseded.length);
    for (const entry of limits.superseded) {
      expect(rows.some((row) => row.includes(`| ${entry.unnecessarySince} |`))).toBe(true);
    }
    const text = formatLimits(limits);
    expect(text).toContain(`Rove Sentinel ${GATE_VERSION}`);
    expect(text).toContain('4 MiB');
    expect(text).toContain('No limit on a changed file');
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
