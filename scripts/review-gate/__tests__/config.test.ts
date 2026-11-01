import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('works without any project document and makes project integrations opt-in', async () => {
    const policy = await readReviewPolicy(await temp());
    expect(policy.charter).toContain('Rove Sentinel review charter');
    expect(policy.config).toMatchObject({ clippy: false, guiEvidence: 'none', trustedAuthors: [] });
    expect(await guiEvidenceRefusal({ config: policy.config, identity: { baseSha: 'a', headSha: 'b' }, listChanged: () => { throw Error('must not read evidence'); } })).toBeNull();
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

  it('keeps the earlier guiEvidence spelling as written, so an installed policy keeps its digest', async () => {
    const input = { charter: '# Rules', lessons: '# Lessons', config: { guiEvidence: 'rove' } };
    const installed = reviewPolicySnapshot(input);
    expect(installed.config.guiEvidence).toBe('rove');
    expect(reviewPolicySnapshot(installed)).toEqual(installed);
    expect(reviewPolicySnapshot({ ...input, config: { guiEvidence: 'required' } }).policyDigest).not.toBe(installed.policyDigest);
  });

  it.each([['required', 1], ['rove', 1], ['none', 0]])('with guiEvidence %s reads the changed files %i time(s)', async (guiEvidence, reads) => {
    const listChanged = vi.fn(async () => []);
    const config = normalizeConfig({ guiEvidence });
    await expect(guiEvidenceRefusal({ config, identity: { baseSha: 'a', headSha: 'b' }, listChanged })).resolves.toBeNull();
    expect(listChanged).toHaveBeenCalledTimes(reads as number);
  });

  it('takes Clippy crates as folders of the repository, sorted, and leaves them out when not listed', () => {
    expect(normalizeConfig({ clippyCrates: ['crates/b', '.', 'crates/a', 'crates/a'] }).clippyCrates).toEqual(['.', 'crates/a', 'crates/b']);
    expect(normalizeConfig({})).not.toHaveProperty('clippyCrates');
    for (const clippyCrates of [[], 'crates/a', [1], ['../outside'], ['/absolute'], ['crates/a/'], Array(65).fill('a')]) {
      expect(() => normalizeConfig({ clippyCrates })).toThrow(/clippyCrates/);
    }
  });

  it('takes project paths as files or folders of the repository, sorted', () => {
    expect(normalizeConfig({ highRiskPaths: ['b/', 'a/file.md', 'b'] }).highRiskPaths).toEqual(['a/file.md', 'b']);
    expect(normalizeConfig({ scriptPaths: ['tools'] }).scriptPaths).toEqual(['tools']);
    const none = normalizeConfig({});
    for (const key of ['highRiskPaths', 'scriptPaths', 'guiEvidenceLayout']) expect(none).not.toHaveProperty(key);
    for (const key of ['highRiskPaths', 'scriptPaths']) {
      for (const value of [[], 'a', [1], ['../outside'], ['/absolute'], ['.'], Array(65).fill('a')]) {
        expect(() => normalizeConfig({ [key]: value })).toThrow(new RegExp(key));
      }
    }
  });

  it('takes a GUI evidence layout, and refuses what is not one', () => {
    const layout = { guiFiles: ['^ui/'], testFiles: '^ui/fixtures/', reviewsFolder: 'qa/shots', controlRegistry: 'qa/controls.md', controlSources: '\\.vue$', sharedPrimitives: '^ui/shared/', captureCommand: 'make shots' };
    expect(normalizeConfig({ guiEvidenceLayout: layout }).guiEvidenceLayout).toEqual(layout);
    for (const guiEvidenceLayout of [[], 'x', { typo: 1 }, { guiFiles: [] }, { guiFiles: ['('] }, { guiFiles: [1] }, { testFiles: '(' }, { reviewsFolder: '../x' }, { controlRegistry: '/x' }, { controlSources: '(' }, { sharedPrimitives: 'a'.repeat(201) }, { captureCommand: '' }]) {
      expect(() => normalizeConfig({ guiEvidenceLayout })).toThrow(/guiEvidenceLayout/);
    }
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

describe('maxShards (1.14.0)', () => {
  it('accepts 8 to 128 and stays omitted when unset', () => {
    expect(normalizeConfig({ maxShards: 24 }).maxShards).toBe(24);
    expect(normalizeConfig({})).not.toHaveProperty('maxShards');
    expect(() => normalizeConfig({ maxShards: 4 })).toThrow(/8 to 128/);
    expect(() => normalizeConfig({ maxShards: 200 })).toThrow(/8 to 128/);
    expect(() => normalizeConfig({ maxShards: 9.5 })).toThrow(/8 to 128/);
  });
});
