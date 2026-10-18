import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reviewPolicySnapshot } from '../context.mjs';
import { runGate } from '../gate.mjs';
import { readPatch } from '../git.mjs';
import { partitionShards } from '../shards.mjs';
import { rebaseReuseAllowed, shardCacheKey, shardSurface } from '../shardCache.mjs';

if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function write(root: string, file: string, text: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

/** main with two modules; a branch that changes the cache module. */
async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rove-shard-cache-'));
  temporary.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/cache.git');
  await write(root, 'src/cache.ts', 'export function readEntry(key: string) {\n  return key;\n}\n');
  await write(root, 'src/billing.ts', 'export const rate = 1;\n');
  await write(root, 'src/users.ts', "import { readEntry } from './cache';\nexport const user = readEntry('u');\n");
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'switch', '-c', 'feature/cache');
  await write(root, 'src/cache.ts', 'export function readEntry(key: string) {\n  return key.trim();\n}\nexport function evictEntry(key: string) {\n  return key;\n}\n');
  git(root, 'commit', '-am', 'Trim keys and add eviction');
  return root;
}

/** Move main with one commit touching `file`, and rebase the branch onto it. */
async function moveMainAndRebase(root: string, file: string, text: string) {
  git(root, 'switch', 'main');
  await write(root, file, text);
  git(root, 'add', '.');
  git(root, 'commit', '-m', `main changes ${file}`);
  git(root, 'switch', 'feature/cache');
  git(root, 'rebase', 'main');
  return git(root, 'rev-parse', 'HEAD');
}

describe('reusing a shard review after a rebase (1.13.0)', () => {
  const shard = {
    index: 0, kind: 'code', kinds: ['code'], files: ['src/cache.ts'], changedLines: 1,
    patch: 'diff --git a/src/cache.ts b/src/cache.ts\n--- a/src/cache.ts\n+++ b/src/cache.ts\n@@ -3,0 +4,1 @@\n+export function evictEntry(key: string) {\n',
  };

  it('stores only code, script and test shards of a full assignment', () => {
    const base = { provider: 'codex', policyDigest: 'p', repository: 'r', risk: 'low', branch: 'b', author: 'human' };
    expect(shardCacheKey({ ...base, shard })).toMatch(/^[0-9a-f]{40}$/);
    expect(shardCacheKey({ ...base, shard: { ...shard, kinds: ['code', 'docs'] } })).toBeNull();
    expect(shardCacheKey({ ...base, shard: { ...shard, kind: 'config', kinds: ['config'] } })).toBeNull();
    expect(shardCacheKey({ ...base, shard: { ...shard, reverify: true } })).toBeNull();
    expect(shardCacheKey({ ...base, shard: { ...shard, part: { index: 0, count: 2 } } })).toBeNull();
    // Any input of the assignment changes the key.
    expect(shardCacheKey({ ...base, shard: { ...shard, patch: `${shard.patch} ` } })).not.toBe(shardCacheKey({ ...base, shard }));
    expect(shardCacheKey({ ...base, provider: 'claude', shard })).not.toBe(shardCacheKey({ ...base, shard }));
    expect(shardCacheKey({ ...base, policyDigest: 'q', shard })).not.toBe(shardCacheKey({ ...base, shard }));
  });

  it('names the shard by its file names and the declarations it changes, and refuses short names', () => {
    expect(shardSurface(shard)).toEqual(['cache', 'evictEntry']);
    expect(shardSurface({ ...shard, files: ['src/io.ts'] })).toBeNull();
  });

  it('allows reuse only when no changed file is the shard\'s or mentions its surface', async () => {
    const root = await makeRepository();
    const reviewedHead = git(root, 'rev-parse', 'HEAD');
    const patchAt = async (head: string) => {
      const [only] = partitionShards(await readPatch(root, git(root, 'merge-base', 'main', head), head));
      return only;
    };
    const unrelated = await moveMainAndRebase(root, 'src/billing.ts', 'export const rate = 2;\n');
    const reviewed = await patchAt(reviewedHead);
    expect((await patchAt(unrelated)).patch).toBe(reviewed.patch);
    expect(await rebaseReuseAllowed(root, { shard: reviewed, reviewedHead, headSha: unrelated })).toBe(true);
    // Upstream now calls into the cache module: its review may no longer hold.
    const caller = await moveMainAndRebase(root, 'src/reports.ts', "import { readEntry } from './cache';\nexport const report = readEntry('r');\n");
    expect(await rebaseReuseAllowed(root, { shard: reviewed, reviewedHead, headSha: caller })).toBe(false);
    // From the head that already holds that caller, an unrelated move is fine again.
    const later = await moveMainAndRebase(root, 'src/billing.ts', 'export const rate = 3;\n');
    expect(await rebaseReuseAllowed(root, { shard: reviewed, reviewedHead: caller, headSha: later })).toBe(true);
    // An unknown head is never trusted.
    expect(await rebaseReuseAllowed(root, { shard: reviewed, reviewedHead: 'f'.repeat(40), headSha: later })).toBe(false);
  });

  it('reuses the shard review in the full round after a rebase, and reviews it again when a dependency moved', async () => {
    const root = await makeRepository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-shard-cache-state-'));
    temporary.push(stateRoot);
    const policy = reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n' });
    const shardReviewer = vi.fn(async ({ provider, roleIndex, shard: assigned }) => ({
      provider, roleIndex, summary: 'Reviewed.',
      candidates: [{
        id: `${provider}-${roleIndex}-0`, provider, roleIndex, title: 'Trim drops meaningful whitespace', priority: 'P3', confidence: 70,
        category: 'contract', file: assigned.files[0], line: 2, scenario: 's', evidence: 'e', proposed_test: 't',
      }],
    }));
    const coordinator = vi.fn(async ({ candidates }) => ({
      summary: 'Dismissed.',
      findings: candidates.map((entry: { id: string; title: string; file: string; line: number }) => ({
        candidate_id: entry.id, title: entry.title, priority: 'P3', file: entry.file, line: entry.line,
        disposition: 'dismissed', reason: 'Intended.', scenario: 's', proposed_test: 't',
      })),
    }));
    const gate = (head: string) => runGate({
      repoRoot: root, stateRoot, base: 'main', head, author: 'human', policy, availableProviders: ['codex'],
      shardReviewer, coordinator,
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    });
    const first = await gate(git(root, 'rev-parse', 'HEAD'));
    expect(first.status).toBe('pass');
    expect(shardReviewer).toHaveBeenCalledTimes(1);

    const rebased = await moveMainAndRebase(root, 'src/billing.ts', 'export const rate = 2;\n');
    const second = await gate(rebased);
    expect(second.status).toBe('pass');
    expect(second.round).toBe('full');
    // The shard was not reviewed again; its candidate was adjudicated afresh.
    expect(shardReviewer).toHaveBeenCalledTimes(1);
    expect(coordinator).toHaveBeenCalledTimes(2);
    expect(second.shards).toEqual([expect.objectContaining({ reused: true, reusedFrom: first.identity.headSha })]);
    // The reused review keeps its own age in the cache.
    const entries = await Promise.all((await readdir(path.join(stateRoot, 'shard-cache'))).map(async (name) => JSON.parse(await readFile(path.join(stateRoot, 'shard-cache', name), 'utf8'))));
    expect(entries).toHaveLength(1);
    expect(entries[0].headSha).toBe(rebased);
    expect(entries[0].completedAt).toBe(second.shards[0].reviewedAt);
    expect(Date.parse(entries[0].completedAt)).toBeLessThan(Date.parse(second.createdAt ?? new Date().toISOString()));

    const withCaller = await moveMainAndRebase(root, 'src/reports.ts', "import { readEntry } from './cache';\nexport const report = readEntry('r');\n");
    const third = await gate(withCaller);
    expect(third.status).toBe('pass');
    expect(shardReviewer).toHaveBeenCalledTimes(2);
    expect(third.shards[0].reused).toBeUndefined();
  });
});

describe('shard reuse after the 1.13.0 self-review', () => {
  it('reviews a shard again when a file it imports changed', async () => {
    const root = await makeRepository();
    const reviewedHead = git(root, 'rev-parse', 'HEAD');
    // The branch's cache module imports a parser that main then changes.
    git(root, 'switch', 'main');
    await write(root, 'src/parser.ts', 'export const parse = (text: string) => text;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'add parser');
    git(root, 'switch', 'feature/cache');
    await write(root, 'src/cache.ts', "import { parse } from './parser';\nexport function readEntry(key: string) {\n  return parse(key).trim();\n}\n");
    git(root, 'commit', '-am', 'Parse keys');
    git(root, 'rebase', 'main');
    const before = git(root, 'rev-parse', 'HEAD');
    const [shard] = partitionShards(await readPatch(root, git(root, 'merge-base', 'main', before), before));
    const after = await moveMainAndRebase(root, 'src/parser.ts', 'export const parse = (text: string) => text.toLowerCase();\n');
    expect(await rebaseReuseAllowed(root, { shard, reviewedHead: before, headSha: after })).toBe(false);
    // The same move without the import leaves the shard's review standing.
    void reviewedHead;
    const unrelated = await moveMainAndRebase(root, 'src/billing.ts', 'export const rate = 9;\n');
    expect(await rebaseReuseAllowed(root, { shard, reviewedHead: after, headSha: unrelated })).toBe(true);
  });
});

describe('shard reuse: quoted paths and directory modules (1.13.0 follow-up)', () => {
  it('names a directory module by its directory as well', async () => {
    const { fileNames } = await import('../shardCache.mjs');
    expect(fileNames('src/parser/index.ts')).toEqual(['index', 'parser']);
    expect(fileNames('pkg/parser/__init__.py')).toEqual(['__init__', 'parser']);
    expect(fileNames('src/parser.ts')).toEqual(['parser']);
    expect(fileNames('src/io/index.ts')).toBeNull();
  });

  it('reviews a shard again when the directory module it imports changed', async () => {
    const root = await makeRepository();
    git(root, 'switch', 'main');
    await write(root, 'src/parser/index.ts', 'export const parse = (text: string) => text;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'add parser');
    git(root, 'switch', 'feature/cache');
    await write(root, 'src/cache.ts', "import { parse } from './parser';\nexport function readEntry(key: string) {\n  return parse(key).trim();\n}\n");
    git(root, 'commit', '-am', 'Parse keys');
    git(root, 'rebase', 'main');
    const before = git(root, 'rev-parse', 'HEAD');
    const [shard] = partitionShards(await readPatch(root, git(root, 'merge-base', 'main', before), before));
    const after = await moveMainAndRebase(root, 'src/parser/index.ts', 'export const parse = (text: string) => text.toLowerCase();\n');
    expect(await rebaseReuseAllowed(root, { shard, reviewedHead: before, headSha: after })).toBe(false);
  });

  it('reads changed paths verbatim, not Git-quoted', async () => {
    const root = await makeRepository();
    git(root, 'switch', 'main');
    await write(root, 'src/\u00e9parser.ts', 'export const parse = (text: string) => text;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'add parser');
    git(root, 'switch', 'feature/cache');
    await write(root, 'src/cache.ts', "import { parse } from './\u00e9parser';\nexport function readEntry(key: string) {\n  return parse(key).trim();\n}\n");
    git(root, 'commit', '-am', 'Parse keys');
    git(root, 'rebase', 'main');
    const before = git(root, 'rev-parse', 'HEAD');
    const [shard] = partitionShards(await readPatch(root, git(root, 'merge-base', 'main', before), before));
    const after = await moveMainAndRebase(root, 'src/\u00e9parser.ts', 'export const parse = (text: string) => text.toLowerCase();\n');
    // Git quotes this path in its default output (core.quotePath).
    expect(git(root, 'diff', '--name-only', before, after)).toContain('\\303\\251parser');
    expect(await rebaseReuseAllowed(root, { shard, reviewedHead: before, headSha: after })).toBe(false);
  });
});
