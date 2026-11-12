import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runGit } from './git.mjs';
import { atomicWriteJson, readJson, removeStoredJson } from './storage.mjs';

/**
 * A local installation (`install --local`) leaves nothing in the repository's
 * tracked files. Its pre-push hook lives in Git's own hooks folder (inside the
 * Git directory, never committed), and calls a Sentinel installed outside the
 * repository by its absolute path. Its configuration, when it has one, is a
 * file outside the repository; the installed policy snapshot, as always, is
 * in the state folder.
 */

const LOCAL_HOOK_HEADER = `#!/bin/sh
# Rove Sentinel local pre-push hook, written by \`rove-sentinel install --local\`.
# It lives in Git's own hooks folder, outside the repository's tracked files.
# \`rove-sentinel uninstall\` removes it.
`;
const QUOTED = "'((?:[^'\\n]|'\\\\'')+)'";
const LOCAL_HOOK_CALL = new RegExp(`^exec ${QUOTED} ${QUOTED} pre-push "\\$@"\\n$`);
const unquote = (value) => value.replaceAll("'\\''", "'");

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotedPath(value, label) {
  const portable = value.replaceAll('\\', '/');
  if (/[\u0000-\u001f\u007f]/.test(portable)) throw new Error(`The ${label} path cannot be written into a hook: ${JSON.stringify(value)}`);
  return shellQuote(portable);
}

/**
 * The hook text: Node and the launcher, both by absolute path, so a `node`
 * that a repository puts first on PATH (npm puts node_modules/.bin there for
 * its scripts) is never the one that runs. Forward slashes: Git's sh and
 * Node both take them on Windows.
 */
export function localHookText(launcherPath, nodePath = process.execPath) {
  return `${LOCAL_HOOK_HEADER}exec ${quotedPath(nodePath, 'Node')} ${quotedPath(launcherPath, 'Sentinel launcher')} pre-push "$@"\n`;
}

/** The launcher a hook text calls when it is a local hook this installer writes, else null. */
export function localHookLauncher(text) {
  const normalized = String(text).replaceAll('\r\n', '\n');
  if (!normalized.startsWith(LOCAL_HOOK_HEADER)) return null;
  const match = LOCAL_HOOK_CALL.exec(normalized.slice(LOCAL_HOOK_HEADER.length));
  return match ? unquote(match[2]) : null;
}

const sameText = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.replaceAll('\r\n', '\n') === right.replaceAll('\r\n', '\n');

/** The exact hook an installation record says Sentinel wrote. */
export function installedHookText(installation) {
  return localHookText(installation.launcher, installation.node);
}

/** Git's own pre-push hook path for this repository, as Git resolves it when core.hooksPath is unset. */
export async function defaultHookPath(repoRoot, { git = runGit } = {}) {
  const hookPath = await git(repoRoot, ['rev-parse', '--git-path', 'hooks/pre-push']);
  return path.resolve(repoRoot, hookPath.trim());
}

async function readOptional(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const fold = (value, platform) => {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
};

function isInside(child, parent, platform) {
  const folded = fold(child, platform);
  const root = fold(parent, platform);
  return folded === root || folded.startsWith(`${root}${path.sep}`) || folded.startsWith(`${root}/`);
}

/** The real path of a file, or of its nearest existing folder followed by the rest (short names and links resolved). */
function realOrSelf(target, realPath) {
  const resolved = path.resolve(target);
  let base = resolved;
  const rest = [];
  for (;;) {
    try {
      return path.join(realPath(base), ...rest);
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return resolved;
      rest.unshift(path.basename(base));
      base = parent;
    }
  }
}

/**
 * Every folder of this clone a branch can write to: each of its worktrees
 * (they all share Git's hooks folder, so the local hook runs for each) and
 * its Git directory.
 */
export async function repositoryRoots(repoRoot, { git = runGit } = {}) {
  // -z: a worktree path may hold a newline, which would cut a line-based listing.
  const listing = await git(repoRoot, ['worktree', 'list', '--porcelain', '-z'], { result: true });
  const worktrees = listing.stdout.split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice('worktree '.length));
  const commonDir = path.resolve(repoRoot, (await git(repoRoot, ['rev-parse', '--git-common-dir'], { result: true })).stdout.replace(/\r?\n$/, ''));
  return [...new Set([repoRoot, ...worktrees, commonDir].map((entry) => path.resolve(entry)))];
}

function insideAny(target, roots, platform, realPath) {
  const resolved = realOrSelf(target, realPath);
  return roots.find((root) => isInside(resolved, realOrSelf(root, realPath), platform)) ?? null;
}

/**
 * The launcher a local hook may call: the Sentinel the person ran, by its
 * absolute path. Never one inside the reviewed repository (any worktree of the
 * clone, which all run the same hook), whose branch could then change its own
 * reviewer, and never a managed engine, which updates remove once nothing uses it.
 */
export async function localLauncher(launcherPath, {
  repoRoot, roots = [repoRoot], engineStore, platform = process.platform, realPath = realpathSync.native,
} = {}) {
  if (!launcherPath) throw new Error('A local installation needs the path of the Sentinel it runs; run it as rove-sentinel install --local.');
  const resolved = realOrSelf(launcherPath, realPath);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile() || !/^(launcher|cli)\.mjs$/.test(path.basename(resolved))) {
    throw new Error(`A local installation runs Sentinel's launcher by its path, and ${launcherPath} is not one. Run it as rove-sentinel install --local from a Sentinel installed outside the repository.`);
  }
  const container = insideAny(resolved, roots, platform, realPath);
  if (container) {
    throw new Error(`A local installation must run a Sentinel installed outside the repository it reviews, and ${resolved} is inside ${container}: a branch could change its own reviewer. Install Sentinel globally (npm install --global) or in a folder of its own, and run install --local from there.`);
  }
  if (engineStore && isInside(resolved, realOrSelf(engineStore, realPath), platform)) {
    throw new Error(`A local installation cannot call a managed engine (${resolved}): updates remove engines nothing uses. Run install --local from the Sentinel you installed.`);
  }
  return resolved;
}

/** The Node a local hook runs, by its absolute path: never one inside the repository. */
export function localNode(nodePath, { roots, platform = process.platform, realPath = realpathSync.native } = {}) {
  const resolved = realOrSelf(nodePath, realPath);
  const container = insideAny(resolved, roots, platform, realPath);
  if (container) {
    throw new Error(`A local installation runs Node by its path, and ${resolved} is inside ${container}: a branch could change its own reviewer. Run install --local with a Node installed outside the repository.`);
  }
  return resolved;
}

/**
 * A local installation's policy files (the configuration file, and the charter
 * and lessons it names) must be outside the repository, or a branch could
 * write the policy a reinstall snapshots.
 */
export function assertPolicyOutside({ configFile, config, roots, platform = process.platform, realPath = realpathSync.native }) {
  if (!configFile) return;
  const folder = path.dirname(path.resolve(configFile));
  const files = [path.resolve(configFile), ...[config?.charter, config?.lessons].filter(Boolean).map((file) => path.join(folder, file))];
  for (const file of files) {
    const container = insideAny(file, roots, platform, realPath);
    if (container) {
      throw new Error(`A local installation reads its policy from outside the repository, and ${file} is inside ${container}: a branch could write the policy it is reviewed under. Keep the configuration file, and the charter and lessons it names, in a folder outside the repository.`);
    }
  }
}

/**
 * What a local installation will write: Git's own pre-push hook, refused when
 * Git would not run it (core.hooksPath is set) or when another hook is there.
 */
/**
 * Every change to the hook relies on an exclusive hard link, so a file system
 * without them (FAT, some network shares) would leave a replaced hook neither
 * written nor restorable: it is refused before anything changes.
 */
export async function assertHardLinks(folder, { linkFile = link } = {}) {
  // In the hooks folder, or the Git directory when it has none yet: the same
  // file system, and nothing is created that outlives the probe.
  let probeFolder = path.resolve(folder);
  while (!(await stat(probeFolder).then((info) => info.isDirectory(), () => false))) {
    const parent = path.dirname(probeFolder);
    if (parent === probeFolder) break;
    probeFolder = parent;
  }
  const probe = path.join(probeFolder, `.rove-sentinel-link-probe-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(probe, '', { flag: 'wx' });
    await linkFile(probe, `${probe}-linked`);
  } catch (error) {
    throw new Error(`A local installation needs hard links in ${folder}, to change the hook without ever leaving part of one or replacing another's, and this file system refused one (${error?.code || error?.message}). Use an installation from the project's files here.`);
  } finally {
    await rm(`${probe}-linked`, { force: true });
    await rm(probe, { force: true });
  }
}

export async function prepareLocalHook({ repoRoot, launcher, node = process.execPath, hooksPath, git = runGit, linkFile = link }) {
  if (hooksPath) {
    const ours = hooksPath.replaceAll('\\', '/') === '.githooks';
    throw new Error(ours
      ? `core.hooksPath is .githooks, from a Sentinel installation from the project's files. A local installation needs Git's own hooks folder: run rove-sentinel uninstall, then git config --unset core.hooksPath, then install --local again.`
      : `core.hooksPath=${hooksPath} is set, so Git would not run a hook in its own hooks folder; it was preserved. A local installation cannot share the pre-push hook with another: unset core.hooksPath, or use an installation from the project's files, which integrates with an existing hook (docs/installation.md#existing-git-hooks).`);
  }
  const hookPath = await defaultHookPath(repoRoot, { git });
  await assertHardLinks(path.dirname(hookPath), { linkFile });
  const existing = await readOptional(hookPath);
  if (existing !== null && localHookLauncher(existing) === null) {
    throw new Error(`Existing Git pre-push hook at ${hookPath} was preserved. A local installation cannot share the pre-push hook with another: remove that hook, or use an installation from the project's files, which integrates with it (docs/installation.md#existing-git-hooks).`);
  }
  return { hookPath, hookText: localHookText(launcher, node), previous: existing };
}

/**
 * Take a hook away only if it is one this installer wrote (`accept` decides),
 * without ever deleting or overwriting another: the file is moved aside, read
 * there, and a foreign one is put back with an exclusive link, which fails
 * rather than replace a hook written in the meantime; the moved one is then
 * kept beside it and named. Returns `absent`, `taken` or `foreign`.
 */
export async function takeOwnHook(hookPath, accept = (text) => localHookLauncher(text) !== null, { read = readFile } = {}) {
  const aside = `${hookPath}.rove-sentinel-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(hookPath, aside);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  // Put the moved hook back exclusively; a hook written meanwhile is kept, and
  // the moved one stays beside it, named.
  const putBack = async () => {
    try {
      await link(aside, hookPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return { state: 'foreign', kept: aside };
    }
    await rm(aside, { force: true });
    return { state: 'foreign' };
  };
  let text;
  try {
    text = await read(aside, 'utf8');
  } catch (error) {
    // Unread, it cannot be known as Sentinel's: it goes back before the error.
    const back = await putBack();
    throw new Error(`Could not read the Git pre-push hook at ${hookPath}; it was ${back.kept ? `kept at ${back.kept}` : 'put back'}: ${error?.message || String(error)}`, { cause: error });
  }
  if (accept(text)) {
    await rm(aside, { force: true });
    return { state: 'taken', text };
  }
  return await putBack();
}

/**
 * Create the hook whole or not at all: it is written in full beside its
 * place, then linked there exclusively, so the path never holds part of it,
 * and a hook that appeared meanwhile is never replaced.
 */
export async function createHook(hookPath, text, { write = writeFile } = {}) {
  await mkdir(path.dirname(hookPath), { recursive: true });
  const staged = `${hookPath}.rove-sentinel-new-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await write(staged, text, { mode: 0o755, flag: 'wx' });
    await chmod(staged, 0o755).catch(() => {});
    try {
      await link(staged, hookPath);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`Another Git pre-push hook appeared at ${hookPath} during the installation; it was preserved.`);
      throw error;
    }
  } finally {
    await rm(staged, { force: true });
  }
}

/**
 * Write a local hook, runnable where the file system keeps modes, replacing
 * only an earlier local hook (`previous`) and never another hook, even one
 * written since the installation looked.
 */
export async function writeLocalHook(hookPath, text, previous = null, { write = writeFile } = {}) {
  if (previous !== null) {
    // Only the very hook the installation read: another local hook written
    // since, by another installation or by hand, is not this one's to replace.
    const taken = await takeOwnHook(hookPath, (current) => sameText(current, previous));
    if (taken.state === 'foreign') {
      throw new Error(`The Git pre-push hook at ${hookPath} changed during the installation; it was preserved${taken.kept ? `, and the one it replaced is at ${taken.kept}` : ''}.`);
    }
  }
  await createHook(hookPath, text, { write });
}

/**
 * Undo an attempted write: take away the hook written (`written`), if it is
 * still there and unchanged, and put back what was there before (`previous`),
 * also when the write moved it aside and then failed. A hook changed or
 * created since is someone's, and stays.
 */
export async function restoreLocalHook(hookPath, written, previous) {
  const taken = await takeOwnHook(hookPath, (text) => sameText(text, written));
  if (taken.state === 'foreign' || previous === null) return;
  await createHook(hookPath, previous);
}

/**
 * Whether the hook at that path is one Git will run: exactly `expected` (the
 * hook this installation wrote), or with no `expected` any local hook, and
 * executable where Git requires it (it ignores a hook without the executable
 * bit; Git for Windows does not read that bit).
 */
export async function localHookPresent(hookPath, expected = null, {
  platform = process.platform, executable = (target) => access(target, fsConstants.X_OK),
  // false: whether the hook is there, not whether Git would run it.
  runnable = true,
} = {}) {
  if (!hookPath) return false;
  const text = await readOptional(hookPath).catch(() => null);
  if (text === null || (expected === null ? localHookLauncher(text) === null : !sameText(text, expected))) return false;
  if (!runnable || platform === 'win32') return true;
  return await executable(hookPath).then(() => true, () => false);
}

/** Remove the local hook only while it is exactly the one this installation wrote; a changed one is the person's to edit. */
export async function removeLocalHook(hookPath, expected) {
  const taken = await takeOwnHook(hookPath, (text) => sameText(text, expected));
  return taken.state === 'absent' ? 'absent' : taken.state === 'taken' ? 'removed-local-hook' : 'manual';
}

/** Whether two hook paths name the same file: the record's, and this clone's. */
export function sameHookPath(left, right, { platform = process.platform, realPath = realpathSync.native } = {}) {
  return fold(realOrSelf(left, realPath), platform) === fold(realOrSelf(right, realPath), platform);
}

/**
 * How this repository's Sentinel is installed, recorded in its state folder:
 * `{ mode: 'project' }`, or `{ mode: 'local', hook, launcher, node, config }`. No
 * record is an installation from before 1.19.0, which is a project one.
 */
export async function readInstallation(paths) {
  const record = await readJson(paths.installation, null);
  if (record === null) return null;
  if (record?.schemaVersion !== 1 || !['project', 'local'].includes(record.mode)
    || (record.mode === 'local' && (typeof record.hook !== 'string' || typeof record.launcher !== 'string' || typeof record.node !== 'string'
      || (record.config !== null && typeof record.config !== 'string')))) {
    throw new Error(`The installation record ${paths.installation} is not one Sentinel wrote. Delete it, then run install again (with --local for a local installation).`);
  }
  return record;
}

export async function writeInstallation(paths, record) {
  await atomicWriteJson(paths.installation, { schemaVersion: 1, ...record });
}

export async function removeInstallation(paths) {
  await removeStoredJson(paths.installation);
}
