import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reviewPolicySnapshot } from '../context.mjs';
import { formatGateResult, runGate } from '../gate.mjs';
import { renderGateComment } from '../github.mjs';
import { ensureState, readReport } from '../storage.mjs';
import { ProviderUsageLimitError, readProviderHolds, recordProviderHolds } from '../usageLimits.mjs';

// Real repositories and Git worktrees: Windows needs more than the default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A change of two shards: `src/a.ts` and `src/b.ts`, 300 lines each. */
async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-usage-fallback-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git');
  await writeFile(path.join(root, 'README.md'), '# base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  for (const name of ['a', 'b']) {
    await writeFile(path.join(root, 'src', `${name}.ts`), Array.from({ length: 300 }, (_, index) => `export const ${name}${index} = ${index};`).join('\n'));
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'two shards');
  const head = git(root, 'rev-parse', 'HEAD');
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-usage-fallback-state-'));
  temporaryDirectories.push(stateRoot);
  return { root, base, head, stateRoot };
}

function policy(providers?: string) {
  return reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n', ...(providers ? { config: { providers } } : {}) });
}

const limit = (provider: 'claude' | 'codex') => new ProviderUsageLimitError(provider, {
  resetAt: Date.now() + 4 * 24 * 3_600_000,
  message: "You've hit your usage limit. Upgrade to Pro or try again in 4 days.",
});

const reviewed = ({ provider, roleIndex }: { provider: string; roleIndex: number }) => ({ provider, roleIndex, summary: 'Reviewed.', candidates: [] });

function worktreeCount(root: string) {
  return git(root, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length;
}

describe('a provider that reaches its usage limit during an auto review', () => {
  it('restarts the review once, from scratch, with the other provider, and records the fallback', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const calls: Array<{ provider: string; shard: number }> = [];
    const shardReviewer = vi.fn(async ({ provider, roleIndex, shard }) => {
      calls.push({ provider, shard: shard.index });
      if (provider === 'codex') {
        // Fails after the Claude shard of the same round has completed, so
        // that round leaves a kept Claude review behind it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw limit('codex');
      }
      return reviewed({ provider, roleIndex });
    });
    const progress: string[] = [];
    const options = {
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer, progress: (line: string) => progress.push(line),
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    };
    const result = await runGate(options);
    expect(result.status).toBe('pass');
    expect(result.providerSelection).toEqual(['claude']);
    expect(result.modelDiversity).toBe('single-provider');
    expect(result.providerFallback).toMatchObject({ dropped: ['codex'], reason: 'usage-limit', restarted: true, resetAt: expect.any(String) });
    expect(progress.some((line) => /codex usage limit reached \(retry after .+\); restarting this review with claude only\./.test(line))).toBe(true);
    // The first round: Claude on shard 2, Codex on shard 1. The restart
    // reviews both shards with Claude, the one Claude completed included:
    // nothing of the discarded round is reused.
    expect(calls.filter((call) => call.provider === 'codex')).toEqual([{ provider: 'codex', shard: 0 }]);
    expect(calls.filter((call) => call.provider === 'claude').map((call) => call.shard).sort()).toEqual([0, 1, 1]);
    expect(result.shards.every((shard: { reused?: boolean; provider: string }) => !shard.reused && shard.provider === 'claude')).toBe(true);
    // The record stays for status, doctor and the next review.
    const paths = await ensureState(stateRoot);
    expect(await readProviderHolds(paths)).toMatchObject({ codex: { message: expect.stringContaining('usage limit') } });
    // The report and the attestation say so; the PASS is ordinary auto
    // single-provider evidence for this commit and policy.
    const report = await readReport(paths, result.reportId);
    expect(report.providerFallback).toMatchObject({ dropped: ['codex'], restarted: true });
    expect(formatGateResult(result)).toContain('Provider fallback: codex left out after its usage limit');
    expect(renderGateComment(result)).toContain('codex left out after its usage limit');
    expect(await runGate(options)).toMatchObject({ cached: true, providerSelection: ['claude'], providerFallback: { dropped: ['codex'] } });
    // Both rounds' review checkouts were removed.
    expect(worktreeCount(root)).toBe(1);
  });

  it('fails closed when the restart reaches a usage limit too, and records both', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    let restarted = false;
    const shardReviewer = vi.fn(async ({ provider, roleIndex }) => {
      if (provider === 'codex' || restarted) throw limit(provider);
      return reviewed({ provider, roleIndex });
    });
    await expect(runGate({
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer,
      progress: (line: string) => { if (line.includes('restarting this review')) restarted = true; },
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    })).rejects.toThrow(/claude reported its subscription usage limit[\s\S]*claude usage limit reached; retry after [\s\S]*does not restart again/);
    expect(restarted).toBe(true);
    expect(Object.keys(await readProviderHolds(await ensureState(stateRoot))).sort()).toEqual(['claude', 'codex']);
    expect(worktreeCount(root)).toBe(1);
  });

  it('keeps a process-tree cleanup failure beside the limit, and does not restart', async () => {
    // Gate review of c21404b: the usage-limit error dropped the cleanup code
    // the watcher pauses on, and the review restarted over the tree.
    const { root, base, head, stateRoot } = await makeRepository();
    const progress: string[] = [];
    const shardReviewer = vi.fn(async ({ provider }) => {
      if (provider === 'codex') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw limit('codex');
      }
      throw Object.assign(new Error('claude tree could not be verified'), { code: 'PROCESS_TREE_CLEANUP_FAILED' });
    });
    await expect(runGate({
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer, progress: (line: string) => progress.push(line),
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    })).rejects.toMatchObject({ code: 'PROCESS_TREE_CLEANUP_FAILED' });
    expect(progress.some((line) => line.includes('restarting'))).toBe(false);
    expect(shardReviewer.mock.calls.filter(([call]) => call.provider === 'claude')).toHaveLength(1);
  });

  it('restarts after --force without the stale record of a provider that worked', async () => {
    // Gate review of c21404b: the restart carried every live record, taken
    // before the round cleared the provider that had just worked, so a forced
    // review that met a limit had no provider left to restart with.
    const { root, base, head, stateRoot } = await makeRepository();
    const paths = await ensureState(stateRoot);
    await recordProviderHolds(paths, [{ provider: 'claude', resetAt: Date.now() + 4 * 24 * 3_600_000, message: 'stale' }]);
    const shardReviewer = vi.fn(async ({ provider, roleIndex }) => {
      if (provider === 'codex') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw limit('codex');
      }
      return reviewed({ provider, roleIndex });
    });
    const result = await runGate({
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy(), force: true,
      availableProviders: ['claude', 'codex'], shardReviewer,
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    });
    expect(result).toMatchObject({ status: 'pass', providerSelection: ['claude'], providerFallback: { dropped: ['codex'], restarted: true } });
    expect(Object.keys(await readProviderHolds(paths))).toEqual(['codex']);
  });

  it('does not restart when every selected provider reached its limit', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const progress: string[] = [];
    await expect(runGate({
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer: async ({ provider }) => { throw limit(provider); },
      progress: (line: string) => progress.push(line),
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    })).rejects.toThrow(/No other selected provider remains/);
    expect(progress.some((line) => line.includes('restarting'))).toBe(false);
  });
});

describe('usage limits under an explicit provider requirement', () => {
  it('refuses to start without the required provider and names its reset', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    await recordProviderHolds(await ensureState(stateRoot), [{ provider: 'codex', resetAt: Date.now() + 4 * 24 * 3_600_000, message: 'limit' }]);
    const shardReviewer = vi.fn(async (args) => reviewed(args));
    await expect(runGate({
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy('both'),
      availableProviders: ['claude', 'codex'], shardReviewer,
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    })).rejects.toThrow(/Provider requirement both cannot be satisfied: codex usage limit reached; retry after \d{4}-\d{2}-\d{2}T/);
    expect(shardReviewer).not.toHaveBeenCalled();
  });

  it('fails closed mid-review without falling back, and keeps the record', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const shardReviewer = vi.fn(async () => { throw limit('codex'); });
    await expect(runGate({
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy('codex'),
      availableProviders: ['claude', 'codex'], shardReviewer,
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    })).rejects.toThrow(/explicit provider requirement codex does not fall back[\s\S]*codex usage limit reached; retry after/);
    expect(shardReviewer.mock.calls.every(([call]) => call.provider === 'codex')).toBe(true);
    expect(Object.keys(await readProviderHolds(await ensureState(stateRoot)))).toEqual(['codex']);
    expect(worktreeCount(root)).toBe(1);
  });
});

describe('a usage-limit record at the start of an auto review', () => {
  it('plans without that provider and says so; --force tries it again and a success clears it', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const paths = await ensureState(stateRoot);
    await recordProviderHolds(paths, [{ provider: 'codex', resetAt: null, message: 'limit' }]);
    const shardReviewer = vi.fn(async (args) => reviewed(args));
    const options = {
      repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer,
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    };
    const first = await runGate(options);
    expect(first).toMatchObject({ status: 'pass', providerSelection: ['claude'], providerFallback: { dropped: ['codex'], restarted: false } });
    expect(shardReviewer.mock.calls.every(([call]) => call.provider === 'claude')).toBe(true);
    expect(formatGateResult(first)).toContain('the review was planned without it');
    const forced = await runGate({ ...options, force: true });
    expect(forced).toMatchObject({ status: 'pass', providerSelection: ['claude', 'codex'] });
    expect(forced.providerFallback).toBeUndefined();
    expect(await readProviderHolds(paths)).toEqual({});
  });
});

describe('any provider failure after its retry, under auto (owner decision)', () => {
  const common = {
    risk: 'high',
    scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
    deterministicLanes: async () => ({ lanes: [], findings: [] }),
  };
  const failing = (bad: string, error = () => new Error('Provider must explicitly report review_complete.')) =>
    vi.fn(async ({ provider, roleIndex }) => {
      if (provider === bad) throw error();
      return reviewed({ provider, roleIndex });
    });

  it('falls back to Claude when a Codex shard fails twice, and records why', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const progress: string[] = [];
    const shardReviewer = failing('codex');
    const result = await runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer, progress: (line: string) => progress.push(line),
    });
    expect(result).toMatchObject({
      status: 'pass', providerSelection: ['claude'], modelDiversity: 'single-provider',
      providerFallback: { dropped: ['codex'], reason: 'provider-failure', restarted: true, resetAt: null },
    });
    expect(shardReviewer.mock.calls.filter(([call]) => call.provider === 'codex')).toHaveLength(2);
    expect(progress).toContain('codex failed twice (Provider must explicitly report review_complete.); restarting this review with claude only.');
    expect(formatGateResult(result)).toContain('codex left out after it failed and its retry failed');
    const holds = await readProviderHolds(await ensureState(stateRoot));
    expect(holds).toMatchObject({ codex: { reason: 'provider-failure', resetAt: null, message: expect.stringContaining('review_complete') } });
    expect(holds.claude).toBeUndefined();
    expect(worktreeCount(root)).toBe(1);
  });

  it('falls back to Codex when a Claude shard fails twice', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const shardReviewer = failing('claude', () => new Error('claude exceeded its 300000ms time limit'));
    const result = await runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'codex', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer,
    });
    expect(result).toMatchObject({ status: 'pass', providerSelection: ['codex'], providerFallback: { dropped: ['claude'], reason: 'provider-failure' } });
    expect(Object.keys(await readProviderHolds(await ensureState(stateRoot)))).toEqual(['claude']);
  });

  it('falls back when the coordinator fails twice', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const shardReviewer = vi.fn(async ({ provider, roleIndex, shard }) => ({
      provider, roleIndex, summary: 'One candidate.',
      candidates: [{
        id: `${provider}-${roleIndex}-0`, provider, roleIndex, title: `Defect in ${shard.files[0]}`, priority: 'P2', confidence: 90,
        category: 'state', file: shard.files[0], line: 1, scenario: 's', evidence: 'e', proposed_test: 't',
      }],
    }));
    const coordinator = vi.fn(async ({ provider, candidates }) => {
      if (provider === 'codex') throw new Error('Coordinator findings must be an array.');
      return {
        summary: 'Dismissed.',
        findings: candidates.map((entry: { id: string; title: string; file: string; line: number }) => ({
          candidate_id: entry.id, title: entry.title, priority: 'P2', file: entry.file, line: entry.line,
          disposition: 'dismissed', reason: 'Not a defect.', scenario: 's', proposed_test: 't',
        })),
      };
    });
    const result = await runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer, coordinator,
    });
    expect(result).toMatchObject({ status: 'pass', providerSelection: ['claude'], providerFallback: { dropped: ['codex'], reason: 'provider-failure' } });
    expect(coordinator.mock.calls.some(([call]) => call.provider === 'claude')).toBe(true);
    expect(coordinator.mock.calls.filter(([call]) => call.provider === 'codex').length).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when the other provider fails on the restart too', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    let restarted = false;
    const shardReviewer = vi.fn(async ({ provider, roleIndex }) => {
      if (provider === 'codex' || restarted) throw new Error(`${provider} exited with code 1`);
      return reviewed({ provider, roleIndex });
    });
    await expect(runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer,
      progress: (line: string) => { if (line.includes('restarting this review')) restarted = true; },
    })).rejects.toThrow(/failed after retry[\s\S]*does not restart again/);
    expect(restarted).toBe(true);
    // Only the provider the review fell back from is held.
    expect(Object.keys(await readProviderHolds(await ensureState(stateRoot)))).toEqual(['codex']);
  });

  it('does not fall back over a process-tree cleanup failure, and keeps its code', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const progress: string[] = [];
    await expect(runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], progress: (line: string) => progress.push(line),
      shardReviewer: failing('codex', () => Object.assign(new Error('codex tree could not be verified'), { code: 'PROCESS_TREE_CLEANUP_FAILED' })),
    })).rejects.toMatchObject({ code: 'PROCESS_TREE_CLEANUP_FAILED' });
    expect(progress.some((line) => line.includes('restarting'))).toBe(false);
    expect(await readProviderHolds(await ensureState(stateRoot))).toEqual({});
  });

  it('never falls back under an explicit requirement, and holds nothing', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const progress: string[] = [];
    const shardReviewer = failing('codex');
    await expect(runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'claude', policy: policy('both'),
      availableProviders: ['claude', 'codex'], shardReviewer, progress: (line: string) => progress.push(line),
    })).rejects.toThrow(/failed after retry/);
    expect(progress.some((line) => line.includes('restarting'))).toBe(false);
    expect(await readProviderHolds(await ensureState(stateRoot))).toEqual({});
  });

  it('keeps tolerating a failed scout without a fallback', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const result = await runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer: vi.fn(async (args) => reviewed(args)),
      scout: async () => { throw new Error('scout timed out'); },
    });
    expect(result).toMatchObject({ status: 'pass', providerSelection: ['claude', 'codex'] });
    expect(result.providerFallback).toBeUndefined();
    expect(await readProviderHolds(await ensureState(stateRoot))).toEqual({});
  });

  it('does not fall back for an error that is not a provider failure', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const progress: string[] = [];
    const shardReviewer = failing('codex');
    // A deterministic lane (here a Git failure inside it) fails the round
    // closed before any provider's failure is weighed.
    await expect(runGate({
      ...common, repoRoot: root, stateRoot, base, head, author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer, progress: (line: string) => progress.push(line),
      deterministicLanes: async () => { throw new Error('git exited with code 128: fatal: bad object'); },
    })).rejects.toThrow(/deterministic lane failed/);
    // A Git error before any provider work.
    await expect(runGate({
      ...common, repoRoot: root, stateRoot, base, head: 'no-such-ref', author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer, progress: (line: string) => progress.push(line),
    })).rejects.toThrow();
    expect(progress.some((line) => line.includes('restarting'))).toBe(false);
    expect(await readProviderHolds(await ensureState(stateRoot))).toEqual({});
  });

  it('skips a failed provider in the next auto review until it is cleared by a success', async () => {
    const { root, base, head, stateRoot } = await makeRepository();
    const paths = await ensureState(stateRoot);
    const run = (target: string, shardReviewer: ReturnType<typeof vi.fn>, extra = {}) => runGate({
      ...common, repoRoot: root, stateRoot, base, head: target, author: 'claude', policy: policy(),
      availableProviders: ['claude', 'codex'], shardReviewer, ...extra,
    });
    await run(head, failing('codex'));
    expect(Object.keys(await readProviderHolds(paths))).toEqual(['codex']);
    const commit = async (name: string) => {
      await writeFile(path.join(root, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
      git(root, 'add', '.');
      git(root, 'commit', '-m', name);
      return git(root, 'rev-parse', 'HEAD');
    };
    const next = vi.fn(async (args) => reviewed(args));
    const second = await run(await commit('c'), next);
    expect(second).toMatchObject({ status: 'pass', providerSelection: ['claude'], providerFallback: { dropped: ['codex'], reason: 'provider-failure', restarted: false } });
    expect(next.mock.calls.every(([call]) => call.provider === 'claude')).toBe(true);
    // A failure hold never leaves a review without a provider.
    const alone = vi.fn(async (args) => reviewed(args));
    expect(await run(await commit('e'), alone, { availableProviders: ['codex'] })).toMatchObject({ status: 'pass', providerSelection: ['codex'] });
    // That success cleared it; hold it again, then --force tries every
    // provider and the success clears it as well.
    await recordProviderHolds(paths, [{ provider: 'codex', reason: 'provider-failure', message: 'failed' }]);
    const third = await run(await commit('d'), vi.fn(async (args) => reviewed(args)), { force: true });
    expect(third).toMatchObject({ status: 'pass', providerSelection: ['claude', 'codex'] });
    expect(await readProviderHolds(paths)).toEqual({});
  });
});
