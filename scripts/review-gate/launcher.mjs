#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GATE_VERSION } from './constants.mjs';
import { findRepoRoot, primaryRemote } from './git.mjs';
import { normalizeRepositoryIdentity, statePaths, stateRootFor } from './storage.mjs';
import { selectedEngine } from './engine-store.mjs';

const bundled = fileURLToPath(new URL('./cli.mjs', import.meta.url));
let selected = bundled;
let root = null;
const repoIndex = process.argv.indexOf('--repo');
try { root = await findRepoRoot(repoIndex >= 0 ? process.argv[repoIndex + 1] : process.cwd()); }
catch { /* Commands such as help, version and update-check also work outside Git. */ }
try {
  if (root) {
    const { url } = await primaryRemote(root);
    const identity = normalizeRepositoryIdentity(url, root);
    selected = await selectedEngine(statePaths(stateRootFor(identity)), bundled, GATE_VERSION);
  }
  await import(pathToFileURL(selected).href);
} catch (error) {
  process.stderr.write(`Rove Sentinel launcher: ${error.message}\n`);
  process.exitCode = 1;
}
