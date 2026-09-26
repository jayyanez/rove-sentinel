import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMMENT_MARKER } from '../constants.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import {
  findOwnedGateComment,
  githubText,
  listReadyPullRequests,
  renderGateComment,
  syncPullRequests,
} from '../github.mjs';
import { attestationFileName, attestationIdentity, ensureState } from '../storage.mjs';

const temporaryDirectories: string[] = [];

async function makeContext() {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-github-test-'));
  temporaryDirectories.push(stateRoot);
  return {
    repoRoot: 'C:\\repo',
    remote: 'https://github.com/example/rove.git',
    repository: 'https://github.com/example/rove',
    stateRoot,
    paths: await ensureState(stateRoot),
    policy: reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n' }),
  };
}

function pullRequest() {
  return {
    number: 10,
    baseRefOid: 'a'.repeat(40),
    headRefOid: 'b'.repeat(40),
    baseRefName: 'main',
    headRefName: 'codex/review-gate',
    isDraft: false,
    isCrossRepository: false,
    author: { login: 'example' },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('shared review PR comment', () => {
  it('never adopts another commenter\'s marker-bearing comment', () => {
    const comments = [
      { id: 1, body: `${COMMENT_MARKER}\nquoted`, user: { login: 'participant' } },
      { id: 2, body: `${COMMENT_MARKER}\ngate`, user: { login: 'review-owner' } },
    ];
    expect(findOwnedGateComment(comments, 'review-owner')).toMatchObject({ id: 2 });
    expect(findOwnedGateComment(comments.slice(0, 1), 'review-owner')).toBeUndefined();
  });

  it('publishes exact-SHA state and omits dismissed candidates', () => {
    const body = renderGateComment({
      status: 'fail',
      risk: 'high',
      summary: 'One verified issue.',
      identity: {
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        gateVersion: '1.0.0',
        charterVersion: '1.0.0',
      },
      findings: [
        {
          disposition: 'verified', priority: 'P1', file: 'src/x.ts', line: 4,
          title: 'Race', reason: 'Late completion overwrites state.',
        },
        {
          disposition: 'dismissed', priority: 'P2', file: 'src/y.ts', line: 5,
          title: 'Noise', reason: 'Pre-existing.',
        },
      ],
    });
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain('`aaaaaaaaaaaa`');
    expect(body).toContain('Race');
    expect(body).not.toContain('Noise');
  });

  it('labels provider failures as errors rather than native uncertainty', () => {
    const body = renderGateComment({
      status: 'error',
      risk: 'unknown',
      summary: 'Claude authentication is unavailable.',
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
    });
    expect(body).toContain('Shared review gate: ERROR');
    expect(body).not.toContain('NEEDS NATIVE EVIDENCE');
  });

  it('publishes a passing advisory without presenting it as required work', () => {
    const body = renderGateComment({
      status: 'pass',
      risk: 'high',
      summary: 'Review passed with one bounded advisory.',
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      actionableCount: 0,
      advisoryCount: 1,
      convergence: { round: 'follow-up', lateDiscoveriesUsed: 2, lateDiscoveryQuota: 2, deferrals: 1 },
      findings: [{
        disposition: 'advisory', adjudicatedDisposition: 'verified', enforcement: 'advisory',
        priority: 'P2', file: 'src/example.ts', line: 1, title: 'Bounded issue',
        reason: 'A narrow input remains wrong.', advisoryReason: 'Deferred by the author at cccccccccccc: Tracked in docs/bugs/open/bounded.md',
        deferral: { headSha: 'c'.repeat(40), reason: 'Tracked in docs/bugs/open/bounded.md' },
      }],
    });

    expect(body).toContain('Shared review gate: PASS WITH ADVISORIES');
    expect(body).toContain('Round: follow-up; late-discovery blocks used: 2/2; deferrals: 1');
    expect(body).toContain('### Deferred by the author');
    expect(body).toContain('Reason: Tracked in docs');
    // A deferred advisory is listed once, under the author's decision.
    expect(body).not.toContain('Advisory follow-up (non-blocking)');
    expect(body).not.toContain('### Action required');
  });

  it('discloses deferred findings beyond the comment bound instead of dropping them', () => {
    const deferred = Array.from({ length: 23 }, (_, index) => ({
      disposition: 'advisory', adjudicatedDisposition: 'verified', enforcement: 'advisory',
      priority: 'P3', file: `src/f${index}.ts`, line: 1, title: `Deferred ${index}`,
      reason: 'Narrow.', advisoryReason: 'Deferred by the author', deferral: { headSha: 'c'.repeat(40), reason: 'later' },
    }));
    const body = renderGateComment({
      status: 'pass', risk: 'high', summary: 'Passed.',
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      findings: deferred,
    });
    expect(body.match(/^- \*\*P3\*\* `src\/f\d+\.ts:1`/gm)?.length).toBe(20);
    expect(body).toContain('3 additional deferred finding(s) are recorded in the bounded local report.');
    // The row budget is shared: 20 actionable rows leave no deferred slot and
    // the body stays under GitHub's 65,536-character comment limit.
    const big = (index: number, extra: Record<string, unknown> = {}) => ({
      disposition: 'verified', priority: 'P2', file: `src/${'f'.repeat(480)}${index}.ts`, line: 1,
      title: 't'.repeat(300), reason: 'r'.repeat(1000), ...extra,
    });
    const crowded = renderGateComment({
      status: 'fail', risk: 'high', summary: 's'.repeat(4000),
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      findings: [
        ...Array.from({ length: 20 }, (_, index) => big(index)),
        ...Array.from({ length: 20 }, (_, index) => big(100 + index, {
          disposition: 'advisory', adjudicatedDisposition: 'verified', priority: 'P3',
          advisoryReason: 'Deferred', deferral: { headSha: 'c'.repeat(40), reason: 'x'.repeat(1000) },
        })),
      ],
    });
    expect(crowded.length).toBeLessThan(65_536);
    expect(crowded).toContain('### Deferred by the author');
    expect(crowded.match(/### Deferred by the author/g)?.length).toBe(1);
    expect(crowded).toContain('20 additional deferred finding(s) are recorded in the bounded local report.');
    // A compacted stored result keeps only the count; the section still says so.
    const compacted = renderGateComment({
      status: 'pass', risk: 'high', summary: 'ok', deferredCount: 3,
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      findings: Array.from({ length: 20 }, (_, index) => big(index)),
    });
    expect(compacted).toContain('3 additional deferred finding(s)');
  });

  it('publishes why a repaired head is still blocked', () => {
    const body = renderGateComment({
      status: 'fail', risk: 'high', summary: 'Repair incomplete.',
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      convergence: { round: 'follow-up', lateDiscoveriesUsed: 1, lateDiscoveryQuota: 2, deferrals: 0 },
      findings: [{
        disposition: 'verified', priority: 'P2', file: 'src/example.ts', line: 1,
        title: 'Bounded issue', reason: 'The second head is still wrong.', blockingReason: 'persisting',
      }],
    });

    expect(body).toContain('Round: follow-up; late-discovery blocks used: 1/2; deferrals: 0');
    expect(body).toContain('[persisting]');
  });

  it('bounds GitHub comment findings and neutralizes mentions', () => {
    const findings = Array.from({ length: 30 }, (_, index) => ({
      disposition: 'verified', priority: 'P2', file: `src/${index}.ts`, line: 1,
      title: '@team investigate', reason: 'x'.repeat(2_000),
    }));
    const body = renderGateComment({
      status: 'fail', risk: 'high', summary: '@team summary',
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, findings,
    });
    expect(body).toContain('10 additional finding(s)');
    expect(body).toContain('@\u200bteam');
    expect(body.length).toBeLessThan(30_000);
  });

  it('renders model-produced Markdown and raw HTML as inert comment text', () => {
    const body = renderGateComment({
      status: 'fail',
      risk: 'high',
      summary: 'Leak ![payload](https://attacker.invalid/secret)\n<img src="https://attacker.invalid/raw">',
      identity: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
      findings: [{
        disposition: 'verified', priority: 'P2', file: 'src/safe.ts', line: 1,
        title: '[click](https://attacker.invalid/title)',
        reason: '<https://attacker.invalid/autolink> @team',
      }],
    });

    expect(body).not.toMatch(/!\[[^\]]*\]\(/);
    expect(body).not.toMatch(/(?<!\\)<img/);
    expect(body).not.toMatch(/(?<!\\)<https:\/\//);
    expect(body).not.toMatch(/(?<!\\)\[click\]\(/);
    expect(body).toContain('\\!\\[payload\\]\\(https\\:\\/\\/attacker\\.invalid');
    expect(body).toContain('\\@\u200bteam');
    expect(body).toContain('`src/safe.ts:1`');
  });

  it('applies the GitHub text bound after Markdown escaping', () => {
    const result = githubText('!'.repeat(2_000), 1_000);

    expect(result.length).toBeLessThanOrEqual(1_000);
    expect(result).toMatch(/…$/);
    expect(result.slice(0, -1)).not.toMatch(/(?<!\\)!(?:$|[^!])/);
    expect(result.slice(0, -1)).not.toMatch(/(?<!\\)\\$/);
  });

  it('discovers ready PRs beyond the former 30-item draft-heavy window', async () => {
    const open = [
      ...Array.from({ length: 30 }, (_, index) => ({
        ...pullRequest(), number: index + 1, isDraft: true,
      })),
      { ...pullRequest(), number: 31, isDraft: false },
    ];
    const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(open), stderr: '' }));

    await expect(listReadyPullRequests('C:\\repo', {
      run, limit: 40, repoSlug: 'example/rove',
    }))
      .resolves.toEqual([expect.objectContaining({ number: 31 })]);
    expect(run.mock.calls[0][1]).toContain('40');
    expect(run.mock.calls[0][1]).toContain('example/rove');
  });

  it('fails closed instead of silently truncating ready-PR discovery', async () => {
    const open = Array.from({ length: 3 }, (_, index) => ({
      ...pullRequest(), number: index + 1,
    }));
    const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(open), stderr: '' }));

    await expect(listReadyPullRequests('C:\\repo', {
      run, limit: 3, repoSlug: 'example/rove',
    }))
      .rejects.toThrow('cannot prove complete coverage');
  });

  it('reuses a failing exact-SHA outcome and propagates a custom state root', async () => {
    const context = await makeContext();
    const pr = pullRequest();
    const identity = attestationIdentity({
      repository: context.repository,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      policyDigest: context.policy.policyDigest,
    });
    const runGate = vi.fn(async (options) => ({
      status: 'fail', identity, risk: 'high', summary: 'Verified failure.', findings: [], options,
    }));
    const dependencies = {
      context,
      runGate,
      listPullRequests: async () => [pr],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish: vi.fn(async () => ({ changed: false })),
    };

    await syncPullRequests(dependencies);
    await syncPullRequests(dependencies);

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(runGate.mock.calls[0][0].stateRoot).toBe(context.stateRoot);
    expect(runGate.mock.calls[0][0].branch).toBe(pr.headRefName);
    expect(await readdir(context.paths.events)).toEqual([]);
  });

  it('publishes nothing when the recorded-deferral lookup fails', async () => {
    const context = await makeContext();
    const pr = pullRequest();
    const identity = attestationIdentity({
      repository: context.repository,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      policyDigest: context.policy.policyDigest,
    });
    const publish = vi.fn(async () => ({ changed: true, commentId: 1 }));
    await expect(syncPullRequests({
      context,
      runGate: vi.fn(async () => ({ status: 'pass', identity, risk: 'high', summary: 'ok', findings: [] })),
      listPullRequests: async () => [pr],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: async () => pr.baseRefOid,
      publish,
      applyDeferrals: async () => { throw new Error('dispositions unreadable'); },
    })).rejects.toThrow('dispositions unreadable');
    expect(publish).not.toHaveBeenCalled();
  });

  it('bounds technical-error retries for one unchanged identity', async () => {
    const context = await makeContext();
    const pr = pullRequest();
    let clock = 0;
    const runGate = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const dependencies = {
      context,
      runGate,
      listPullRequests: async () => [pr],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish: vi.fn(async () => ({ changed: false })),
      now: () => clock,
    };

    await syncPullRequests(dependencies);
    await syncPullRequests(dependencies);
    clock = 60_000;
    await syncPullRequests(dependencies);
    clock = 180_000;
    await syncPullRequests(dependencies);
    clock = 10_000_000;
    await syncPullRequests(dependencies);

    expect(runGate).toHaveBeenCalledTimes(3);
  });

  it('pauses PR review retries after an unrecoverable Windows provider orphan', async () => {
    const context = await makeContext();
    const pr = pullRequest();
    const pause = vi.fn(async () => {});
    const error = Object.assign(new Error('provider orphan'), {
      code: 'ORPHANED_PROCESS_TREE',
    });

    await expect(syncPullRequests({
      context,
      runGate: async () => { throw error; },
      listPullRequests: async () => [pr],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish: vi.fn(async () => ({ changed: false })),
      pause,
    })).rejects.toBe(error);

    expect(pause).toHaveBeenCalledWith(
      context.paths,
      expect.stringContaining('inspect remaining provider processes'),
    );
  });

  it('pauses PR review retries after any unverified provider cleanup', async () => {
    const context = await makeContext();
    const pause = vi.fn(async () => {});
    const error = Object.assign(new Error('provider cleanup failed'), {
      code: 'TERMINATED',
      terminationError: { code: 'PROCESS_TREE_CLEANUP_FAILED' },
    });

    await expect(syncPullRequests({
      context,
      runGate: async () => { throw error; },
      listPullRequests: async () => [pullRequest()],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish: vi.fn(async () => ({ changed: false })),
      pause,
    })).rejects.toBe(error);

    expect(pause).toHaveBeenCalledWith(
      context.paths,
      expect.stringContaining('cleanup could not be verified'),
    );
  });

  it('pauses when PR discovery has an unverified nested process cleanup', async () => {
    const context = await makeContext();
    const pause = vi.fn(async () => {});
    const error = Object.assign(new Error('gh discovery timed out'), {
      code: 'TIMEOUT',
      terminationError: { code: 'ORPHANED_PROCESS_TREE' },
    });

    await expect(syncPullRequests({
      context,
      runGate: vi.fn(async () => {}),
      listPullRequests: async () => { throw error; },
      publish: vi.fn(async () => ({ changed: false })),
      pause,
    })).rejects.toBe(error);

    expect(pause).toHaveBeenCalledWith(
      context.paths,
      expect.stringContaining('inspect remaining provider processes'),
    );
  });

  it('discards a corrupt PASS file and reviews the PR head again', async () => {
    const context = await makeContext();
    const pr = pullRequest();
    const identity = attestationIdentity({
      repository: context.repository,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      policyDigest: context.policy.policyDigest,
    });
    await writeFile(path.join(context.paths.attestations, attestationFileName(identity)), '{');
    const runGate = vi.fn(async () => ({
      status: 'pass', identity, risk: 'low', summary: 'Fresh review passed.', findings: [],
    }));

    await syncPullRequests({
      context,
      runGate,
      listPullRequests: async () => [pr],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish: vi.fn(async () => ({ changed: false })),
    });

    expect(runGate).toHaveBeenCalledTimes(1);
  });

  it('bounds technical-error retries when commit preparation itself fails', async () => {
    const context = await makeContext();
    const pr = pullRequest();
    let clock = 0;
    const ensureCommit = vi.fn(async () => {
      throw new Error('fetch unavailable');
    });
    const dependencies = {
      context,
      runGate: vi.fn(),
      listPullRequests: async () => [pr],
      ensureCommit,
      resolveMergeBase: vi.fn(),
      publish: vi.fn(async () => ({ changed: false })),
      now: () => clock,
    };

    await syncPullRequests(dependencies);
    await syncPullRequests(dependencies);
    clock = 60_000;
    await syncPullRequests(dependencies);
    clock = 180_000;
    await syncPullRequests(dependencies);
    clock = 10_000_000;
    await syncPullRequests(dependencies);

    expect(ensureCommit).toHaveBeenCalledTimes(3);
    expect(dependencies.runGate).not.toHaveBeenCalled();
  });

  it('stops PR iteration after watcher shutdown interrupts the active review', async () => {
    const context = await makeContext();
    const first = pullRequest();
    const second = { ...pullRequest(), number: 11, headRefOid: 'c'.repeat(40) };
    let stopped = false;
    const runGate = vi.fn(async (options) => {
      stopped = true;
      return {
        status: 'pass', risk: 'low', summary: 'Clean.', findings: [],
        identity: attestationIdentity({
          repository: context.repository,
          baseSha: options.base,
          headSha: options.head,
          policyDigest: context.policy.policyDigest,
        }),
      };
    });
    const publish = vi.fn(async () => ({ changed: false }));

    await expect(syncPullRequests({
      context,
      runGate,
      listPullRequests: async () => [first, second],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish,
      shouldStop: () => stopped,
    })).rejects.toThrow('interrupted for watcher shutdown');

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('reuses an outcome when the base tip advances but the merge base is unchanged', async () => {
    const context = await makeContext();
    const first = pullRequest();
    const advanced = { ...first, baseRefOid: 'c'.repeat(40) };
    const canonicalBase = 'd'.repeat(40);
    let listed = 0;
    const runGate = vi.fn(async () => ({
      status: 'fail',
      risk: 'medium',
      summary: 'Verified failure.',
      findings: [],
      identity: attestationIdentity({
        repository: context.repository,
        baseSha: canonicalBase,
        headSha: first.headRefOid,
        policyDigest: context.policy.policyDigest,
      }),
    }));
    const dependencies = {
      context,
      runGate,
      listPullRequests: async () => [listed++ === 0 ? first : advanced],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async () => canonicalBase),
      publish: vi.fn(async () => ({ changed: false })),
    };

    await syncPullRequests(dependencies);
    await syncPullRequests(dependencies);

    expect(runGate).toHaveBeenCalledTimes(1);
  });

  it('yields between PRs when queued push work appears', async () => {
    const context = await makeContext();
    const first = pullRequest();
    const second = { ...first, number: 11, headRefOid: 'c'.repeat(40) };
    let yieldChecks = 0;
    const runGate = vi.fn(async (options) => ({
      status: 'pass', risk: 'low', summary: 'Clean.', findings: [],
      identity: attestationIdentity({
        repository: context.repository,
        baseSha: options.base,
        headSha: options.head,
        policyDigest: context.policy.policyDigest,
      }),
    }));

    const outcomes = await syncPullRequests({
      context,
      runGate,
      listPullRequests: async () => [first, second],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish: vi.fn(async () => ({ changed: false })),
      shouldYield: async () => ++yieldChecks > 2,
    });

    expect(outcomes).toHaveLength(1);
    expect(runGate).toHaveBeenCalledTimes(1);
  });

  it('preserves the omitted-finding count when reusing a bounded outcome', async () => {
    const context = await makeContext();
    const pr = pullRequest();
    const findings = Array.from({ length: 30 }, (_, index) => ({
      disposition: 'verified', priority: 'P2', file: `src/${index}.ts`, line: 1,
      title: 'Failure', reason: 'Concrete failure.',
    }));
    const runGate = vi.fn(async () => ({
      status: 'fail', risk: 'high', summary: 'Many failures.', findings,
      identity: attestationIdentity({
        repository: context.repository,
        baseSha: pr.baseRefOid,
        headSha: pr.headRefOid,
        policyDigest: context.policy.policyDigest,
      }),
    }));
    const comments = [];
    const dependencies = {
      context,
      runGate,
      listPullRequests: async () => [pr],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish: vi.fn(async (_repo, _slug, _number, result) => {
        comments.push(renderGateComment(result));
        return { changed: false };
      }),
    };

    await syncPullRequests(dependencies);
    await syncPullRequests(dependencies);

    expect(comments).toHaveLength(2);
    expect(comments[0]).toContain('10 additional finding(s)');
    expect(comments[1]).toContain('10 additional finding(s)');
  });

  it('continues reviewing later PRs before surfacing a publish failure', async () => {
    const context = await makeContext();
    const first = pullRequest();
    const second = { ...first, number: 11, headRefOid: 'c'.repeat(40) };
    const runGate = vi.fn(async (options) => ({
      status: 'pass', risk: 'low', summary: 'Clean.', findings: [],
      identity: attestationIdentity({
        repository: context.repository,
        baseSha: options.base,
        headSha: options.head,
        policyDigest: context.policy.policyDigest,
      }),
    }));
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce({ changed: true });

    await expect(syncPullRequests({
      context,
      runGate,
      listPullRequests: async () => [first, second],
      ensureCommit: vi.fn(async () => {}),
      resolveMergeBase: vi.fn(async (_repo, base) => base),
      publish,
    })).rejects.toThrow('could not publish 1 comment');

    expect(runGate).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
