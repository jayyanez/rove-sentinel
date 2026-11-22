#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GATE_VERSION } from './constants.mjs';
import { findRepoRoot, primaryRemote } from './git.mjs';
import { normalizeRepositoryIdentity, statePaths, stateRootFor } from './storage.mjs';
import { repairEngine, selectedEngine } from './engine-store.mjs';
import { repairOptions, repairStoppedStep } from './process.mjs';

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
    const paths = statePaths(stateRootFor(identity));
    // repair runs on the newest engine at hand, never one older than the active
    // one: the repository's own engine may predate the command, or be the broken one.
    selected = process.argv[2] === 'repair'
      ? await repairEngine(paths, bundled, GATE_VERSION)
      : await selectedEngine(paths, bundled, GATE_VERSION);
  }
  await import(pathToFileURL(selected).href);
} catch (error) {
  process.stderr.write(`Rove Sentinel launcher: ${error.message}\n`);
  // A repair that cannot start still says what to do next.
  if (process.argv[2] === 'repair') {
    const argv = process.argv.slice(3);
    const options = repairOptions(argv);
    const step = repairStoppedStep(error, argv);
    const repository = root ?? options.repo ?? process.cwd();
    process.stdout.write(options.json
      ? `${JSON.stringify({ repository, dryRun: options.dryRun, ok: false, steps: [step] }, null, 2)}\n`
      : `Rove Sentinel repair for ${repository}:\n  ${step.status}: ${step.state}: ${step.detail}\n${step.next ? `    Next: ${step.next}\nResult: blocked; run each Next command above.` : 'Result: blocked; stop and report this output.'}\n`);
  }
  process.exitCode = 1;
}
