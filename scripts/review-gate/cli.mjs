#!/usr/bin/env node

import path from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';

import { GATE_VERSION, LIMITS } from './constants.mjs';
import { initializeRepository } from './init.mjs';
import { HELP } from './help.mjs';

import { runWatcher } from './daemon.mjs';
import {
  DETACHED_LOG_ENV,
  appendDetachedExitMarker,
  defaultDetachLogPath,
  startDetachedGate,
} from './detach.mjs';
import { currentBranch, findRepoRoot, mergeBase, resolveCommit } from './git.mjs';
import { guiEvidenceRefusal } from './prepush.mjs';
import { deferFindings } from './dispositions.mjs';
import { buildLedgerEntries, formatLedgerResult } from './ledger.mjs';
import { formatGateResult, runGate } from './gate.mjs';
import {
  gateStatus,
  installGate,
  pauseReviewGate,
  recoverReviewGate,
  resumeReviewGate,
  uninstallGate,
  verifyPrerequisites,
} from './install.mjs';
import { runPrePush } from './prepush.mjs';

function parseArgs(args) {
  const options = {};
  const positional = [];
  const valueFlags = new Set(['base', 'head', 'branch', 'author', 'risk', 'native-evidence', 'repo', 'reason', 'state-root', 'ref-type', 'finding', 'report', 'pr', 'heading', 'log']);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (valueFlags.has(key)) {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`--${key} requires a value.`);
      options[key] = next;
      index += 1;
    } else if (key.startsWith('no-')) {
      options[key.slice(3)] = false;
    } else {
      options[key] = true;
    }
  }
  return { options, positional };
}

function print(value, json = false) {
  process.stdout.write(`${json ? JSON.stringify(value, null, 2) : value}\n`);
}

// Git feeds the pre-push ref updates on stdin. Consume the STREAM rather than
// the raw descriptor. Two descriptor-based spellings are both wrong here:
// `fs/promises`'s readFile rejects a numeric fd outright ("path must be of
// type string"), which rejected every push; and `readFileSync(0)` can fail
// with EAGAIN once fd 0 is non-blocking, which on POSIX is caused by merely
// touching `process.stdin` — so a TTY guard written against that property
// creates the very hazard it looks defensive about. Reading the stream leaves
// readiness to libuv, so a payload split across chunks is assembled rather
// than truncated, on every platform.
//
// `isatty(0)` answers the interactive case WITHOUT constructing that stream,
// so an operator invocation reports no refs instead of blocking on EOF.
// Bounded: the reader retains every chunk and the parser then builds a ref
// array from all of it, so an oversized payload would grow until the heap gave
// out. Refuse past the bound instead — throwing here ends the iteration, which
// destroys the stream, and the hook's own catch reports it as a failed push.
async function readHookInput() {
  if (isatty(0)) return '';
  // Count BYTES, so keep the chunks as Buffers and decode once at the end.
  // Decoding first and measuring `String.length` would count UTF-16 code
  // units, and a non-BMP character costs four UTF-8 bytes but only two of
  // those — a limit named and reported in bytes would then pass nearly twice
  // its stated size. Ref names may legitimately be non-ASCII.
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > LIMITS.maxHookInputBytes) {
      throw new Error(
        `Pre-push input exceeded ${LIMITS.maxHookInputBytes} bytes. Push fewer refs at once, or report this if an ordinary push reached that size.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { options, positional } = parseArgs(rest);
  const repoRoot = options.repo || process.cwd();
  if (options.help) {
    print(HELP);
    return;
  }
  if (command === '--version' || command === 'version') {
    print(GATE_VERSION);
    return;
  }
  if (command === 'init') {
    print(await initializeRepository(repoRoot), true);
    return;
  }
  if (command === 'doctor') {
    print(await verifyPrerequisites(await findRepoRoot(repoRoot)), true);
    return;
  }
  if (command === 'gate' && options.detach) {
    const root = await findRepoRoot(repoRoot);
    print(await startDetachedGate({
      cliPath: fileURLToPath(import.meta.url),
      args: rest,
      cwd: process.cwd(),
      logPath: options.log ? path.resolve(options.log) : defaultDetachLogPath(root),
      exclusive: !options.log,
    }), true);
    return;
  }
  if (command === 'gate') {
    const result = await runGate({
      repoRoot,
      base: options.base,
      head: options.head,
      branch: options.branch,
      author: options.author,
      risk: options.risk,
      nativeEvidence: options['native-evidence'],
      stateRoot: options['state-root'],
      force: options.force,
      dryRun: options['dry-run'],
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    print(options.json ? result : formatGateResult(result), options.json);
    if (!['pass', 'planned'].includes(result.status)) process.exitCode = 1;
    return;
  }
  if (command === 'defer') {
    const result = await deferFindings({
      repoRoot,
      stateRoot: options['state-root'],
      base: options.base,
      head: options.head,
      branch: options.branch,
      reportId: options.report,
      findingIds: String(options.finding || '').split(',').map((id) => id.trim()).filter(Boolean),
      reason: options.reason,
    });
    print(result, true);
    return;
  }
  if (command === 'ledger') {
    const result = await buildLedgerEntries({
      repoRoot,
      stateRoot: options['state-root'],
      pr: options.pr ?? positional[0],
      write: Boolean(options.write),
      heading: options.heading,
    });
    print(options.json ? result : formatLedgerResult(result), options.json);
    return;
  }
  if (command === 'watch') {
    const result = await runWatcher({
      repoRoot,
      stateRoot: options['state-root'],
      once: options.once,
      github: options.github !== false,
      progress: options.daemon ? () => {} : (message) => process.stderr.write(`${message}\n`),
    });
    if (!options.daemon) print(result, true);
    return;
  }
  if (command === 'pre-push') {
    const input = await readHookInput();
    const result = await runPrePush({
      repoRoot,
      stateRoot: options['state-root'],
      remoteName: positional[0],
      input,
    });
    print(result, true);
    return;
  }
  if (command === 'design-evidence') {
    // Same check the pre-push hook runs, so an agent can settle it before
    // pushing. Committed history only: the base is the real merge base of
    // --base (default origin/main) and --head (default HEAD).
    const root = await findRepoRoot(repoRoot);
    const headSha = await resolveCommit(root, options.head || 'HEAD');
    const baseSha = await mergeBase(root, await resolveCommit(root, options.base || 'origin/main'), headSha);
    const branch = options.branch || await currentBranch(root);
    if (!branch) {
      throw new Error('design-evidence needs a branch name to derive the evidence folder; pass --branch NAME on a detached HEAD.');
    }
    // `--ref-type tag` checks a tag the way the hook will (any reviews
    // folder); the default is the branch rule, whatever the name looks like.
    const refType = options['ref-type'] === undefined ? 'branch' : String(options['ref-type']);
    if (refType !== 'branch' && refType !== 'tag') {
      throw new Error(`--ref-type must be "branch" or "tag"; received ${JSON.stringify(refType)}.`);
    }
    const refusal = await guiEvidenceRefusal({
      repoRoot: root, identity: { baseSha, headSha }, branch, refType,
    });
    if (refusal) {
      process.stderr.write(`${refusal}\n`);
      process.exitCode = 1;
      return;
    }
    print(`GUI evidence gate: ${branch} at ${headSha.slice(0, 12)} carries its evidence (or is not a GUI diff).`);
    return;
  }
  if (command === 'install') {
    print(await installGate({ repoRoot, dryRun: options['dry-run'], start: options.start !== false }), true);
    return;
  }
  if (command === 'uninstall') {
    print(await uninstallGate({ repoRoot, dryRun: options['dry-run'] }), true);
    return;
  }
  if (command === 'status') {
    print(await gateStatus({ repoRoot }), true);
    return;
  }
  if (command === 'pause') {
    print(await pauseReviewGate({ repoRoot, reason: options.reason }), true);
    return;
  }
  if (command === 'resume') {
    print(await resumeReviewGate({ repoRoot }), true);
    return;
  }
  if (command === 'recover') {
    print(await recoverReviewGate({ repoRoot, reason: options.reason }), true);
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    print(HELP);
    return;
  }
  throw new Error(`Unknown review-gate command: ${command} ${positional.join(' ')}`.trim());
}

// A detached gate (see detach.mjs) reports its exit code in its log.
const detachedLog = process.env[DETACHED_LOG_ENV];
if (detachedLog) {
  delete process.env[DETACHED_LOG_ENV];
  process.once('exit', (code) => appendDetachedExitMarker(detachedLog, process.exitCode ?? code));
}

main().catch((error) => {
  process.stderr.write(`Shared review gate: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
