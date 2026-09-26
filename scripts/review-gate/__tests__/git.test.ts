import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  changedFiles,
  changedFilesWithStatus,
  createDetachedWorktree,
  defaultBaseForPush,
  diffStats,
  excludedReviewFiles,
  inferAuthor,
  isWorktreeRegistered,
  originUrl,
  parsePrePushInput,
  readPatch,
  readRecoveryOwnerMarker,
  repoSlugFromRemote,
  recoverStaleReviewResources,
  showFileAtCommit,
} from '../git.mjs';

const temporaryDirectories: string[] = [];

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

import { resolveHeadSnapshot } from '../git.mjs';

describe('review-gate git inputs', () => {
  it('accepts branch and tag updates plus deletions', () => {
    const refs = parsePrePushInput([
      `refs/heads/codex/example ${A} refs/heads/codex/example ${ZERO}`,
      `refs/heads/old ${ZERO} refs/heads/old ${B}`,
      `refs/tags/v1 ${A} refs/tags/v1 ${ZERO}`,
    ].join('\n'));
    expect(refs).toEqual([
      {
        localRef: 'refs/heads/codex/example',
        localSha: A,
        remoteRef: 'refs/heads/codex/example',
        remoteSha: ZERO,
        deletion: false,
      },
      {
        localRef: 'refs/heads/old',
        localSha: ZERO,
        remoteRef: 'refs/heads/old',
        remoteSha: B,
        deletion: true,
      },
      {
        localRef: 'refs/tags/v1',
        localSha: A,
        remoteRef: 'refs/tags/v1',
        remoteSha: ZERO,
        deletion: false,
      },
    ]);
  });

  it('uses the remote head as the direct-main base and origin/main otherwise', () => {
    expect(defaultBaseForPush({ remoteRef: 'refs/heads/main' }, B)).toBe(B);
    expect(defaultBaseForPush({ remoteRef: 'refs/heads/feature' }, B)).toBe('origin/main');
  });

  it('infers author family only from owned branch prefixes', () => {
    expect(inferAuthor('codex/feature')).toBe('codex');
    expect(inferAuthor('claude/fix')).toBe('claude');
    expect(inferAuthor('grok/review-gate')).toBe('grok');
    expect(inferAuthor('feature/human')).toBe('human');
    expect(inferAuthor('codex/feature', 'claude')).toBe('claude');
    expect(inferAuthor('grok/review-gate', 'codex')).toBe('codex');
    expect(() => inferAuthor('codex/feature', 'cluade')).toThrow('Unknown author override');
  });

  it('normalizes common GitHub remote forms', () => {
    expect(repoSlugFromRemote('git@github.com:jayyanez/rove.git')).toBe('jayyanez/rove');
    expect(repoSlugFromRemote('https://github.com/jayyanez/rove.git')).toBe('jayyanez/rove');
    expect(repoSlugFromRemote('https://example.com/jayyanez/rove.git')).toBeNull();
  });

  it('uses the first configured remote when no remote is named origin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-test-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'remote', 'add', 'upstream', 'https://github.com/example/rove.git');

    expect(await originUrl(root)).toBe('https://github.com/example/rove.git');
    expect(defaultBaseForPush({ remoteRef: 'refs/heads/feature' }, B, 'upstream')).toBe('upstream/main');
  });

  it('skips an unreadable foreign temporary owner marker', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(readRecoveryOwnerMarker('foreign/owner.json', {
      read: async () => { throw error; },
    })).resolves.toBeNull();
  });

  it('recovers a review worktree whose owning process is gone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-test-'));
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-recovery-root-'));
    temporaryDirectories.push(root, temporaryRoot);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'commit', '--allow-empty', '-m', 'base');
    const head = git(root, 'rev-parse', 'HEAD');

    const worktree = await createDetachedWorktree(root, head, { temporaryRoot });
    await expect(access(worktree.checkout)).resolves.toBeUndefined();
    expect(await recoverStaleReviewResources(root, {
      temporaryRoot,
      isAlive: () => false,
    })).toBe(1);
    expect(await isWorktreeRegistered(root, worktree.checkout)).toBe(false);
  });

  it('recovers cleanup-pending review resources even while the daemon PID is live', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-test-'));
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-recovery-root-'));
    temporaryDirectories.push(root, temporaryRoot);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'commit', '--allow-empty', '-m', 'base');
    const worktree = await createDetachedWorktree(root, git(root, 'rev-parse', 'HEAD'), {
      temporaryRoot,
    });
    const ownerPath = path.join(path.dirname(worktree.checkout), 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    await writeFile(ownerPath, `${JSON.stringify({
      ...owner,
      cleanupPendingAt: new Date().toISOString(),
    })}\n`);

    await expect(recoverStaleReviewResources(root, {
      temporaryRoot,
      isAlive: () => true,
    })).resolves.toBe(1);
    await expect(access(worktree.checkout)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never prunes an unrelated missing worktree registration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-test-'));
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-recovery-root-'));
    const unrelated = await mkdtemp(path.join(os.tmpdir(), 'rove-unrelated-worktree-'));
    temporaryDirectories.push(root, temporaryRoot, unrelated);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'commit', '--allow-empty', '-m', 'base');
    git(root, 'worktree', 'add', '--detach', unrelated, 'HEAD');
    const metadataRoot = path.join(root, '.git', 'worktrees');
    const metadataBefore = await readdir(metadataRoot);
    await rm(unrelated, { recursive: true, force: true });

    await recoverStaleReviewResources(root, { temporaryRoot, isAlive: () => false });

    await expect(readdir(metadataRoot)).resolves.toEqual(metadataBefore);
  });

  it('records visual baselines in the manifest while excluding their bytes from the textual patch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-test-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'tests', 'visual', 'chrome.spec.ts-snapshots'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'tests', 'visual', 'chrome.spec.ts-snapshots', 'app-win32.png'), Buffer.from([0, 1]));
    await writeFile(path.join(root, 'src', 'example.ts'), 'one\n');
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'tests', 'visual', 'chrome.spec.ts-snapshots', 'app-win32.png'), Buffer.from([2, 3]));
    await writeFile(path.join(root, 'src', 'example.ts'), 'two\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'change');
    const head = git(root, 'rev-parse', 'HEAD');

    const files = await changedFiles(root, base, head);
    expect(files).toEqual([
      'src/example.ts',
      'tests/visual/chrome.spec.ts-snapshots/app-win32.png',
    ]);
    expect(excludedReviewFiles(files)).toEqual([
      'tests/visual/chrome.spec.ts-snapshots/app-win32.png',
    ]);
    expect(await diffStats(root, base, head)).toEqual({ additions: 1, deletions: 1, changedLines: 2 });
    expect(await readPatch(root, base, head)).not.toContain('app-win32.png');
  });

  it('preserves leading whitespace in NUL-delimited changed paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-test-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'commit', '--allow-empty', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, ' leading.ts'), 'export const value = 1;\n');
    git(root, 'add', '--', ' leading.ts');
    git(root, 'commit', '-m', 'leading path');

    await expect(changedFiles(root, base, git(root, 'rev-parse', 'HEAD')))
      .resolves.toEqual([' leading.ts']);
  });

  it('reports a git status per changed path, renames by their destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-test-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'gone.png'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(root, 'docs', 'moved.md'), `${'stable line\n'.repeat(40)}`);
    await writeFile(path.join(root, 'docs', 'edited.md'), 'one\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    await rm(path.join(root, 'docs', 'gone.png'));
    git(root, 'mv', 'docs/moved.md', 'docs/renamed with space.md');
    await writeFile(path.join(root, 'docs', 'edited.md'), 'two\n');
    await writeFile(path.join(root, 'docs', 'new.png'), Buffer.from([4, 5]));
    git(root, 'add', '-A', '.');
    git(root, 'commit', '-m', 'change');
    const head = git(root, 'rev-parse', 'HEAD');

    await expect(changedFilesWithStatus(root, base, head)).resolves.toEqual([
      { path: 'docs/edited.md', status: 'M' },
      { path: 'docs/gone.png', status: 'D' },
      { path: 'docs/new.png', status: 'A' },
      { path: 'docs/renamed with space.md', status: 'R' },
    ]);
    await expect(showFileAtCommit(root, head, 'docs/edited.md')).resolves.toBe('two\n');
    await expect(showFileAtCommit(root, base, 'docs/edited.md')).resolves.toBe('one\n');
    await expect(showFileAtCommit(root, head, 'docs/gone.png')).resolves.toBe('');
    await expect(showFileAtCommit(root, head, 'docs/never.md')).resolves.toBe('');
  });
});


describe('head snapshot', () => {
  it('reads the commit and the branch name from one git process', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-git-snapshot-'));
    try {
      const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
      run('init', '-b', 'main');
      run('config', 'user.email', 'test@example.com');
      run('config', 'user.name', 'Test');
      run('commit', '--allow-empty', '-m', 'base');
      const sha = run('rev-parse', 'HEAD');
      await expect(resolveHeadSnapshot(root)).resolves.toEqual({ sha, branch: 'main' });
      run('checkout', '-q', '--detach');
      await expect(resolveHeadSnapshot(root)).resolves.toEqual({ sha, branch: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
