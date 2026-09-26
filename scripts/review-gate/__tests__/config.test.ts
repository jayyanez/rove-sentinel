import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeConfig } from '../config.mjs';
import { readReviewPolicy, reviewPolicySnapshot } from '../context.mjs';
import { classifyRisk, isOrdinaryDocumentationSkip } from '../risk.mjs';
import { initializeRepository, uninstallGeneratedHook } from '../init.mjs';
import { guiEvidenceRefusal } from '../prepush.mjs';
import { runDeterministicLanes } from '../lint.mjs';
import { listReadyPullRequests } from '../github.mjs';
import { assertDefaultHookAbsent } from '../install.mjs';

const roots: string[] = [];
async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-config-'));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('standalone policy and onboarding', () => {
  it('refuses to shadow an existing default Git hook', async () => {
    const root = await temp();
    execFileSync('git', ['init', '-q'], { cwd: root });
    await expect(assertDefaultHookAbsent(root)).resolves.toBeUndefined();
    await writeFile(path.join(root, '.git/hooks/pre-push'), '# existing');
    await expect(assertDefaultHookAbsent(root)).rejects.toThrow(/would be shadowed/);
  });
  it('works without Rove documents and makes project integrations opt-in', async () => {
    const policy = await readReviewPolicy(await temp());
    expect(policy.charter).toContain('Rove Sentinel review charter');
    expect(policy.config).toMatchObject({ clippy: false, guiEvidence: 'none', trustedAuthors: [] });
    expect(await guiEvidenceRefusal({ config: policy.config, identity: { baseSha: 'a', headSha: 'b' }, listChanged: () => { throw Error('must not read Rove evidence'); } })).toBeNull();
    const lanes = await runDeterministicLanes({ files: ['src-tauri/src/lib.rs'], config: policy.config, run: () => { throw Error('must not build untrusted code'); } });
    expect(lanes.lanes.find((lane) => lane.lane === 'clippy').status).toBe('skipped');
  });

  it('includes configuration in exact policy identity and refuses tampering', () => {
    const input = { charter: '# Rules', lessons: '# Lessons' };
    const initial = reviewPolicySnapshot(input);
    const enabled = reviewPolicySnapshot({ ...input, config: { clippy: true } });
    expect(initial.policyDigest).not.toBe(enabled.policyDigest);
    expect(() => reviewPolicySnapshot({ ...initial, config: { guiEvidence: 'rove' } })).toThrow(/digest/);
    expect(reviewPolicySnapshot(initial)).toEqual(initial);
  });

  it('does not skip configured policy paths even when all files are prose', () => {
    const config = normalizeConfig({ charter: 'team/rules.md', lessons: 'team/lessons.txt' });
    expect(classifyRisk({ files: ['team/rules.md'], config }).level).toBe('high');
    expect(isOrdinaryDocumentationSkip(['team/lessons.txt'], config)).toBe(false);
    expect(isOrdinaryDocumentationSkip(['docs/tutorial.md'], config)).toBe(true);
  });

  it('rejects unknown options, invalid types and paths outside the project', () => {
    for (const config of [{ clippy: 'false' }, { guiEvidence: true }, { typo: true }, { trustedAuthors: ['*'] }, { charter: '../private.md' }, { lessons: 'C:/secret.md' }, { charter: '/secret.md' }]) {
      expect(() => normalizeConfig(config)).toThrow();
    }
  });

  it('creates repeatable onboarding files and preserves existing hooks', async () => {
    const root = await temp();
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect((await initializeRepository(root)).created).toHaveLength(3);
    expect((await initializeRepository(root)).created).toEqual([]);
    await writeFile(path.join(root, '.githooks/pre-push'), '# existing hook');
    await expect(initializeRepository(root)).rejects.toThrow(/preserved/);
    expect(await readFile(path.join(root, '.githooks/pre-push'), 'utf8')).toBe('# existing hook');
    expect(await uninstallGeneratedHook(root)).toBe('manual');
    expect(await readFile(path.join(root, '.githooks/pre-push'), 'utf8')).toBe('# existing hook');
  });

  it('removes only its generated hook while preserving unrelated hook configuration', async () => {
    const root = await temp();
    execFileSync('git', ['init', '-q'], { cwd: root });
    await initializeRepository(root);
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    await writeFile(path.join(root, '.githooks/pre-commit'), '# another check');
    expect(await uninstallGeneratedHook(root)).toBe('removed-generated-hook');
    expect(await readFile(path.join(root, '.githooks/pre-commit'), 'utf8')).toBe('# another check');
    expect(execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim()).toBe('.githooks');
    expect(await uninstallGeneratedHook(root)).toBe('absent');
  });

  it('loads explicit project rules and fails when they are missing', async () => {
    const root = await temp();
    await writeFile(path.join(root, '.rove-sentinel.json'), JSON.stringify({ charter: 'team/rules.md' }));
    await expect(readReviewPolicy(root)).rejects.toThrow(/Could not load/);
    await mkdir(path.join(root, 'team'));
    await writeFile(path.join(root, 'team/rules.md'), 'Project-specific rule');
    expect((await readReviewPolicy(root)).charter).toBe('Project-specific rule');
  });

  it('does not enqueue forks, strangers, drafts or unknown provenance', async () => {
    const prs = [
      { number: 1, isDraft: false, isCrossRepository: false, author: { login: 'owner' } },
      { number: 2, isDraft: false, isCrossRepository: true, author: { login: 'owner' } },
      { number: 3, isDraft: false, isCrossRepository: false, author: { login: 'stranger' } },
      { number: 4, isDraft: true, isCrossRepository: false, author: { login: 'owner' } },
      { number: 5, isDraft: false, author: { login: 'owner' } },
    ];
    const run = async () => ({ stdout: JSON.stringify(prs) });
    expect((await listReadyPullRequests('unused', { repoSlug: 'owner/project', run })).map((pr) => pr.number)).toEqual([1]);
    expect((await listReadyPullRequests('unused', { repoSlug: 'owner/project', run, trustedAuthors: ['stranger'] })).map((pr) => pr.number)).toEqual([3]);
  });
});
