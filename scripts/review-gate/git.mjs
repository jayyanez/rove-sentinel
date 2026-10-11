import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cleanupAfterBestEffortMarker,
  removeTreeWithRetries,
  retryCleanupOperation,
} from './cleanup.mjs';
import { LIMITS, ZERO_SHA } from './constants.mjs';
import { runProcess } from './process.mjs';
import { boundPatchContext } from './shards.mjs';

const REVIEW_PATCH_PATHS = [
  '--',
  '.',
  ':(glob,exclude)tests/visual/*-snapshots/*.png',
];

const EXCLUDED_REVIEW_FILE = /^tests\/visual\/[^/]+-snapshots\/[^/]+\.png$/i;

export async function runGit(repoRoot, args, options = {}) {
  const result = await runProcess('git', ['-C', repoRoot, ...args], {
    timeoutMs: 120_000,
    maxOutputBytes: options.maxOutputBytes ?? LIMITS.maxPatchBytes + 64 * 1024,
    allowFailure: options.allowFailure,
    allowDuringShutdown: options.allowDuringShutdown,
    outputLimitMessage: options.outputLimitMessage,
    binary: options.binary,
    latchCleanupFailure: options.latchCleanupFailure,
  });
  return options.result ? result : result.stdout.trim();
}

export async function findRepoRoot(cwd = process.cwd()) {
  return await realpath(await runGit(cwd, ['rev-parse', '--show-toplevel']));
}

export async function resolveCommit(repoRoot, ref) {
  return await runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export async function currentBranch(repoRoot) {
  return await runGit(repoRoot, ['branch', '--show-current']);
}

export async function originUrl(repoRoot) {
  return (await primaryRemote(repoRoot)).url;
}

export async function primaryRemote(repoRoot, preferredName = 'origin') {
  const names = (await runGit(repoRoot, ['remote'])).split(/\r?\n/).filter(Boolean);
  if (!names.length) return { name: '', url: '' };
  const name = names.includes(preferredName) ? preferredName : names[0];
  const result = await runGit(repoRoot, ['remote', 'get-url', name], {
    allowFailure: true,
    result: true,
  });
  return { name, url: result.code === 0 ? result.stdout.trim() : '' };
}

export async function mergeBase(repoRoot, baseSha, headSha) {
  return await runGit(repoRoot, ['merge-base', baseSha, headSha]);
}

export function repoSlugFromRemote(remoteUrl) {
  const normalized = remoteUrl
    .trim()
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\.git$/i, '');
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    return parsed.pathname.replace(/^\//, '');
  } catch {
    return null;
  }
}

export async function changedFiles(repoRoot, baseSha, headSha) {
  const result = await runGit(repoRoot, [
    'diff',
    '--name-only',
    '-z',
    `${baseSha}...${headSha}`,
    '--',
    '.',
  ], { result: true });
  return result.stdout.split('\0').filter(Boolean);
}

/**
 * `changedFiles` with the git status letter per path (`A`, `M`, `D`, `T`, and
 * `R`/`C` for renames/copies, which report the DESTINATION path). NUL-delimited
 * so paths with whitespace survive; `-z` emits `status\0path\0` and, for
 * renames/copies, `Rnnn\0old\0new\0`.
 */
export async function changedFilesWithStatus(repoRoot, baseSha, headSha) {
  const result = await runGit(repoRoot, [
    'diff',
    '--name-status',
    '--find-renames',
    '-z',
    `${baseSha}...${headSha}`,
    '--',
    '.',
  ], { result: true });
  const fields = result.stdout.split('\0');
  const files = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) continue;
    const letter = status.charAt(0).toUpperCase();
    if (letter === 'R' || letter === 'C') {
      index += 1; // the source path
    }
    const path = fields[index++];
    if (path) files.push({ path, status: letter });
  }
  return files;
}

/** Contents of `path` as committed at `commitSha`; empty string when absent. */
export async function showFileAtCommit(repoRoot, commitSha, path) {
  const result = await runGit(repoRoot, ['show', `${commitSha}:${path}`], {
    result: true,
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout : '';
}

/**
 * Raw bytes of `path` as committed at `commitSha` (a Buffer, never decoded —
 * a PNG must survive the read intact); `null` when absent or larger than
 * `LIMITS.maxEvidenceBlobBytes` (unreadable, never buffered whole).
 */
export async function showBlobAtCommit(repoRoot, commitSha, path) {
  let result;
  try {
    result = await runGit(repoRoot, ['cat-file', '-p', `${commitSha}:${path}`], {
      result: true,
      allowFailure: true,
      binary: true,
      maxOutputBytes: LIMITS.maxEvidenceBlobBytes,
    });
  } catch (error) {
    if (error?.code === 'OUTPUT_LIMIT') return null;
    throw error;
  }
  return result.code === 0 ? result.stdout : null;
}

export async function diffStats(repoRoot, baseSha, headSha) {
  const output = await runGit(repoRoot, [
    'diff',
    '--numstat',
    `${baseSha}...${headSha}`,
    '--',
    '.',
  ]);
  let additions = 0;
  let deletions = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added)) additions += Number(added);
    if (/^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  return { additions, deletions, changedLines: additions + deletions };
}

export async function readPatch(repoRoot, baseSha, headSha) {
  const result = await runGit(
    repoRoot,
    [
      'diff',
      '--no-ext-diff',
      '--find-renames',
      '--find-copies',
      `--unified=${LIMITS.patchContextLines}`,
      `${baseSha}...${headSha}`,
      ...REVIEW_PATCH_PATHS,
    ],
    {
      result: true,
      maxOutputBytes: LIMITS.maxPatchBytes,
      outputLimitMessage: `Review patch exceeded the bounded ${LIMITS.maxPatchBytes}-byte limit. Split the change or raise the limit deliberately.`,
    },
  );
  // Context is bounded by bytes as well as lines: in a file of very long
  // lines, 80 lines either side of each change is most of the patch. The
  // 4 MiB bound above still applies to what Git wrote.
  return boundPatchContext(result.stdout);
}

export function excludedReviewFiles(files) {
  return files.filter((file) => EXCLUDED_REVIEW_FILE.test(file));
}

export async function isAncestor(repoRoot, ancestor, descendant) {
  const result = await runGit(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
    result: true,
  });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`Could not determine whether ${ancestor} is an ancestor of ${descendant}.`);
}

export async function ensureCommitAvailable(repoRoot, sha, fetchRef, remoteName = 'origin') {
  const check = await runGit(repoRoot, ['cat-file', '-e', `${sha}^{commit}`], {
    allowFailure: true,
    result: true,
  });
  if (check.code === 0) return;
  if (!fetchRef) throw new Error(`Commit ${sha} is not available locally.`);
  if (!remoteName) throw new Error(`Commit ${sha} is not available locally and no Git remote is configured.`);
  await runGit(repoRoot, ['fetch', remoteName, fetchRef]);
  await resolveCommit(repoRoot, sha);
}

export async function createDetachedWorktree(
  repoRoot,
  headSha,
  { temporaryRoot = tmpdir() } = {},
) {
  const parent = await mkdtemp(path.join(temporaryRoot, 'rove-review-'));
  const checkout = path.join(parent, 'checkout');
  const ownerPath = path.join(parent, 'owner.json');
  let owner;
  try {
    owner = {
      schemaVersion: 1,
      kind: 'worktree',
      pid: process.pid,
      repoRoot: await realpath(repoRoot),
      resourcePath: checkout,
      createdAt: new Date().toISOString(),
    };
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await runGit(repoRoot, ['worktree', 'add', '--detach', checkout, headSha]);
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    checkout,
    async cleanup() {
      if (cleaned) return;
      const resolvedParent = await realpath(parent).catch(() => parent);
      const resolvedTmp = await realpath(temporaryRoot);
      const relative = path.relative(resolvedTmp, resolvedParent);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Refusing to clean review worktree outside the temporary directory: ${resolvedParent}`);
      }
      await cleanupAfterBestEffortMarker(
        () => writeFile(ownerPath, `${JSON.stringify({
          ...owner,
          cleanupPendingAt: new Date().toISOString(),
        }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
        async () => {
          await retryCleanupOperation(async () => {
            const result = await runGit(repoRoot, ['worktree', 'remove', '--force', checkout], {
              allowFailure: true,
              allowDuringShutdown: true,
              result: true,
            });
            if (result.code === 0 || !(await isWorktreeRegistered(repoRoot, checkout))) return;
            const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
            throw new Error(`git worktree remove failed${detail ? `: ${detail}` : ''}`);
          });
          await removeTreeWithRetries(resolvedParent);
        },
      );
      cleaned = true;
    },
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readRecoveryOwnerMarker(
  markerPath,
  { read = readFile } = {},
) {
  try {
    return JSON.parse(await read(markerPath, 'utf8'));
  } catch (error) {
    if (
      error?.code === 'ENOENT' ||
      error?.code === 'EACCES' ||
      error?.code === 'EPERM' ||
      error instanceof SyntaxError
    ) return null;
    throw error;
  }
}

export async function recoverStaleReviewResources(
  repoRoot,
  { temporaryRoot = tmpdir(), isAlive = processIsAlive } = {},
) {
  const resolvedRepo = comparablePath(await realpath(repoRoot));
  const resolvedTemporaryRoot = await realpath(temporaryRoot);
  const entries = await readdir(resolvedTemporaryRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('rove-review-')) continue;
    const parent = path.join(resolvedTemporaryRoot, entry.name);
    const markerPath = path.join(parent, 'owner.json');
    const marker = await readRecoveryOwnerMarker(markerPath);
    if (!marker) continue;
    const kind = marker?.kind || (marker?.checkout ? 'worktree' : null);
    const expectedResource = kind === 'context' ? parent : path.join(parent, 'checkout');
    const recordedResource = marker?.resourcePath || marker?.checkout;
    const markerRepo = typeof marker?.repoRoot === 'string'
      ? await comparableExistingPath(marker.repoRoot)
      : null;
    const markerResource = typeof recordedResource === 'string'
      ? await comparableExistingPath(recordedResource)
      : null;
    const cleanupPending = typeof marker?.cleanupPendingAt === 'string' &&
      Number.isFinite(Date.parse(marker.cleanupPendingAt));
    if (
      !['worktree', 'context'].includes(kind) ||
      markerRepo !== resolvedRepo ||
      markerResource !== await comparableExistingPath(expectedResource) ||
      (isAlive(marker?.pid) && !cleanupPending)
    ) {
      continue;
    }
    const relative = path.relative(resolvedTemporaryRoot, parent);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (kind === 'worktree') {
      await retryCleanupOperation(async () => {
        const result = await runGit(repoRoot, ['worktree', 'remove', '--force', expectedResource], {
          allowFailure: true,
          result: true,
        });
        if (result.code === 0 || !(await isWorktreeRegistered(repoRoot, expectedResource))) return;
        throw new Error(`Could not recover stale review worktree ${expectedResource}: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
      });
    }
    await removeTreeWithRetries(parent);
    recovered += 1;
  }
  return recovered;
}

export async function isWorktreeRegistered(repoRoot, checkout) {
  const output = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const expected = await comparableExistingPath(checkout);
  const candidates = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const candidate of candidates) {
    if (await comparableExistingPath(candidate) === expected) return true;
  }
  return false;
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function comparableExistingPath(value) {
  return comparablePath(await realpath(value).catch(() => value));
}

export function parsePrePushInput(input) {
  const refs = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localRef || !localSha || !remoteRef || !remoteSha) {
      throw new Error(`Malformed pre-push input: ${rawLine}`);
    }
    refs.push({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
      deletion: ZERO_SHA.test(localSha),
    });
  }
  return refs;
}

/**
 * HEAD's commit and branch name from ONE git process, so a checkout switch
 * between two separate commands cannot pair one branch's name with another
 * branch's commit. `branch` is null on a detached HEAD.
 */
export async function resolveHeadSnapshot(repoRoot) {
  // `--abbrev-ref` applies to the arguments that follow it: the SHA first,
  // then the abbreviated ref name. Git offers no atomic read of both, so the
  // snapshot is then re-verified: the named branch must still point at that
  // commit, or the checkout moved between the two lookups and the pair is
  // refused rather than used.
  const output = await runGit(repoRoot, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
  const [sha, name] = String(output).split(/\r?\n/).map((line) => line.trim());
  if (!/^[a-f0-9]{40}$/.test(sha || '')) {
    throw new Error(`Could not resolve HEAD as a commit: ${String(output).slice(0, 200)}`);
  }
  const branch = name && name !== 'HEAD' ? name : null;
  if (branch) {
    const tip = (await runGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
    if (tip !== sha) {
      throw new Error(`The checkout changed while resolving HEAD: ${branch} now points at ${tip.slice(0, 12)}, not ${sha.slice(0, 12)}. Rerun the gate once the checkout settles.`);
    }
  }
  return { sha, branch };
}

export function inferAuthor(branchName, explicit = 'auto') {
  if (!['auto', 'claude', 'codex', 'grok', 'human'].includes(explicit)) {
    throw new Error(`Unknown author override: ${explicit}. Expected auto, claude, codex, grok, or human.`);
  }
  if (explicit !== 'auto') return explicit;
  if (/^codex\//i.test(branchName)) return 'codex';
  if (/^claude\//i.test(branchName)) return 'claude';
  if (/^grok\//i.test(branchName)) return 'grok';
  return 'human';
}

export function defaultBaseForPush(ref, remoteSha, remoteName = 'origin') {
  if (ref.remoteRef === 'refs/heads/main' && !ZERO_SHA.test(remoteSha)) {
    return remoteSha;
  }
  if (!remoteName) throw new Error('Shared review gate cannot determine the feature-branch base because no Git remote is configured.');
  return `${remoteName}/main`;
}
