import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHARTER_VERSION, GATE_VERSION, LIMITS } from '../constants.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { acquireUpdateLease } from '../maintenance.mjs';
import {
  assertReviewIdentity,
  buildGateRequestOptions,
  guiEvidenceRefusal,
  nonPassRemediation,
  pushRemoteNameForHook,
  runPrePush,
  submitAndStartReview,
  unattestedRefusal,
  waitForHookResult,
  waitingWatcherProblem,
} from '../prepush.mjs';
import {
  attestationFileName,
  attestationIdentity,
  atomicWriteJson,
  ensureState,
  pauseGate,
  removeStoredJson,
  writeAttestation,
} from '../storage.mjs';

// These integration tests create real repositories and child Git processes.
// Windows process startup and filesystem-handle release can exceed Vitest's
// 5-second default while unrelated test files run concurrently.
if (process.platform === 'win32') {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
}

// A real 1x1 PNG (signature + IHDR + IDAT + IEND), the smallest file the
// byte check must accept.
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const temporaryDirectories: string[] = [];

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-prepush-test-'));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-prepush-state-'));
  temporaryDirectories.push(root, stateRoot);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/rove.git');
  git(root, 'remote', 'add', 'upstream', 'https://github.com/example/fork.git');
  git(root, 'commit', '--allow-empty', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'commit', '--allow-empty', '-m', 'head');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', head);
  git(root, 'update-ref', 'refs/remotes/upstream/main', head);
  const policy = reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n', config: { guiEvidence: 'rove' } });
  const paths = await ensureState(stateRoot);
  await atomicWriteJson(paths.policy, policy);
  return { root, stateRoot, base, head, policy };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('shared review pre-push enforcement', () => {
  it('keeps an in-flight push on its engine and releases the update fence afterward', async () => {
    const { root, stateRoot, head } = await makeRepository();
    const paths = await ensureState(stateRoot);
    let observed = false;
    await runPrePush({ repoRoot: root, stateRoot, remoteName: 'origin',
      input: `(delete) ${'0'.repeat(40)} refs/heads/old ${head}\n`,
      writeAuditEvent: async () => {
        observed = true;
        await expect(acquireUpdateLease(paths, {})).rejects.toThrow('review is active');
      }, pruneAuditEvents: async () => {},
    });
    expect(observed).toBe(true);
    const release = await acquireUpdateLease(paths, {});
    await release();
  });

  it('falls back to the configured remote when Git passes a raw push URL', () => {
    expect(pushRemoteNameForHook('https://github.com/example/rove.git', 'origin')).toBe('origin');
    expect(pushRemoteNameForHook('git@github.com:example/rove.git', 'origin')).toBe('origin');
    expect(pushRemoteNameForHook('upstream', 'origin')).toBe('upstream');
  });

  it('rejects a PASS produced for a stale gate identity', () => {
    const expected = attestationIdentity({
      repository: 'repo', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      policyDigest: 'd'.repeat(64),
    });
    expect(() => assertReviewIdentity(
      { ...expected, gateVersion: '0.9.0' },
      expected,
    )).toThrow('mismatched gateVersion');
  });

  it('gives the native-evidence command for that distinct blocking state', () => {
    expect(nonPassRemediation('needs_native_evidence')).toContain('--native-evidence');
    expect(nonPassRemediation('fail')).not.toContain('--native-evidence');
  });

  it('submits only immutable SHAs from the attestation identity', () => {
    const identity = attestationIdentity({
      repository: 'repo', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      policyDigest: 'd'.repeat(64),
    });
    expect(buildGateRequestOptions({
      repoRoot: 'C:\\repo', identity, branch: 'codex/example',
    })).toEqual({
      repoRoot: 'C:\\repo',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      branch: 'codex/example',
      author: 'codex',
    });
  });

  it('cancels a queued review when detached watcher startup fails', async () => {
    const cancel = vi.fn(async () => {});
    const context = { repoRoot: 'C:\\repo', stateRoot: 'C:\\state', paths: {} };

    await expect(submitAndStartReview(context, { head: 'a'.repeat(40) }, {
      submit: async () => ({ id: 'request-id' }),
      clearError: async () => {},
      start: async () => { throw new Error('spawn denied'); },
      cancel,
    })).rejects.toThrow('spawn denied');

    expect(cancel).toHaveBeenCalledWith(context.paths, 'request-id');
  });

  it('cancels an unclaimed request when the hook is interrupted', async () => {
    const signalHost = new EventEmitter();
    const cancel = vi.fn(async () => {});
    let observedSignal: AbortSignal | undefined;
    const pending = waitForHookResult({}, 'request-id', {}, {
      wait: async (_paths, _requestId, options) => {
        observedSignal = options.signal;
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
      cancel,
      signalHost,
    });

    signalHost.emit('SIGINT');

    await expect(pending).rejects.toThrow('interrupted by SIGINT');
    expect(observedSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith({}, 'request-id');
    expect(signalHost.listenerCount('SIGINT')).toBe(0);
    expect(signalHost.listenerCount('SIGTERM')).toBe(0);
  });

  it('stops waiting when the watcher dies or reports an internal loop error', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-prepush-state-'));
    temporaryDirectories.push(stateRoot);
    const paths = await ensureState(stateRoot);
    await expect(waitingWatcherProblem(paths)).resolves.toContain('watcher stopped');

    const ownerToken = 'owner';
    await atomicWriteJson(paths.lock, {
      pid: process.pid, ownerToken, startedAt: new Date().toISOString(),
    });
    await atomicWriteJson(paths.heartbeat, {
      pid: process.pid,
      ownerToken,
      repoRoot: 'C:\\repo',
      gateVersion: GATE_VERSION,
      charterVersion: CHARTER_VERSION,
      policyDigest: 'd'.repeat(64),
      at: new Date().toISOString(),
    });
    await expect(waitingWatcherProblem(paths, 'd'.repeat(64))).resolves.toBeNull();
    await expect(waitingWatcherProblem(paths, 'e'.repeat(64))).resolves.toContain('incompatible');

    await atomicWriteJson(paths.heartbeat, {
      pid: process.pid,
      ownerToken,
      repoRoot: 'C:\\repo',
      gateVersion: GATE_VERSION,
      charterVersion: CHARTER_VERSION,
      policyDigest: 'd'.repeat(64),
      activity: 'error',
      error: 'queue rename failed',
      at: new Date().toISOString(),
    });
    await expect(waitingWatcherProblem(paths)).resolves.toContain('queue rename failed');
  });

  it('keeps the exact-SHA outage bypass reachable while automatic work is paused', async () => {
    const repository = await makeRepository();
    await removeStoredJson((await ensureState(repository.stateRoot)).policy);
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {
        ROVE_REVIEW_BYPASS_SHA: repository.head,
        ROVE_REVIEW_BYPASS_REASON: 'provider outage blocks an urgent push',
      },
      output: () => {},
    })).resolves.toEqual({ reviewed: 0, bypassed: 1 });
  });

  it('mints a skip attestation for ordinary docs-only pushes without a daemon', async () => {
    const repository = await makeRepository();
    await writeFile(path.join(repository.root, 'docs-note.md'), '# Note\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'docs');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    const input = `refs/heads/codex/docs ${head} refs/heads/codex/docs ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).resolves.toEqual({ reviewed: 1, bypassed: 0 });
  });

  it('refuses a GUI diff without committed evidence before any reviewer or attestation read', async () => {
    // visual-redesign-plan.md §5.1: the hook reads committed files only. A
    // .svelte change with no docs/design/reviews/<slug>/*.png in the diff is
    // refused at planning time — ZERO attestation reads and no docs-skip
    // attempt is the observable that it fired before the review machinery.
    const repository = await makeRepository();
    await mkdir(path.join(repository.root, 'src', 'lib', 'components'), { recursive: true });
    await writeFile(
      path.join(repository.root, 'src', 'lib', 'components', 'PaneHeader.svelte'),
      '<button data-control="pane.split">Split</button>\n',
    );
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'gui');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    const input = `refs/heads/claude/redesign ${head} refs/heads/claude/redesign ${'0'.repeat(40)}\n`;
    let reads = 0;
    let docsSkips = 0;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      readAttestationFor: async () => { reads += 1; return null; },
      attestDocsSkip: async () => { docsSkips += 1; return null; },
    })).rejects.toThrow(/refused claude\/redesign before any reviewer ran[\s\S]*docs\/design\/reviews\/claude-redesign\/[\s\S]*pnpm design:capture[\s\S]*data-control="pane\.split"[\s\S]*docs\/design\/control-registry\.md/);
    expect(reads).toBe(0);
    expect(docsSkips).toBe(0);
  });

  it('lets a GUI diff through once its screenshot and registry row are committed', async () => {
    // Positive control for the refusal above: the same diff plus its evidence
    // must reach the ordinary path (here: the paused-gate refusal, which
    // proves the evidence check returned null rather than failing for an
    // unrelated reason).
    const repository = await makeRepository();
    await mkdir(path.join(repository.root, 'src', 'lib', 'components'), { recursive: true });
    await mkdir(path.join(repository.root, 'docs', 'design', 'reviews', 'claude-redesign'), { recursive: true });
    await writeFile(
      path.join(repository.root, 'src', 'lib', 'components', 'PaneHeader.svelte'),
      '<button data-control="pane.split">Split</button>\n',
    );
    await writeFile(path.join(repository.root, 'docs', 'design', 'reviews', 'claude-redesign', 'header.png'), REAL_PNG);
    await writeFile(path.join(repository.root, 'docs', 'design', 'reviews', 'claude-redesign', 'REVIEW.md'), '# review\n');
    await writeFile(
      path.join(repository.root, 'docs', 'design', 'control-registry.md'),
      '| `pane.split` | pane-header | trailing | 1 | always | none | — |\n',
    );
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'gui with evidence');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');
    const input = `refs/heads/claude/redesign ${head} refs/heads/claude/redesign ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).rejects.toThrow('Shared review gate is paused');
  });

  it('classifies the pushed ref by its type: a branch named tag/release follows the branch rule, a real tag the tag rule', async () => {
    // The same GUI commit with its screenshot under a folder that is NOT the
    // branch slug (tag-release). Pushed as refs/heads/tag/release it must be
    // refused under the branch rule; pushed as refs/tags/v1 the any-folder
    // tag rule accepts it and the push reaches the ordinary path (the paused
    // gate, which proves the evidence check returned null).
    const repository = await makeRepository();
    await mkdir(path.join(repository.root, 'src', 'lib', 'components'), { recursive: true });
    await mkdir(path.join(repository.root, 'docs', 'design', 'reviews', 'codex-other'), { recursive: true });
    await writeFile(path.join(repository.root, 'src', 'lib', 'components', 'PaneHeader.svelte'), '<button>Split</button>\n');
    await writeFile(path.join(repository.root, 'docs', 'design', 'reviews', 'codex-other', 'header.png'), REAL_PNG);
    await writeFile(path.join(repository.root, 'docs', 'design', 'reviews', 'codex-other', 'REVIEW.md'), '# review\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'gui with evidence under another folder');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input: `refs/heads/tag/release ${head} refs/heads/tag/release ${'0'.repeat(40)}\n`,
      env: {},
      output: () => {},
    })).rejects.toThrow(/refused tag\/release before any reviewer ran[\s\S]*docs\/design\/reviews\/tag-release\/[\s\S]*belong to a different branch/);

    git(repository.root, 'tag', '-a', 'v1', '-m', 'release', head);
    const tagObject = git(repository.root, 'rev-parse', 'refs/tags/v1');
    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input: `refs/tags/v1 ${tagObject} refs/tags/v1 ${'0'.repeat(40)}\n`,
      env: {},
      output: () => {},
    })).rejects.toThrow('Shared review gate is paused');
  });

  it('keeps the exact-SHA bypass and deletions outside the GUI evidence check', async () => {
    const repository = await makeRepository();
    await mkdir(path.join(repository.root, 'src'), { recursive: true });
    await writeFile(path.join(repository.root, 'src', 'app.css'), 'body {}\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'gui');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    let checks = 0;
    const checkGuiEvidence = async () => { checks += 1; return 'must not be consulted'; };
    const input = [
      `refs/heads/claude/redesign ${head} refs/heads/claude/redesign ${'0'.repeat(40)}`,
      `(delete) ${'0'.repeat(40)} refs/heads/claude/gone ${repository.head}`,
    ].join('\n');

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {
        ROVE_REVIEW_BYPASS_SHA: head,
        ROVE_REVIEW_BYPASS_REASON: 'provider outage blocks an urgent push',
      },
      output: () => {},
      checkGuiEvidence,
    })).resolves.toEqual({ reviewed: 0, bypassed: 1 });
    expect(checks).toBe(0);
  });

  it('does not auto-skip review-policy Markdown', async () => {
    const repository = await makeRepository();
    await mkdir(path.join(repository.root, 'docs'), { recursive: true });
    await writeFile(path.join(repository.root, 'docs', 'shared-review-charter.md'), '# Charter\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'policy');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');
    const input = `refs/heads/codex/policy ${head} refs/heads/codex/policy ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).rejects.toThrow('Shared review gate is paused');
  });

  it('continues to block an unattested push while paused', async () => {
    const repository = await makeRepository();
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).rejects.toThrow('Shared review gate is paused');
  });

  it('treats corrupt paused evidence as unattested and removes it', async () => {
    const repository = await makeRepository();
    const paths = await ensureState(repository.stateRoot);
    await pauseGate(paths, 'provider outage');
    const identity = attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.head,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    });
    const target = path.join(paths.attestations, attestationFileName(identity));
    await writeFile(target, '{');
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).rejects.toThrow('Shared review gate is paused');
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows an exact attested head to push without starting automatic work while paused', async () => {
    const repository = await makeRepository();
    const paths = await ensureState(repository.stateRoot);
    await pauseGate(paths, 'provider outage');
    const identity = attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.head,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    });
    await writeAttestation(paths, identity, { risk: 'skip', mode: 'skipped', summary: 'Already attested.' });
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).resolves.toEqual({ reviewed: 1, bypassed: 0 });
  });

  it('allows an exact attested head to push without a watcher while unpaused', async () => {
    const repository = await makeRepository();
    const paths = await ensureState(repository.stateRoot);
    const identity = attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.head,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    });
    await writeAttestation(paths, identity, { risk: 'skip', mode: 'skipped', summary: 'Already attested.' });
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).resolves.toEqual({ reviewed: 1, bypassed: 0 });
  });

  it('refuses an attested PASS whose verified advisories have no disposition, then honours a recorded deferral', async () => {
    const repository = await makeRepository();
    const paths = await ensureState(repository.stateRoot);
    const identity = attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.head,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    });
    const lineage = {
      repository: identity.repository, baseSha: identity.baseSha, policyDigest: identity.policyDigest,
      charterVersion: identity.charterVersion, gateVersion: identity.gateVersion, branch: 'codex/test',
    };
    await writeAttestation(paths, identity, {
      risk: 'high',
      summary: 'Passed with one verified advisory.',
      reportId: 'report-1',
      lineage,
      findings: [{
        candidate_id: 'codex-0-0', title: 'Stale handler', file: 'src/a.ts', line: 3, priority: 'P3',
        disposition: 'advisory', adjudicatedDisposition: 'verified', enforcement: 'advisory',
        requiresDisposition: true, findingKey: 'src/a.ts\u0000stale handler', reason: 'Narrow input.',
      }],
    });
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;
    const run = () => runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    });
    await expect(run()).rejects.toThrow(/no recorded disposition[\s\S]*npx --no-install rove-sentinel defer --head/);
    // The same commit pushed on another branch cannot reuse this lineage.
    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input: `refs/heads/codex/other ${repository.head} refs/heads/codex/other ${'0'.repeat(40)}\n`,
      env: {},
      output: () => {},
    })).rejects.toThrow(/reviewed on branch codex\/test, not codex\/other/);

    const { recordDisposition } = await import('../storage.mjs');
    await recordDisposition(paths, lineage, {
      key: 'src/a.ts\u0000stale handler', title: 'Stale handler', file: 'src/a.ts', priority: 'P3',
      reason: 'Tracked in docs/bugs/open/stale-handler.md.', headSha: repository.head,
    });
    await expect(run()).resolves.toEqual({ reviewed: 1, bypassed: 0 });
  });

  it('peels and enforces an annotated tag at its exact commit', async () => {
    const repository = await makeRepository();
    const paths = await ensureState(repository.stateRoot);
    await pauseGate(paths, 'provider outage');
    git(repository.root, 'tag', '-a', 'v1', '-m', 'release', repository.head);
    const tagObject = git(repository.root, 'rev-parse', 'refs/tags/v1');
    await writeAttestation(paths, attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.head,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    }), { risk: 'skip', mode: 'skipped', summary: 'Already attested.' });
    const input = `refs/tags/v1 ${tagObject} refs/tags/v1 ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).resolves.toEqual({ reviewed: 1, bypassed: 0 });
  });

  it('keeps canonical review identity when the push targets a different configured remote', async () => {
    const repository = await makeRepository();
    const paths = await ensureState(repository.stateRoot);
    await pauseGate(paths, 'provider outage');
    await writeAttestation(paths, attestationIdentity({
      repository: 'https://github.com/example/rove',
      baseSha: repository.head,
      headSha: repository.head,
      policyDigest: repository.policy.policyDigest,
    }), { risk: 'skip', mode: 'skipped', summary: 'Already attested.' });
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      remoteName: 'upstream',
      input,
      env: {},
      output: () => {},
    })).resolves.toEqual({ reviewed: 1, bypassed: 0 });
  });

  it('blocks a non-fast-forward main rollback unless the exact-SHA bypass is used', async () => {
    const repository = await makeRepository();
    const input = `refs/heads/main ${repository.base} refs/heads/main ${repository.head}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).rejects.toThrow('non-fast-forward update of main');
  });

  it('blocks deleting main before Git can perform the destructive push', async () => {
    const repository = await makeRepository();
    const input = `(delete) ${'0'.repeat(40)} refs/heads/main ${repository.head}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).rejects.toThrow('blocks deletion of main');
  });

  it('covers every outcome of the unattested-ref decision, boundary included', () => {
    // The gate's own review caught that this threshold was unverified: the
    // suite exercised two missing refs, zero missing refs, and one missing ref
    // rejected earlier by the pause guard — but never ONE ref proceeding. So
    // `> 1` could become `>= 1`, blocking every ordinary first push, with the
    // whole suite still green. Each row here fails on that mutation.
    expect(unattestedRefusal([])).toBeNull();
    expect(unattestedRefusal(['codex/one'])).toBeNull();
    expect(unattestedRefusal(['codex/one', 'codex/two'])).toContain('carries 2');
    expect(unattestedRefusal(['codex/one', 'codex/two'])).toContain('codex/one, codex/two');
    const many = unattestedRefusal(['a', 'b', 'c', 'd']);
    expect(many).toContain('carries 4');
    expect(many).toContain('a, b, c, …');
  });

  it('refuses a push carrying more than one unattested ref', async () => {
    const repository = await makeRepository();
    // Each unattested ref starts its own hookWaitTimeoutMs, so admitting two
    // would let one `git push` run for twice the charter's stated bound.
    const input = [
      `refs/heads/codex/one ${repository.head} refs/heads/codex/one ${'0'.repeat(40)}`,
      `refs/heads/codex/two ${repository.head} refs/heads/codex/two ${'0'.repeat(40)}`,
    ].join('\n');

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).rejects.toThrow('one unattested ref per push');
  });

  it('does not count a ref whose PASS landed after its plan was built', async () => {
    // The count used to consult the snapshot taken while planning, so a PASS
    // written concurrently — by a `npx --no-install rove-sentinel gate` in another shell — was
    // still seen as missing and the push was falsely refused.
    const repository = await makeRepository();
    const input = [
      `refs/heads/codex/one ${repository.head} refs/heads/codex/one ${'0'.repeat(40)}`,
      `refs/heads/codex/two ${repository.head} refs/heads/codex/two ${'0'.repeat(40)}`,
    ].join('\n');
    // Null while the plans are built, a PASS from then on: exactly what a
    // `npx --no-install rove-sentinel gate` finishing in another shell looks like from here.
    // Writing the attestation up front would NOT test this — planning would
    // read it too, and the assertion would hold with or without the re-read.
    let reads = 0;
    const readAttestationFor = async () =>
      (reads++ < 2 ? null : { risk: 'skip', mode: 'skipped', summary: 'Attested meanwhile.' });

    // Asserting the RESULT, not the absence of a substring: "it did not throw
    // this particular message" would also hold if the call failed for some
    // unrelated reason, which is no evidence at all.
    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      readAttestationFor,
    })).resolves.toEqual({ reviewed: 2, bypassed: 0 });
  });

  it('honours a PASS that lands while the gate is paused', async () => {
    // The pause guard used to run on the planning-time snapshots, before the
    // refresh, so a paused gate rejected a push whose exact evidence had just
    // been written. The charter says an exact PASS stays reusable.
    const repository = await makeRepository();
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;
    let reads = 0;
    const readAttestationFor = async () =>
      (reads++ < 1 ? null : { risk: 'skip', mode: 'skipped', summary: 'Attested meanwhile.' });

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      readAttestationFor,
    })).resolves.toEqual({ reviewed: 1, bypassed: 0 });
  });

  it('counts only refs that need a review, so deletions still batch freely', async () => {
    // Positive control for the refusal above: it must not fire on refs that
    // never reach a wait at all, or an ordinary cleanup push would be blocked.
    const repository = await makeRepository();
    const input = [
      `(delete) ${'0'.repeat(40)} refs/heads/codex/gone ${repository.head}`,
      `(delete) ${'0'.repeat(40)} refs/heads/codex/also-gone ${repository.head}`,
    ].join('\n');

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
    })).resolves.toEqual({ reviewed: 0, bypassed: 0 });
  });

  it('refuses an over-wide ordinary push before planning any ref', async () => {
    // Planning each ref resolves its target and merge base, so a burst push of
    // thousands of ordinary refs paid that cost for every ref the
    // one-unattested rule would refuse anyway. The bound fires BEFORE the
    // first attestation read: ZERO reads is the red-proof observable (the old
    // shape read every plan twice before refusing).
    const repository = await makeRepository();
    const count = LIMITS.maxPushCandidateRefs + 4;
    const input = Array.from({ length: count }, (_, i) =>
      `refs/heads/codex/burst-${i} ${repository.head} refs/heads/codex/burst-${i} ${'0'.repeat(40)}`,
    ).join('\n');
    let reads = 0;
    const readAttestationFor = async () => {
      reads += 1;
      return null;
    };

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      readAttestationFor,
    })).rejects.toThrow('ordinary refs per push');
    expect(reads).toBe(0);
  });

  it('re-reads the collected misses immediately before refusing them', async () => {
    // The refresh pass reads each candidate in sequence, so a PASS written
    // after an EARLIER ref's refresh was invisible to the final length check —
    // the window between a ref's last read and the decision grew with every
    // other ref planned in between. Each head here returns null on its first
    // TWO reads (snapshot + refresh — everything the old shape ever does) and
    // a PASS from its third read on. Only a decision-time re-read can see it.
    const repository = await makeRepository();
    execFileSync('git', ['commit', '--allow-empty', '-m', 'second'], { cwd: repository.root });
    const secondHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository.root })
      .toString()
      .trim();
    const input = [
      `refs/heads/codex/one ${repository.head} refs/heads/codex/one ${'0'.repeat(40)}`,
      `refs/heads/codex/two ${secondHead} refs/heads/codex/two ${'0'.repeat(40)}`,
    ].join('\n');
    const readsByHead = new Map();
    const readAttestationFor = async (_paths, identity) => {
      const key = String(identity?.headSha);
      const n = (readsByHead.get(key) ?? 0) + 1;
      readsByHead.set(key, n);
      return n >= 3 ? { risk: 'skip', mode: 'skipped', summary: 'PASS landed after both refreshes.' } : null;
    };

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      readAttestationFor,
    })).resolves.toEqual({ reviewed: 2, bypassed: 0 });
  });

  it('honours a decision-time PASS even while the gate is paused', async () => {
    // The pause guard used to test the refresh loop's collected array, so a
    // PASS discovered by the decision-time re-read still tripped it — the
    // invocation that FOUND the evidence refused, contradicting the charter's
    // reusable-evidence guarantee. Same per-head script as the unpaused case:
    // null on both reads the old shape performs, PASS from the third.
    const repository = await makeRepository();
    execFileSync('git', ['commit', '--allow-empty', '-m', 'second'], { cwd: repository.root });
    const secondHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository.root })
      .toString()
      .trim();
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');
    const input = [
      `refs/heads/codex/one ${repository.head} refs/heads/codex/one ${'0'.repeat(40)}`,
      `refs/heads/codex/two ${secondHead} refs/heads/codex/two ${'0'.repeat(40)}`,
    ].join('\n');
    const readsByHead = new Map();
    const readAttestationFor = async (_paths, identity) => {
      const key = String(identity?.headSha);
      const n = (readsByHead.get(key) ?? 0) + 1;
      readsByHead.set(key, n);
      return n >= 3 ? { risk: 'skip', mode: 'skipped', summary: 'Attested meanwhile.' } : null;
    };

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      readAttestationFor,
    })).resolves.toEqual({ reviewed: 2, bypassed: 0 });
  });

  it('runs the healing audit prune even when the push is refused early', async () => {
    // Greptile P2 on 04aa959e: paused and over-wide pushes threw BEFORE the
    // try that owns the unconditional prune, so repeated refusals could leave
    // the audit ledger above its bound with no healing pass. Both early
    // refusal shapes must still prune exactly once.
    const repository = await makeRepository();
    await pauseGate(await ensureState(repository.stateRoot), 'provider outage');
    let prunes = 0;
    const pruneAuditEvents = async () => {
      prunes += 1;
    };
    const input = `refs/heads/codex/test ${repository.head} refs/heads/codex/test ${'0'.repeat(40)}\n`;

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      readAttestationFor: async () => null,
      pruneAuditEvents,
    })).rejects.toThrow('Shared review gate is paused');
    expect(prunes).toBe(1);
  });

  it('records a deletion batch with ONE retention prune for the whole batch', async () => {
    // Every audit event used to run its own pruneDirectory — a readdir plus a
    // stat per retained file AFTER EACH of the thousands of deletions a
    // bounded stdin admits. Events are still written one per ref; only the
    // retention prune is batched.
    const repository = await makeRepository();
    const input = `${Array.from({ length: 12 }, (_, i) =>
      `(delete) ${'0'.repeat(40)} refs/heads/codex/gone-${i} ${repository.head}`,
    ).join('\n')}\n`;
    const writes = [];
    const prunes = [];
    const writeAuditEvent = async (_paths, event) => {
      writes.push(event.type);
    };
    const pruneAuditEvents = async (...args) => {
      prunes.push(args[0]);
    };

    await expect(runPrePush({
      repoRoot: repository.root,
      stateRoot: repository.stateRoot,
      input,
      env: {},
      output: () => {},
      writeAuditEvent,
      pruneAuditEvents,
    })).resolves.toEqual({ reviewed: 0, bypassed: 0 });
    expect(writes.filter((type) => type === 'ref-deletion')).toHaveLength(12);
    expect(prunes).toHaveLength(1);
  });

  describe('guiEvidenceRefusal against committed history', () => {
    async function guiRepository(registryRow = '') {
      const repository = await makeRepository();
      const { root } = repository;
      await mkdir(path.join(root, 'src', 'lib', 'components'), { recursive: true });
      await mkdir(path.join(root, 'docs', 'design', 'reviews', 'claude-redesign'), { recursive: true });
      await writeFile(path.join(root, 'docs', 'design', 'reviews', 'claude-redesign', 'old.png'), REAL_PNG);
      await writeFile(path.join(root, 'docs', 'design', 'reviews', 'claude-redesign', 'REVIEW.md'), '# review\n');
      await writeFile(
        path.join(root, 'docs', 'design', 'control-registry.md'),
        '| id | surface | zone | order | visibility | precedent | catalog action |\n|---|---|---|---|---|---|---|\n',
      );
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'base with evidence');
      const base = git(root, 'rev-parse', 'HEAD');
      await writeFile(
        path.join(root, 'src', 'lib', 'components', 'PaneHeader.svelte'),
        '<button data-control="pane.new">x</button>\n',
      );
      if (registryRow) {
        await writeFile(
          path.join(root, 'docs', 'design', 'control-registry.md'),
          `| id | surface | zone | order | visibility | precedent | catalog action |\n|---|---|---|---|---|---|---|\n${registryRow}\n`,
        );
      }
      return { ...repository, base };
    }

    it('refuses a tag whose diff carries no evidence; a reviews PNG under ANY folder passes it', async () => {
      // Git never requires a tagged commit to have been pushed through a
      // branch, so the tag cannot rely on a branch review that may never
      // have run: its own base...head diff must carry the screenshot.
      const repository = await guiRepository('| `pane.new` | pane-header | trailing | 1 | always | none | — |');
      const { root } = repository;
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'gui without evidence');
      const bare = git(root, 'rev-parse', 'HEAD');
      const refusal = await guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: bare }, branch: 'v1.0.0', refType: 'tag',
      });
      expect(refusal).toContain('refused v1.0.0 before any reviewer ran');
      expect(refusal).toContain('no .png under docs/design/reviews/<slug>/');
      // A screenshot under a folder that is NOT the tag's name (a tag has no
      // slug) is evidence for the tag.
      await mkdir(path.join(root, 'docs', 'design', 'reviews', 'codex-other'), { recursive: true });
      await writeFile(path.join(root, 'docs', 'design', 'reviews', 'codex-other', 'shot.png'), REAL_PNG);
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'tag evidence png only');
      const pngOnly = git(root, 'rev-parse', 'HEAD');
      // The tag's REVIEW.md is the one next to the PNG it carries: the
      // claude-redesign one at head does not cover codex-other/shot.png.
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: pngOnly }, branch: 'v1.0.0', refType: 'tag',
      })).resolves.toContain('docs/design/reviews/codex-other/REVIEW.md is not present at head');
      await writeFile(path.join(root, 'docs', 'design', 'reviews', 'codex-other', 'REVIEW.md'), '# review\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'tag evidence');
      const head = git(root, 'rev-parse', 'HEAD');
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: head }, branch: 'v1.0.0', refType: 'tag',
      })).resolves.toBeNull();
      // The same diff under a branch name still needs ITS folder: the
      // any-folder rule is the tag's alone.
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: head }, branch: 'claude/redesign',
      })).resolves.toContain('belong to a different branch');
    });

    it('reads every evidence PNG back at head and refuses one that is not a PNG', async () => {
      const repository = await guiRepository('| `pane.new` | pane-header | trailing | 1 | always | none | — |');
      const { root } = repository;
      const folder = path.join(root, 'docs', 'design', 'reviews', 'claude-redesign');
      await writeFile(path.join(folder, 'fake.png'), 'just text with a .png name\n');
      await writeFile(path.join(folder, 'REVIEW.md'), '# review\n\nfake.png reviewed\n');
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'gui with a fake png');
      const fakeHead = git(root, 'rev-parse', 'HEAD');
      const refusal = await guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: fakeHead }, branch: 'claude/redesign',
      });
      expect(refusal).toContain('not a readable PNG as committed at head: docs/design/reviews/claude-redesign/fake.png');
      // The real capture next to it passes, read binary-safe off the commit
      // (a UTF-8 decode would have mangled the signature byte 0x89).
      await writeFile(path.join(folder, 'fake.png'), REAL_PNG);
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'real png');
      const head = git(root, 'rev-parse', 'HEAD');
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: head }, branch: 'claude/redesign',
      })).resolves.toBeNull();
    });

    it('does not count a deleted screenshot and needs a registry row at head', async () => {
      const repository = await guiRepository();
      const { root } = repository;
      await rm(path.join(root, 'docs', 'design', 'reviews', 'claude-redesign', 'old.png'));
      // Touch the registry without adding the row.
      await writeFile(
        path.join(root, 'docs', 'design', 'control-registry.md'),
        '| id | surface | zone | order | visibility | precedent | catalog action |\n|---|---|---|---|---|---|---|\n\nnote\n',
      );
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'delete evidence, touch registry');
      const head = git(root, 'rev-parse', 'HEAD');
      const refusal = await guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: head }, branch: 'claude/redesign',
      });
      expect(refusal).toContain('DELETES screenshots under docs/design/reviews/claude-redesign/');
      expect(refusal).toContain('data-control="pane.new"');
      expect(refusal).toContain('changes in this diff but has no row');
    });

    it('passes a GUI diff whose screenshot, review and registry row are all committed in the diff', async () => {
      const repository = await guiRepository('| `pane.new` | pane-header | trailing | 1 | always | none | — |');
      const { root } = repository;
      await writeFile(path.join(root, 'docs', 'design', 'reviews', 'claude-redesign', 'new.png'), REAL_PNG);
      await writeFile(path.join(root, 'docs', 'design', 'reviews', 'claude-redesign', 'REVIEW.md'), '# review\n\nnew.png reviewed\n');
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'gui with evidence');
      const head = git(root, 'rev-parse', 'HEAD');
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: head }, branch: 'claude/redesign',
      })).resolves.toBeNull();
    });

    it('refuses a branch whose REVIEW.md is deleted or merely inherited; added or modified in the diff passes', async () => {
      const repository = await guiRepository('| `pane.new` | pane-header | trailing | 1 | always | none | — |');
      const { root } = repository;
      const review = path.join(root, 'docs', 'design', 'reviews', 'claude-redesign', 'REVIEW.md');
      // Inherited unchanged from the base commit: present at head, absent
      // from the diff — the new PNG has no review of its own.
      await writeFile(path.join(root, 'docs', 'design', 'reviews', 'claude-redesign', 'new.png'), REAL_PNG);
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'gui with png, review inherited');
      const inherited = await guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: git(root, 'rev-parse', 'HEAD') }, branch: 'claude/redesign',
      });
      expect(inherited).toContain('docs/design/reviews/claude-redesign/REVIEW.md is not added or modified in this diff');
      // Deleted (status D): refused.
      await rm(review);
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'review deleted');
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: git(root, 'rev-parse', 'HEAD') }, branch: 'claude/redesign',
      })).resolves.toContain('docs/design/reviews/claude-redesign/REVIEW.md is not added or modified in this diff');
      // Restored with the same content as base: the three-dot diff shows no
      // change, so it is still inherited, still refused.
      await writeFile(review, '# review\n');
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'review back unchanged');
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: git(root, 'rev-parse', 'HEAD') }, branch: 'claude/redesign',
      })).resolves.toContain('is not added or modified in this diff');
      // Modified in the diff (status M): passes.
      await writeFile(review, '# review\n\nnew.png reviewed\n');
      git(root, 'add', '-A', '.');
      git(root, 'commit', '-m', 'review written');
      await expect(guiEvidenceRefusal({
        repoRoot: root, identity: { baseSha: repository.base, headSha: git(root, 'rev-parse', 'HEAD') }, branch: 'claude/redesign',
      })).resolves.toBeNull();
      // Added in the diff (status A): a folder that had no review at base.
      const fresh = await makeRepository();
      await mkdir(path.join(fresh.root, 'src', 'lib', 'components'), { recursive: true });
      await mkdir(path.join(fresh.root, 'docs', 'design', 'reviews', 'claude-redesign'), { recursive: true });
      await writeFile(path.join(fresh.root, 'src', 'lib', 'components', 'PaneHeader.svelte'), '<button>x</button>\n');
      await writeFile(path.join(fresh.root, 'docs', 'design', 'reviews', 'claude-redesign', 'new.png'), REAL_PNG);
      await writeFile(path.join(fresh.root, 'docs', 'design', 'reviews', 'claude-redesign', 'REVIEW.md'), '# review\n');
      git(fresh.root, 'add', '-A', '.');
      git(fresh.root, 'commit', '-m', 'gui with fresh evidence');
      await expect(guiEvidenceRefusal({
        repoRoot: fresh.root, identity: { baseSha: fresh.base, headSha: git(fresh.root, 'rev-parse', 'HEAD') }, branch: 'claude/redesign',
      })).resolves.toBeNull();
    });
  });
});
