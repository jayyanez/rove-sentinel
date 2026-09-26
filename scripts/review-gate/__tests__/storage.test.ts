import { access, copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHARTER_VERSION, GATE_VERSION } from '../constants.mjs';
import {
  attestationIdentity,
  attestationFileName,
  acquireDaemonLock,
  atomicWriteJson,
  cancelQueuedRequest,
  claimNextRequest,
  clearTechnicalErrorOutcomes,
  completeRequest,
  daemonOwnerIsHealthy,
  ensureState,
  pruneDirectory,
  readPause,
  readJson,
  readAttestation,
  acquireDispositionLock,
  findLatestReportForIdentity,
  readDispositions,
  readBranchReviews,
  readLineageReviews,
  reviewTimingSummary,
  writeReport,
  readLineagePassHeads,
  readOutcome,
  recordEvent,
  recordDisposition,
  recordLineageReview,
  recordLineagePass,
  removeAttestation,
  normalizeRepositoryIdentity,
  recoverClaims,
  resumeGate,
  replaceExistingFile,
  stateRootFor,
  submitRequest,
  waitForDaemonHeartbeat,
  waitForResult,
  writeAttestation,
  writeDaemonError,
  writeOutcome,
} from '../storage.mjs';

const temporaryDirectories: string[] = [];
const POLICY_DIGEST = 'd'.repeat(64);

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rove-review-storage-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('shared review local state', () => {
  it('preserves case-sensitive repository paths while retaining GitHub identity', () => {
    expect(normalizeRepositoryIdentity('', '/tmp/Project', { platform: 'linux' }))
      .not.toBe(normalizeRepositoryIdentity('', '/tmp/project', { platform: 'linux' }));
    expect(normalizeRepositoryIdentity('', 'C:\\Repos\\Project', { platform: 'win32' }))
      .toBe(normalizeRepositoryIdentity('', 'c:\\repos\\project', { platform: 'win32' }));
    expect(normalizeRepositoryIdentity('ssh://git@example.com/Team/Project.git', 'unused'))
      .not.toBe(normalizeRepositoryIdentity('ssh://git@example.com/team/project.git', 'unused'));
    expect(normalizeRepositoryIdentity('ssh://git@github.com/Team/Project.git', 'unused'))
      .toBe('https://github.com/team/project');
  });

  it('normalizes non-git SSH usernames across SCP and URL syntax', () => {
    expect(normalizeRepositoryIdentity('deploy@example.com:Team/Project.git', 'unused'))
      .toBe(normalizeRepositoryIdentity('ssh://deploy@example.com/Team/Project.git', 'unused'));
  });
  it('never persists credentials embedded in a remote URL', () => {
    expect(
      normalizeRepositoryIdentity('https://x-access-token:secret@github.com/JayYanez/Rove.git', 'C:\\repo'),
    ).toBe('https://github.com/jayyanez/rove');
    expect(
      normalizeRepositoryIdentity('ftp://deploy:secret@example.com/Rove.git', 'C:\\repo'),
    ).toBe('https://example.com/Rove');
    expect(
      normalizeRepositoryIdentity('not a URL containing secret', 'C:\\repo'),
    ).toMatch(/^remote:[a-f0-9]{32}$/);
  });

  it('shares one repository identity across SSH and HTTPS clones', () => {
    expect(normalizeRepositoryIdentity(
      'ssh://git@github.com/JayYanez/Rove.git',
      'C:\\ssh-clone',
    )).toBe(normalizeRepositoryIdentity(
      'https://github.com/jayyanez/rove.git',
      'C:\\https-clone',
    ));
  });

  it('uses per-repository, per-platform state roots', () => {
    expect(
      stateRootFor('https://github.com/jayyanez/rove', {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Local' },
        home: 'C:\\Users\\me',
      }),
    ).toMatch(/^C:\\Local\\Rove\\shared-review-gate\\[a-f0-9]{16}$/);
    expect(
      stateRootFor('https://github.com/jayyanez/rove', {
        platform: 'darwin',
        env: {},
        home: '/Users/me',
      }),
    ).toMatch(/^\/Users\/me\/Library\/Application Support\/Rove\/shared-review-gate\/[a-f0-9]{16}$/);
  });

  it('requires a fresh matching owner token instead of trusting a live PID alone', () => {
    const now = Date.parse('2026-08-03T12:00:30.000Z');
    const heartbeat = {
      pid: 123, ownerToken: 'new-owner', at: '2026-08-03T12:00:00.000Z',
    };
    const options = { isAlive: () => true, now: () => now };
    expect(daemonOwnerIsHealthy({ pid: 123, ownerToken: 'old-owner' }, heartbeat, options)).toBe(false);
    expect(daemonOwnerIsHealthy({ pid: 123, ownerToken: 'new-owner' }, heartbeat, options)).toBe(true);
  });

  it('never deletes a daemon lock that is unreadable during concurrent initialization', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await writeFile(paths.lock, '');

    await expect(acquireDaemonLock(paths)).rejects.toThrow('unreadable or still initializing');
    await expect(access(paths.lock)).resolves.toBeUndefined();
  });

  it('retries acquisition when the contended daemon lock disappeared', async () => {
    const exists = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const handle = { writeFile: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const openFile = vi.fn()
      .mockRejectedValueOnce(exists)
      .mockResolvedValueOnce(handle);
    const read = vi.fn(async (_target, fallback) => fallback);
    const remove = vi.fn(async () => {});

    const lock = await acquireDaemonLock({ lock: 'lock', heartbeat: 'heartbeat', root: 'state' }, {
      openFile,
      read,
      remove,
      ownerPid: 123,
      ownerTokenFactory: () => 'owner-token',
    });

    expect(lock).toMatchObject({ ownerToken: 'owner-token' });
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves a dead-owner daemon lock for explicit recovery', async () => {
    const exists = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const openFile = vi.fn().mockRejectedValue(exists);
    const remove = vi.fn(async () => {});
    const read = vi.fn(async (target) => target === 'lock'
      ? { pid: 123, ownerToken: 'stale-owner' }
      : null);

    await expect(acquireDaemonLock(
      { lock: 'lock', heartbeat: 'heartbeat', root: 'state' },
      { openFile, read, remove, isAlive: () => false },
    )).rejects.toThrow('refusing automatic removal');

    expect(openFile).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves a dead-owner queue submission lock for explicit recovery', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await atomicWriteJson(paths.queueSubmitLock, {
      pid: 2_147_483_647,
      ownerToken: 'stale-submitter',
    });

    await expect(submitRequest(paths, {
      type: 'gate', options: { head: 'HEAD' },
    })).rejects.toThrow('refusing automatic removal');
    await expect(readJson(paths.queueSubmitLock)).resolves.toMatchObject({
      ownerToken: 'stale-submitter',
    });
  });

  it('accepts the one healthy repository daemon from a different checkout root', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const ownerToken = 'shared-owner';
    await atomicWriteJson(paths.lock, {
      pid: process.pid,
      ownerToken,
      startedAt: new Date().toISOString(),
    });
    await atomicWriteJson(paths.heartbeat, {
      pid: process.pid,
      ownerToken,
      repoRoot: 'C:\\first-checkout',
      gateVersion: GATE_VERSION,
      charterVersion: CHARTER_VERSION,
      at: new Date().toISOString(),
    });

    await expect(waitForDaemonHeartbeat(
      paths,
      'C:\\second-checkout',
      { timeoutMs: 50, pollMs: 5 },
    )).resolves.toMatchObject({ repoRoot: 'C:\\first-checkout' });
  });

  it('reports an actionable reinstall when a healthy watcher runs stale code', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const ownerToken = 'shared-owner';
    await atomicWriteJson(paths.lock, {
      pid: process.pid,
      ownerToken,
      startedAt: new Date().toISOString(),
    });
    await atomicWriteJson(paths.heartbeat, {
      pid: process.pid,
      ownerToken,
      repoRoot: 'C:\\first-checkout',
      gateVersion: 'stale',
      charterVersion: CHARTER_VERSION,
      at: new Date().toISOString(),
    });

    await expect(waitForDaemonHeartbeat(paths, 'C:\\second-checkout', {
      timeoutMs: 20,
      pollMs: 5,
    })).rejects.toThrow('Run npx --no-install rove-sentinel install from your trusted main checkout');
  });

  it('surfaces the detached watcher startup cause instead of a generic heartbeat timeout', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await writeDaemonError(paths, new Error('Installed policy is missing; run npx --no-install rove-sentinel install.'));

    await expect(waitForDaemonHeartbeat(paths, 'C:\\repo', {
      timeoutMs: 50,
      pollMs: 5,
    })).rejects.toThrow('Installed policy is missing; run npx --no-install rove-sentinel install');
  });

  it('invalidates attestations when any identity field changes', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const identity = attestationIdentity({
      repository: 'repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      policyDigest: POLICY_DIGEST,
    });
    await writeAttestation(paths, identity, { summary: 'clean', risk: 'medium' });
    expect(await readAttestation(paths, identity)).toMatchObject({ status: 'pass' });
    expect(await readAttestation(paths, { ...identity, headSha: 'c'.repeat(40) })).toBeNull();
    expect(await readAttestation(paths, { ...identity, policyDigest: 'e'.repeat(64) })).toBeNull();
  });

  it('reuses non-pass outcomes only for the exact review identity', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const identity = attestationIdentity({
      repository: 'repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      policyDigest: POLICY_DIGEST,
    });
    await writeOutcome(paths, identity, {
      status: 'fail', attempts: 1, nextRetryAt: null,
      result: { status: 'fail', identity, summary: 'Blocked.' },
    });
    expect(await readOutcome(paths, identity)).toMatchObject({ status: 'fail', attempts: 1 });
    expect(await readOutcome(paths, { ...identity, headSha: 'c'.repeat(40) })).toBeNull();
  });

  it('records one lineage review per exact head with its blocking findings, oldest first', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const lineage = {
      repository: 'repo', baseSha: 'a'.repeat(40), policyDigest: POLICY_DIGEST,
      charterVersion: CHARTER_VERSION, gateVersion: GATE_VERSION, branch: 'codex/feature',
    };
    const first = 'b'.repeat(40);
    const second = 'c'.repeat(40);
    await recordLineageReview(paths, lineage, {
      headSha: first, reportId: 'report-1', status: 'fail',
      blockingFindings: [{ key: 'k1', title: 'Defect', file: 'src/a.ts', priority: 'P2' }],
      lateDiscoveries: 0,
    });
    // A forced rerun of the same SHA replaces its record instead of counting twice.
    await recordLineageReview(paths, lineage, {
      headSha: first, reportId: 'report-1-forced', status: 'fail',
      blockingFindings: [{ key: 'k1', title: 'Defect', file: 'src/a.ts', priority: 'P2' }],
    });
    await recordLineageReview(paths, lineage, { headSha: second, reportId: 'report-2', status: 'pass', lateDiscoveries: 1 });

    const reviews = await readLineageReviews(paths, lineage);
    expect(reviews.map((review) => [review.headSha, review.status, review.reportId])).toEqual([
      [first, 'fail', 'report-1-forced'],
      [second, 'pass', 'report-2'],
    ]);
    expect(reviews[0].blockingFindings).toEqual([{ key: 'k1', title: 'Defect', file: 'src/a.ts', priority: 'P2' }]);
    expect(reviews[1].lateDiscoveries).toBe(1);
    await expect(readLineagePassHeads(paths, lineage)).resolves.toEqual([second]);
    await expect(readLineageReviews(paths, { ...lineage, branch: 'codex/other' })).resolves.toEqual([]);
    // A disposition keeps a bounded rename history.
    await recordDisposition(paths, lineage, {
      key: 'k-prev', title: 'T', file: 'src/final.ts', priority: 'P2', reason: 'a reason long enough', headSha: 'e'.repeat(40),
      previousFiles: ['src/old.ts', 'src/mid.ts', 42 as unknown as string],
    });
    expect((await readDispositions(paths, lineage)).get('k-prev')?.previousFiles).toEqual(['src/old.ts', 'src/mid.ts']);
    // The branch's reviewed heads are visible across policy digests and versions.
    const bumped = { ...lineage, gateVersion: '9.9.9', policyDigest: 'other' };
    await recordLineageReview(paths, bumped, { headSha: 'e'.repeat(40), reportId: 'report-b', status: 'fail', reviewedHeads: 7 });
    // A lessons-only digest change is the same versions: not a bump. A legacy
    // pass record (gate <= 1.7.0) counts as a reviewed head with count 0.
    const lessonsOnly = { ...lineage, policyDigest: 'lessons-changed' };
    await recordLineageReview(paths, lessonsOnly, { headSha: 'f'.repeat(40), reportId: 'report-l', status: 'pass' });
    const { atomicWriteJson: writeLegacy } = await import('../storage.mjs');
    await writeLegacy(path.join(paths.convergence, 'legacy-pass.json'), { type: 'lineage-pass', lineage: bumped, headSha: 'g'.repeat(40), reportId: 'r', createdAt: '2026-12-31T00:00:00.000Z' });
    const branchWide = await readBranchReviews(paths, lineage);
    expect(branchWide.map((review) => [review.headSha[0], review.samePolicy, review.versionBump, review.reviewedHeads])).toEqual([
      ['b', true, false, 0], ['c', true, false, 0], ['e', false, true, 7], ['f', false, false, 0], ['g', false, true, 0],
    ]);
    await expect(readBranchReviews(paths, { ...lineage, branch: 'codex/other' })).resolves.toEqual([]);
    // The reviewed-head count travels in each record; a legacy record reads as 0.
    await recordLineageReview(paths, lineage, { headSha: 'd'.repeat(40), reportId: 'report-3', status: 'fail', reviewedHeads: 3 });
    const counted = await readLineageReviews(paths, lineage);
    expect(counted.map((review) => review.reviewedHeads)).toEqual([0, 0, 3]);
    // Equal timestamps order by head SHA, never by enumeration order.
    const { atomicWriteJson: writeRaw } = await import('../storage.mjs');
    const { hashText } = await import('../storage.mjs');
    const prefix = `${hashText(JSON.stringify(lineage), 40)}-`;
    for (const head of ['f'.repeat(40), 'e'.repeat(40)]) {
      await writeRaw(path.join(paths.convergence, `${prefix}${hashText(head, 40)}.json`), {
        schemaVersion: 2, type: 'lineage-review', createdAt: '2026-09-02T00:00:00.000Z', lineage, headSha: head, reportId: 'r', status: 'pass', blockingFindings: [], lateDiscoveries: 0,
      });
    }
    const equal = (await readLineageReviews(paths, lineage)).filter((review) => review.createdAt === '2026-09-02T00:00:00.000Z');
    expect(equal.map((review) => review.headSha[0])).toEqual(['e', 'f']);
  });

  it('still reads lineage PASS records written by gate 1.7.0', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const lineage = {
      repository: 'repo', baseSha: 'a'.repeat(40), policyDigest: POLICY_DIGEST,
      charterVersion: CHARTER_VERSION, gateVersion: GATE_VERSION, branch: 'codex/feature',
    };
    const first = 'b'.repeat(40);
    await recordLineagePass(paths, lineage, { headSha: first, reportId: 'report-pass' });
    await expect(readLineagePassHeads(paths, lineage)).resolves.toEqual([first]);
    await expect(readLineageReviews(paths, lineage)).resolves.toMatchObject([{ headSha: first, status: 'pass' }]);
  });

  it('serializes disposition batches per lineage with a reclaimable lock', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const lineage = {
      repository: 'repo', baseSha: 'a'.repeat(40), policyDigest: POLICY_DIGEST,
      charterVersion: CHARTER_VERSION, gateVersion: GATE_VERSION, branch: 'codex/feature',
    };
    const release = await acquireDispositionLock(paths, lineage);
    await expect(acquireDispositionLock(paths, lineage)).rejects.toThrow(/holds this lineage/);
    // Another lineage is independent.
    const other = await acquireDispositionLock(paths, { ...lineage, branch: 'codex/other' });
    await other();
    await release();
    // A stale lock (dead holder) is reclaimed; a live holder keeps it within
    // the maximum hold, and loses it past that (a reused pid cannot strand
    // the lineage); a predecessor's release never unlinks a successor.
    const held = await acquireDispositionLock(paths, lineage, { now: () => Date.now() - 10 * 60 * 1000 });
    await expect(acquireDispositionLock(paths, lineage, { isAlive: () => true })).rejects.toThrow(/holds this lineage/);
    const expired = await acquireDispositionLock(paths, lineage, { isAlive: () => true, maxHoldMs: 5 * 60 * 1000 });
    await expired();
    const heldForReclaim = await acquireDispositionLock(paths, lineage, { now: () => Date.now() - 10 * 60 * 1000 });
    const reclaimed = await acquireDispositionLock(paths, lineage, { isAlive: () => false });
    await held();
    await heldForReclaim();
    await expect(acquireDispositionLock(paths, lineage, { isAlive: () => true })).rejects.toThrow(/holds this lineage/);
    await reclaimed();
    const fresh = await acquireDispositionLock(paths, lineage);
    await fresh();
  });

  it('reclaims an unreadable lock only after its TTL and never deletes a successor', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const lineage = {
      repository: 'repo', baseSha: 'a'.repeat(40), policyDigest: POLICY_DIGEST,
      charterVersion: CHARTER_VERSION, gateVersion: GATE_VERSION, branch: 'codex/feature',
    };
    const lockName = async () => (await readdir(paths.dispositions)).find((name) => name.endsWith('batch.lock'));
    // A partial record (caught between creation and its JSON) is a live lock
    // until the TTL passes; a dead-holder record does not need the TTL.
    const probe = await acquireDispositionLock(paths, lineage);
    const target = path.join(paths.dispositions, (await lockName())!);
    await probe();
    await writeFile(target, '{', 'utf8');
    await expect(acquireDispositionLock(paths, lineage)).rejects.toThrow(/holds this lineage/);
    // An unreadable record that changed since it was observed (a successor
    // caught mid-write) is not the one observed: it is kept, not reclaimed.
    await expect(acquireDispositionLock(paths, lineage, {
      now: () => Date.now() + 10 * 60 * 1000,
      beforeClaim: async () => { await writeFile(target, '{"pid"', 'utf8'); },
    })).rejects.toThrow(/holds this lineage/);
    expect(await readFile(target, 'utf8')).toBe('{"pid"');
    const afterTtl = await acquireDispositionLock(paths, lineage, { now: () => Date.now() + 10 * 60 * 1000 });
    await afterTtl();
    // A successor that slipped in between the stale read and the reclaim
    // (it passed its own reclaim check before the mutex existed) is put
    // back, not deleted: the reclaimer reports the lineage as held.
    const dead = await acquireDispositionLock(paths, lineage);
    const successor = JSON.stringify({ pid: process.pid, token: 'successor', at: new Date().toISOString() });
    await expect(acquireDispositionLock(paths, lineage, {
      isAlive: () => false,
      beforeClaim: async () => {
        await dead();
        await writeFile(target, successor, 'utf8');
      },
    })).rejects.toThrow(/holds this lineage/);
    expect(JSON.parse(await readFile(target, 'utf8')).token).toBe('successor');
    await rm(target, { force: true });
    expect((await readdir(paths.dispositions)).filter((name) => name.includes('batch.lock'))).toEqual([]);
    // A live reclaim in progress blocks every acquisition; a dead one is swept.
    await writeFile(`${target}.reclaim`, JSON.stringify({ pid: process.pid, token: 'r', at: new Date().toISOString() }), 'utf8');
    await expect(acquireDispositionLock(paths, lineage)).rejects.toThrow(/holds this lineage/);
    const afterSweep = await acquireDispositionLock(paths, lineage, { isAlive: () => false });
    await afterSweep();
    expect((await readdir(paths.dispositions)).filter((name) => name.includes('batch.lock'))).toEqual([]);
    // The reclaim mutex is released only by the reclaim that wrote it: a
    // mutex replaced meanwhile (another reclaimer's) survives the finally.
    const stale = await acquireDispositionLock(paths, lineage);
    const otherReclaim = JSON.stringify({ pid: 999999, token: 'other-reclaim', at: new Date().toISOString() });
    await expect(acquireDispositionLock(paths, lineage, {
      isAlive: (pid: number) => pid === 999999,
      beforeClaim: async () => {
        await writeFile(`${target}.reclaim`, otherReclaim, 'utf8');
      },
    })).rejects.toThrow(/pid 999999/);
    expect(JSON.parse(await readFile(`${target}.reclaim`, 'utf8')).token).toBe('other-reclaim');
    await rm(`${target}.reclaim`, { force: true });
    await stale();
    expect((await readdir(paths.dispositions)).filter((name) => name.includes('batch.lock'))).toEqual([]);
  });

  it('records author deferrals by finding identity within a lineage and requires a real reason', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const lineage = {
      repository: 'repo', baseSha: 'a'.repeat(40), policyDigest: POLICY_DIGEST,
      charterVersion: CHARTER_VERSION, gateVersion: GATE_VERSION, branch: 'codex/feature',
    };
    await expect(recordDisposition(paths, lineage, {
      key: 'k1', title: 'Defect', file: 'src/a.ts', priority: 'P3', reason: 'short', headSha: 'b'.repeat(40),
    })).rejects.toThrow(/minimum 12 characters/);
    await recordDisposition(paths, lineage, {
      key: 'k1', title: 'Defect', file: 'src/a.ts', priority: 'P3',
      reason: 'Covered by the follow-up brief docs/bugs/open/x.md.', headSha: 'b'.repeat(40),
    });
    const deferrals = await readDispositions(paths, lineage);
    expect(deferrals.get('k1')).toMatchObject({ key: 'k1', priority: 'P3', headSha: 'b'.repeat(40), source: 'author' });
    expect((await readDispositions(paths, { ...lineage, branch: 'codex/other' })).size).toBe(0);
  });

  it('finds the newest report for an exact identity and summarizes stage timing per round', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const identity = attestationIdentity({
      repository: 'repo', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), policyDigest: POLICY_DIGEST,
    });
    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 0, minutes)).toISOString();
    await writeReport(paths, {
      id: 'older', identity, createdAt: at(0), round: 'full', status: 'fail',
      stages: [{ name: 'shards', startedAt: at(0), ms: 6 * 60_000 }, { name: 'adjudication', startedAt: at(6), ms: 4 * 60_000 }],
    });
    await writeReport(paths, {
      id: 'newer', identity, createdAt: at(20), round: 'follow-up', status: 'pass',
      stages: [{ name: 'shards', startedAt: at(20), ms: 2 * 60_000 }],
    });
    await writeReport(paths, { id: 'other', identity: { ...identity, headSha: 'c'.repeat(40) }, createdAt: at(30), status: 'pass', stages: [] });

    expect((await findLatestReportForIdentity(paths, identity))?.id).toBe('newer');
    expect(await findLatestReportForIdentity(paths, { ...identity, headSha: 'd'.repeat(40) })).toBeNull();
    const timing = await reviewTimingSummary(paths);
    expect(timing.full).toEqual({ count: 1, averageMinutes: 10, maxMinutes: 10 });
    expect(timing.followUp).toEqual({ count: 1, averageMinutes: 2, maxMinutes: 2 });
    expect(timing.stages).toEqual({
      shards: { count: 2, averageSeconds: 240 },
      adjudication: { count: 1, averageSeconds: 240 },
    });
  });

  it('clears a technical outcome that survives only in its recovery copy', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const identity = attestationIdentity({
      repository: 'repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      policyDigest: POLICY_DIGEST,
    });
    const target = path.join(paths.outcomes, attestationFileName(identity));
    await writeFile(`${target}.previous`, JSON.stringify({ status: 'error', attempts: 3 }));

    await expect(clearTechnicalErrorOutcomes(paths)).resolves.toBe(1);
    await expect(access(`${target}.previous`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a recovery sibling before revoking an attestation', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const identity = attestationIdentity({
      repository: 'repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      policyDigest: POLICY_DIGEST,
    });
    await writeAttestation(paths, identity, { summary: 'clean', risk: 'medium' });
    const target = path.join(paths.attestations, attestationFileName(identity));
    await copyFile(target, `${target}.previous`);

    await removeAttestation(paths, identity);

    await expect(readAttestation(paths, identity)).resolves.toBeNull();
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(`${target}.previous`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows only one daemon to claim a request', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await submitRequest(paths, { type: 'gate', options: { head: 'HEAD' } });
    const claims = await Promise.all([claimNextRequest(paths), claimNextRequest(paths)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await completeRequest(paths, claim, { status: 'pass' });
  });

  it('enforces queue capacity atomically across simultaneous submitters', async () => {
    const paths = await ensureState(await temporaryDirectory());

    const attempts = await Promise.allSettled([
      submitRequest(paths, { type: 'gate', options: { head: 'first' } }),
      submitRequest(paths, { type: 'gate', options: { head: 'second' } }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(await readdir(paths.requests)).toHaveLength(1);
  });

  it('claims queued requests by persisted creation time rather than random id', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await atomicWriteJson(path.join(paths.requests, 'z-later.json'), {
      id: 'z-later', createdAt: '2026-08-03T12:00:01.000Z', type: 'gate',
    });
    await atomicWriteJson(path.join(paths.requests, 'a-earlier.json'), {
      id: 'a-earlier', createdAt: '2026-08-03T12:00:00.000Z', type: 'gate',
    });

    const claim = await claimNextRequest(paths);

    expect(claim?.request.id).toBe('a-earlier');
  });

  it('keeps bypass audit evidence outside the routine telemetry FIFO', async () => {
    const paths = await ensureState(await temporaryDirectory());

    await recordEvent(paths, { type: 'watcher-loop-error', message: 'retry' });
    await recordEvent(paths, { type: 'emergency-bypass', headSha: 'a'.repeat(40) });
    await recordEvent(paths, { type: 'ref-deletion', remoteTipSha: 'b'.repeat(40) });

    expect(await readdir(paths.events)).toHaveLength(1);
    expect(await readdir(paths.auditEvents)).toHaveLength(2);
  });

  it('fails closed on a corrupt pause record while resume repairs it', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await writeFile(paths.paused, '{');

    await expect(readPause(paths)).rejects.toThrow('npx --no-install rove-sentinel resume');
    await expect(resumeGate(paths)).resolves.toMatchObject({ corrupt: true });
    await expect(readPause(paths)).resolves.toBeNull();
  });

  it('cancels an unclaimed request when watcher startup fails', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const request = await submitRequest(paths, { type: 'gate', options: { head: 'HEAD' } });
    await cancelQueuedRequest(paths, request.id);
    expect(await claimNextRequest(paths)).toBeNull();
  });

  it('recovers an interrupted claim when a new daemon owns the queue', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const request = await submitRequest(paths, { type: 'gate', options: { head: 'HEAD' } });
    const claim = await claimNextRequest(paths);
    expect(claim?.request.id).toBe(request.id);
    expect(await recoverClaims(paths)).toBe(1);
    expect((await claimNextRequest(paths))?.request.id).toBe(request.id);
  });

  it('does not rerun a claimed request whose result was already written', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const request = await submitRequest(paths, { type: 'gate', options: { head: 'HEAD' } });
    expect(await claimNextRequest(paths)).not.toBeNull();
    await atomicWriteJson(path.join(paths.results, `${request.id}.json`), { status: 'pass' });
    expect(await recoverClaims(paths)).toBe(0);
    expect(await claimNextRequest(paths)).toBeNull();
  });

  it('quarantines an unparsable interrupted claim instead of wedging every watcher start', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await writeFile(path.join(paths.claims, 'request.json.123.owner.claim'), '{');
    await writeFile(path.join(paths.claims, 'request.json.lock'), '123\n');

    await expect(recoverClaims(paths)).resolves.toBe(0);
    await expect(readdir(paths.claims)).resolves.toEqual([]);
    await expect(waitForResult(paths, 'request', {
      timeoutMs: 50,
      pollMs: 5,
    })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('persisted claim became unreadable'),
    });
  });

  it('lets a waiting hook abort promptly so its queued request can be cancelled', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const request = await submitRequest(paths, { type: 'gate', options: { head: 'HEAD' } });

    await expect(waitForResult(paths, request.id, {
      timeoutMs: 1_000,
      pollMs: 5,
      shouldCancel: async () => 'operator paused reviews',
    })).rejects.toThrow('operator paused reviews');
    await cancelQueuedRequest(paths, request.id);
    await expect(claimNextRequest(paths)).resolves.toBeNull();
  });

  it('aborts the real polling sleep instead of leaving a background timer chain', async () => {
    const paths = await ensureState(await temporaryDirectory());
    const controller = new AbortController();
    const pending = waitForResult(paths, 'missing-request', {
      timeoutMs: 10_000,
      pollMs: 5_000,
      signal: controller.signal,
    });

    controller.abort(new Error('hook interrupted'));

    await expect(pending).rejects.toThrow('hook interrupted');
  });

  it('prunes old and excess state files', async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 5; index += 1) {
      const target = path.join(directory, `${index}.json`);
      await writeFile(target, '{}');
      const seconds = (Date.now() - index * 1000) / 1000;
      await import('node:fs/promises').then(({ utimes }) => utimes(target, seconds, seconds));
    }
    await pruneDirectory(directory, { maxFiles: 2, maxAgeMs: 60_000 });
    expect(await readdir(directory)).toHaveLength(2);
  });

  it('bounds auxiliary recovery files without letting them evict primary records', async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(directory, `${index}.json`), '{}');
      await writeFile(path.join(directory, `${index}.json.previous`), '{}');
      await writeFile(path.join(directory, `${index}.tmp`), '{}');
    }

    await pruneDirectory(directory, { maxFiles: 2, maxAgeMs: 60_000 });
    const entries = await readdir(directory);
    expect(entries.filter((entry) => entry.endsWith('.json'))).toHaveLength(2);
    expect(entries.filter((entry) => entry.endsWith('.json.previous') || entry.endsWith('.tmp'))).toHaveLength(2);
  });

  it('restores the previous value when the Windows-style replacement rename fails', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'state.json');
    const temp = path.join(directory, 'state.json.tmp');
    await writeFile(target, 'old value');
    await writeFile(temp, 'new value');

    await expect(replaceExistingFile(target, temp, {
      async move(source, destination) {
        if (source === temp) {
          const error = new Error('replacement blocked');
          Object.assign(error, { code: 'EPERM' });
          throw error;
        }
        await rename(source, destination);
      },
    })).rejects.toThrow('replacement blocked');

    await expect(readFile(target, 'utf8')).resolves.toBe('old value');
    await expect(readFile(temp, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads but never consumes a writer-owned recovery copy when the target is absent', async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, 'state.json');
    await writeFile(`${target}.previous`, '{"status":"pass"}\n');

    await expect(readJson(target)).resolves.toEqual({ status: 'pass' });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${target}.previous`, 'utf8')).resolves.toContain('"status"');

    await atomicWriteJson(target, { status: 'new' });
    await expect(readJson(target)).resolves.toEqual({ status: 'new' });
    await expect(access(`${target}.previous`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
