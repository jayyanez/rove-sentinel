import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findRepoRoot } from './git.mjs';
import { CONFIG_FILE, normalizeConfig } from './config.mjs';

const HOOK = `#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
exec node "$root/.githooks/sentinel.mjs" pre-push "$@"
`;
const ADAPTER = `import 'rove-sentinel/cli';\n`;

export async function uninstallGeneratedHook(repoRoot) {
  const hook = path.join(repoRoot, '.githooks/pre-push');
  const adapter = path.join(repoRoot, '.githooks/sentinel.mjs');
  let contents;
  try { contents = await readFile(hook, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  if (contents.replaceAll('\r\n', '\n') !== HOOK) return 'manual';
  // Preserve core.hooksPath: the directory may also contain unrelated hooks.
  await rm(hook);
  try {
    if ((await readFile(adapter, 'utf8')).replaceAll('\r\n', '\n') === ADAPTER) await rm(adapter);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return 'removed-generated-hook';
}

/** Create onboarding files without replacing any existing hook or policy. */
export async function initializeRepository(repoRoot = process.cwd()) {
  const root = await findRepoRoot(repoRoot);
  const files = [
    [CONFIG_FILE, `${JSON.stringify(normalizeConfig({ providers: 'auto' }), null, 2)}\n`],
    ['.githooks/pre-push', HOOK],
    ['.githooks/sentinel.mjs', ADAPTER],
  ];
  // Preflight conflicts before creating files. Exclusive writes also protect
  // against another process creating a file after this check.
  for (const [name, text] of files) {
    try {
      const existing = await readFile(path.join(root, name), 'utf8');
      if (existing !== text && name !== CONFIG_FILE) {
        throw new Error(`Existing ${name} was preserved. Integrate 'rove-sentinel/cli' into your hook deliberately; see docs/installation.md.`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const created = [];
  for (const [name, text] of files) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, text, { flag: 'wx', mode: 0o755 });
      created.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return { root, created, next: 'Inspect and commit the configuration and hooks, then run rove-sentinel install from your trusted checkout.' };
}
