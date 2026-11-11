import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
const LOCAL_HOOK_CALL = /^exec node '((?:[^'\n]|'\\'')+)' pre-push "\$@"\n$/;

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The hook text for a launcher path. Forward slashes: Git's sh and Node both take them on Windows. */
export function localHookText(launcherPath) {
  const portable = launcherPath.replaceAll('\\', '/');
  if (/[\u0000-\u001f\u007f]/.test(portable)) throw new Error(`The Sentinel launcher path cannot be written into a hook: ${JSON.stringify(launcherPath)}`);
  return `${LOCAL_HOOK_HEADER}exec node ${shellQuote(portable)} pre-push "$@"\n`;
}

/** The launcher a hook text calls when it is a local hook this installer wrote, else null. */
export function localHookLauncher(text) {
  const normalized = String(text).replaceAll('\r\n', '\n');
  if (!normalized.startsWith(LOCAL_HOOK_HEADER)) return null;
  const match = LOCAL_HOOK_CALL.exec(normalized.slice(LOCAL_HOOK_HEADER.length));
  return match ? match[1].replaceAll("'\\''", "'") : null;
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

function realOrSelf(target, realPath) {
  try {
    return realPath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The launcher a local hook may call: the Sentinel the person ran, by its
 * absolute path. Never one inside the reviewed repository, whose branch could
 * then change its own reviewer, and never a managed engine, which updates
 * remove once nothing uses it.
 */
export async function localLauncher(launcherPath, {
  repoRoot, engineStore, platform = process.platform, realPath = realpathSync.native,
} = {}) {
  if (!launcherPath) throw new Error('A local installation needs the path of the Sentinel it runs; run it as rove-sentinel install --local.');
  const resolved = realOrSelf(launcherPath, realPath);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile() || !/^(launcher|cli)\.mjs$/.test(path.basename(resolved))) {
    throw new Error(`A local installation runs Sentinel's launcher by its path, and ${launcherPath} is not one. Run it as rove-sentinel install --local from a Sentinel installed outside the repository.`);
  }
  if (isInside(resolved, realOrSelf(repoRoot, realPath), platform)) {
    throw new Error(`A local installation must run a Sentinel installed outside the repository it reviews, and ${resolved} is inside ${repoRoot}: a branch could change its own reviewer. Install Sentinel globally (npm install --global) or in a folder of its own, and run install --local from there.`);
  }
  if (engineStore && isInside(resolved, realOrSelf(engineStore, realPath), platform)) {
    throw new Error(`A local installation cannot call a managed engine (${resolved}): updates remove engines nothing uses. Run install --local from the Sentinel you installed.`);
  }
  return resolved;
}

/**
 * What a local installation will write: Git's own pre-push hook, refused when
 * Git would not run it (core.hooksPath is set) or when another hook is there.
 */
export async function prepareLocalHook({ repoRoot, launcher, hooksPath, git = runGit }) {
  if (hooksPath) {
    const ours = hooksPath.replaceAll('\\', '/') === '.githooks';
    throw new Error(ours
      ? `core.hooksPath is .githooks, from a Sentinel installation from the project's files. A local installation needs Git's own hooks folder: run rove-sentinel uninstall, then git config --unset core.hooksPath, then install --local again.`
      : `core.hooksPath=${hooksPath} is set, so Git would not run a hook in its own hooks folder; it was preserved. Add a call to node "${launcher}" pre-push "$@" to the pre-push hook in ${hooksPath} deliberately, or unset core.hooksPath.`);
  }
  const hookPath = await defaultHookPath(repoRoot, { git });
  const existing = await readOptional(hookPath);
  if (existing !== null && localHookLauncher(existing) === null) {
    throw new Error(`Existing Git pre-push hook at ${hookPath} was preserved. Add a call to node "${launcher}" pre-push "$@" to it deliberately; see docs/installation.md.`);
  }
  return { hookPath, hookText: localHookText(launcher), previous: existing };
}

/** Write a local hook, runnable where the file system keeps modes. */
export async function writeLocalHook(hookPath, text) {
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, text, { mode: 0o755 });
  await chmod(hookPath, 0o755).catch(() => {});
}

/** Put back what was there before an attempted write: the earlier text, or nothing. */
export async function restoreLocalHook(hookPath, previous) {
  if (previous === null) await rm(hookPath, { force: true });
  else await writeLocalHook(hookPath, previous);
}

/** Whether a local hook this installer wrote is at that path. */
export async function localHookPresent(hookPath) {
  if (!hookPath) return false;
  const text = await readOptional(hookPath).catch(() => null);
  return text !== null && localHookLauncher(text) !== null;
}

/** Remove the local hook if it is still the one this installer wrote; a changed one is the person's to edit. */
export async function removeLocalHook(hookPath) {
  const text = await readOptional(hookPath);
  if (text === null) return 'absent';
  if (localHookLauncher(text) === null) return 'manual';
  await rm(hookPath, { force: true });
  return 'removed-local-hook';
}

/**
 * How this repository's Sentinel is installed, recorded in its state folder:
 * `{ mode: 'project' }`, or `{ mode: 'local', hook, launcher, config }`. No
 * record is an installation from before 1.19.0, which is a project one.
 */
export async function readInstallation(paths) {
  const record = await readJson(paths.installation, null);
  if (record === null) return null;
  if (record?.schemaVersion !== 1 || !['project', 'local'].includes(record.mode)
    || (record.mode === 'local' && (typeof record.hook !== 'string' || typeof record.launcher !== 'string'
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
