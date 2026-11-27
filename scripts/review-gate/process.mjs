import { spawn } from 'node:child_process';

import { LIMITS } from './constants.mjs';

const activeChildren = new Map();
let processLaunchBlocks = 0;

export class ProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProcessError';
    Object.assign(this, details);
  }
}

export function processTreeCleanupFailureCode(error) {
  if (
    error?.code === 'ORPHANED_PROCESS_TREE' ||
    error?.terminationError?.code === 'ORPHANED_PROCESS_TREE'
  ) return 'ORPHANED_PROCESS_TREE';
  if (
    error?.code === 'PROCESS_TREE_CLEANUP_FAILED' ||
    error?.terminationError
  ) return 'PROCESS_TREE_CLEANUP_FAILED';
  return null;
}

export function blockNewProcessLaunches() {
  processLaunchBlocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    processLaunchBlocks = Math.max(0, processLaunchBlocks - 1);
  };
}

/** Whether the shutdown fence is up. Queued reviewer lanes consult this so
 *  they drain instead of spawning tasks that would each fail (and retry)
 *  against the launch block. */
export function newProcessLaunchesBlocked() {
  return processLaunchBlocks > 0;
}

// Latched at the exact moment a provider process-tree cleanup fails, BEFORE
// the rejection unwinds to any caller. Reviewer lanes consult it before
// dequeuing, which closes the race where a sibling lane finishes and pulls a
// new task while the failure is still propagating toward the pool's local
// halt flag. Reset at the start of each review run: the cross-run policy
// (watcher pause until operator recovery) is handled by the daemon, and a
// sticky latch would make every later review in a resumed watcher fail.
// The first latch records WHICH process raised it: a launch refusal that
// cannot name its cause sends the operator hunting (PR #519 lost two rounds to
// a refusal whose origin had been swallowed three frames earlier).
let providerCleanupFailure = null;

export function latchProviderCleanupFailure({ command, pid, reason } = {}) {
  providerCleanupFailure ??= {
    command: command ? String(command) : 'unknown process',
    pid: Number.isInteger(pid) ? pid : null,
    reason: reason ? String(reason) : 'process-tree cleanup failed',
  };
}

export function providerCleanupFailureLatched() {
  return providerCleanupFailure !== null;
}

/** One line naming the process whose cleanup raised the latch, or null. */
export function providerCleanupFailureDetail() {
  if (!providerCleanupFailure) return null;
  const { command, pid, reason } = providerCleanupFailure;
  return `${command}${pid === null ? '' : ` (pid ${pid})`}: ${reason}`;
}

/** The provider whose cleanup failed, for the pause record: repair traces its descendants. */
export function providerCleanupFailureRecord() {
  if (!providerCleanupFailure) return null;
  return { pid: providerCleanupFailure.pid, command: providerCleanupFailure.command };
}

export const REPAIR_COMMAND = 'npx --no-install rove-sentinel repair';
// For a repository whose active engine predates 1.20.1, which has no `repair`:
// one line, the same in PowerShell, Windows PowerShell and a POSIX shell.
// Node (which npx needs anyway) downloads the 1.20.3 archive and that release's
// SHA256SUMS, refuses the archive unless its SHA-256 matches, as the updater
// checks an engine, writes it to a new temporary folder and runs its repair
// through npx (npm's npx-cli.js beside Node on Windows, else the npx on PATH),
// with ROVE_SENTINEL_REPAIR_BOOTSTRAP set, so that repair, should it stop
// before it can report, asks for a report instead of this line again;
// the 1.20.3 launcher then runs repair on the newest engine at hand (not 1.20.1,
// which misread the pauses those repositories may hold, nor 1.20.2, whose
// process listing and update failed from this line). It uses
// Node's fetch, as the updater does, with the same proxy support. The script holds no double quote, $, backtick or !, so no shell
// rewrites it, and it calls no PowerShell module, so a constrained or
// module-less PowerShell runs it as well.
export const REPAIR_BOOTSTRAP_SCRIPT = "const v='1.20.3',u='https://github.com/jayyanez/rove-sentinel/releases/download/v'+v,c=require('crypto'),f=require('fs'),p=require('path'),o=require('os'),x=require('child_process');(async()=>{const k=process.argv.slice(1),z=k.filter((a)=>['--stop-orphans','--dry-run','--json'].includes(a)===false);if(z.length>0)throw new Error('Not a repair option: '+z.join(' ')+' (only --stop-orphans, --dry-run and --json are passed on)');const g=async(n)=>{const r=await fetch(u+'/'+n);if(r.ok===false)throw new Error(n+': HTTP '+r.status);return Buffer.from(await r.arrayBuffer())};const a=await g('rove-sentinel-'+v+'.tgz'),s=(await g('SHA256SUMS')).toString().split(/\\r?\\n/).find((l)=>l.endsWith(' rove-sentinel-'+v+'.tgz')),ok=Boolean(s)&&s.split(/\\s+/)[0].toLowerCase()===c.createHash('sha256').update(a).digest('hex');if(ok===false)throw new Error('Checksum mismatch: the archive was not run');const t=p.join(f.mkdtempSync(p.join(o.tmpdir(),'rove-sentinel-')),'rove-sentinel-'+v+'.tgz');f.writeFileSync(t,a);const w=process.platform==='win32',n=p.join(p.dirname(process.execPath),'node_modules','npm','bin','npx-cli.js'),q=['--yes','--package',t,'--','rove-sentinel','repair'].concat(k),e=Object.assign({},process.env,{ROVE_SENTINEL_REPAIR_BOOTSTRAP:v}),r=w===false?x.spawnSync('npx',q,{stdio:'inherit',env:e}):f.existsSync(n)?x.spawnSync(process.execPath,[n].concat(q),{stdio:'inherit',env:e}):x.spawnSync('npx '+q.map((a)=>JSON.stringify(a)).join(' '),{stdio:'inherit',shell:true,env:e});process.exitCode=r.status??1})().catch((e)=>{console.error(e.message);process.exitCode=1})";
export const REPAIR_BOOTSTRAP = `node -e "${REPAIR_BOOTSTRAP_SCRIPT}"`;
// repair's options pass after `--`; the script refuses any other.
export const repairBootstrap = (options = []) => (options.length ? `${REPAIR_BOOTSTRAP} -- ${options.join(' ')}` : REPAIR_BOOTSTRAP);
// Set by the bootstrap for the repair it runs.
export const REPAIR_BOOTSTRAP_VARIABLE = 'ROVE_SENTINEL_REPAIR_BOOTSTRAP';

/** repair's options as the CLI reads them: the last of `--name` and `--no-name` wins. */
export function repairOptions(argv = []) {
  const on = (name) => argv.lastIndexOf(`--${name}`) > argv.lastIndexOf(`--no-${name}`);
  // A later --no-repo cancels it: the CLI then repairs its working directory.
  const at = argv.lastIndexOf('--repo');
  const repo = at > argv.lastIndexOf('--no-repo') && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null;
  return { stopOrphans: on('stop-orphans'), dryRun: on('dry-run'), json: on('json'), repo };
}

/**
 * The step a repair that stopped with an error before it could report gives,
 * so that whoever runs it always knows what to do next: the bootstrap, with
 * the options repair was given, in the checkout it was given; or, when the
 * bootstrap's own repair stopped, no command but to stop and report.
 */
export function repairStoppedStep(error, argv = [], { env = process.env } = {}) {
  const message = String(error?.message || error || 'unknown error').trim().replace(/[.\s]+$/, '');
  if (env[REPAIR_BOOTSTRAP_VARIABLE]) {
    return { state: 'repair', status: 'blocked', detail: `Repair stopped with an error before it could report: ${message}. This is the repair the bootstrap line runs, so running that line again would stop the same way: stop and report this output.` };
  }
  const options = repairOptions(argv);
  const line = repairBootstrap([options.stopOrphans && '--stop-orphans', options.dryRun && '--dry-run', options.json && '--json'].filter(Boolean));
  return {
    state: 'repair', status: 'blocked',
    detail: `Repair stopped with an error before it could report: ${message}. The Next line, run in the repository, downloads a verified release and runs its repair (docs/troubleshooting.md, "Repair on an engine before 1.20.1"); if it also stops without a Next line, stop and report both outputs.`,
    next: options.repo ? `Run in ${options.repo}: ${line}` : line,
  };
}
// The two safety pauses a failed provider cleanup writes. Earlier engines wrote
// the same openings, so repair recognises their pauses too.
export const SAFETY_PAUSE_REASONS = {
  orphaned: 'Windows provider parent exited before inherited pipes closed',
  unverified: 'Provider process-tree cleanup could not be verified',
};
export function safetyPauseReason(code) {
  return `${code === 'ORPHANED_PROCESS_TREE' ? SAFETY_PAUSE_REASONS.orphaned : SAFETY_PAUSE_REASONS.unverified}; provider processes may remain. Run: ${REPAIR_COMMAND}`;
}
// The whole reasons of the safety pauses engines before 1.20.1 wrote, with no kind.
const LEGACY_SAFETY_PAUSES = Object.values(SAFETY_PAUSE_REASONS)
  .map((opening) => `${opening}; inspect remaining provider processes before resuming.`);
// The whole reason of the pause an activation of an engine before 1.20.1 wrote.
const LEGACY_UPDATE_PAUSE = /^Automatic Sentinel update to \d+\.\d+\.\d+$/;
const PAUSE_KINDS = ['provider-cleanup', 'update', 'manual'];
/**
 * Who paused: `provider-cleanup`, `update` and `manual` are recorded from 1.20.1.
 * A pause without a kind was written by an earlier engine or by a person, who
 * may type any reason, those engines' own included: the two leave the same
 * record, so it may be a person's and is never lifted.
 */
export function pauseKind(record) {
  return PAUSE_KINDS.includes(record?.kind) ? record.kind : 'manual';
}
/**
 * What a pause with no kind would be had an earlier engine written it, when its
 * reason is, in full, one those engines wrote (`provider-cleanup` or `update`),
 * else null. It says what to check, never that the pause may be lifted.
 */
export function legacyPause(record) {
  if (!record || PAUSE_KINDS.includes(record.kind)) return null;
  const reason = String(record.reason ?? '');
  if (LEGACY_SAFETY_PAUSES.includes(reason)) return 'provider-cleanup';
  return LEGACY_UPDATE_PAUSE.test(reason) ? 'update' : null;
}
export function isSafetyPause(record) {
  return pauseKind(record) === 'provider-cleanup';
}

export function resetProviderCleanupLatch() {
  providerCleanupFailure = null;
}

export function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  if (env.ROVE_REVIEW_ALLOW_API_BILLING !== '1') {
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  return env;
}

/**
 * The environment for an npm or npx command Sentinel starts, without what an
 * npm that started Sentinel left in it: npm passes its whole configuration to
 * what it runs (`npx --package <archive>` leaves `npm_config_package`, and the
 * user's `.npmrc` settings, such as `allow-scripts`, as if typed on the command
 * line), and a nested npx would act on them. The command reads npm's
 * configuration from its files, as in a new shell.
 */
export function withoutNpmRunEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^npm_/i.test(key)));
}

async function waitForPosixTreeExit(child, pid, timeoutMs, killProcess = process.kill) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let groupAlive = false;
    try {
      killProcess(-pid, 0);
      groupAlive = true;
    } catch {
      groupAlive = false;
    }
    const childAlive = child.exitCode === null && child.signalCode == null;
    if (!groupAlive && !childAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForWindowsProcessExit(_child, pid, timeoutMs, killProcess = process.kill) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let processAlive = false;
    try {
      killProcess(pid, 0);
      processAlive = true;
    } catch (error) {
      processAlive = error?.code === 'EPERM';
    }
    if (!processAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function windowsProcessIsAlive(pid, killProcess = process.kill) {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForChildClose(child, timeoutMs) {
  return await new Promise((resolve) => {
    let finished = false;
    const finish = (closed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

function killChildBestEffort(child) {
  if (child.exitCode !== null) return;
  try {
    child.kill();
  } catch {}
}

function releaseChildHandles(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref?.();
  activeChildren.delete(child);
}

export async function terminateProcessTree(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    killProcess = process.kill,
    waitForExit = waitForPosixTreeExit,
    waitForWindowsExit = waitForWindowsProcessExit,
    waitForNaturalClose = waitForChildClose,
    isWindowsProcessAlive = windowsProcessIsAlive,
    graceMs = 2_000,
    taskkillTimeoutMs = LIMITS.taskkillTimeoutMs,
  } = {},
  ) {
  if (!child.pid) return;
  if (platform === 'win32') {
    const throwOrphanedTree = () => {
      const error = new Error(`Provider process ${child.pid} exited before its inherited pipes closed. Windows can no longer identify that process tree by the recorded parent PID, and provider processes may remain. Run: npx --no-install rove-sentinel repair`);
      error.code = 'ORPHANED_PROCESS_TREE';
      throw error;
    };
    // `exit` precedes `close` for a normal piped child. Give both an already-
    // exited child and a still-running child the same bounded chance to prove
    // inherited stdio closed before classifying the tree or invoking taskkill.
    if (await waitForNaturalClose(
      child,
      Math.min(graceMs, 100),
    )) return;
    if (child.exitCode !== null || !isWindowsProcessAlive(child.pid, killProcess)) {
      // A root that exited on its own can still be draining its pipes on a
      // loaded host: give it the whole grace to close them before calling its
      // tree orphaned. A descendant that holds them still fails closed, only
      // later. Under load, one in about 35 overflowing children that exited at
      // once was called orphaned after 100 ms, and the fence paused the
      // watcher (1.21.2).
      if (await waitForNaturalClose(child, graceMs)) return;
      throwOrphanedTree();
    }
    try {
      await new Promise((resolve, reject) => {
        const killer = spawnProcess(
          'taskkill.exe',
          ['/pid', String(child.pid), '/t', '/f'],
          { stdio: 'ignore', windowsHide: true },
        );
        let finished = false;
        const finish = (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => {
          try {
            killer.kill();
          } catch {}
          finish(new Error(`taskkill timed out while terminating provider process tree ${child.pid}.`));
        }, taskkillTimeoutMs);
        killer.once('error', (error) => {
          finish(new Error(`Could not start taskkill for provider process tree ${child.pid}: ${error.message}`));
        });
        killer.once('exit', (code, signal) => {
          if (code === 0) finish();
          else finish(new Error(`taskkill failed for provider process tree ${child.pid} with ${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}.`));
        });
      });
    } catch (error) {
      killChildBestEffort(child);
      throw error;
    }
    if (!await waitForWindowsExit(child, child.pid, graceMs, killProcess)) {
      killChildBestEffort(child);
      throw new Error(`Provider process ${child.pid} remained alive after taskkill reported success.`);
    }
    return;
  }
  const send = (signal) => {
    try {
      killProcess(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  send('SIGTERM');
  if (await waitForExit(child, child.pid, graceMs, killProcess)) return;
  send('SIGKILL');
  if (!await waitForExit(child, child.pid, graceMs, killProcess)) {
    throw new Error(`Provider process tree ${child.pid} did not exit after SIGTERM and SIGKILL.`);
  }
}

export async function terminateActiveProcesses() {
  await Promise.allSettled(
    [...activeChildren.values()].map((terminate) => terminate()),
  );
}

export async function runProcess(
  command,
  args,
  {
    cwd,
    env = process.env,
    input,
    timeoutMs = 60_000,
    maxOutputBytes = LIMITS.maxProcessOutputBytes,
    maxStderrBytes = LIMITS.maxProcessStderrBytes,
    allowFailure = false,
    allowDuringShutdown = false,
    outputLimitMessage,
    // Return stdout as a Buffer instead of a UTF-8 string (binary-safe reads
    // such as `git cat-file -p` of an image blob).
    binary = false,
    // A cleanup failure normally latches the provider launch fence (§5): an
    // unverified PROVIDER tree may still be acting. Best-effort read-only
    // evidence sweeps opt out — a `git grep` that outran its output bound and
    // exited before its pipes drained is not a provider tree, and latching on
    // it skipped every reviewer of the run (PR #519). The rejection itself is
    // unchanged; only the run-wide fence is left alone.
    latchCleanupFailure = true,
    // Test seam: the process-tree terminator the error paths call.
    terminateTree = terminateProcessTree,
  } = {},
) {
  if (processLaunchBlocks > 0 && !allowDuringShutdown) {
    throw new ProcessError(`Shared review watcher stopped before launching ${command}.`, {
      code: 'TERMINATED',
      command,
    });
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let overflowed = false;
    let timedOut = false;

    const decodeStdout = () => (binary ? Buffer.concat(stdout) : Buffer.concat(stdout).toString('utf8'));
    const snapshot = () => ({
      stdout: decodeStdout(),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });

    const finishError = async (message, details) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let terminationError;
      try {
        await terminateTree(child);
      } catch (error) {
        terminationError = error;
        if (latchCleanupFailure) {
          latchProviderCleanupFailure({ command, pid: child.pid, reason: error?.message });
        }
        releaseChildHandles(child);
      }
      reject(new ProcessError(
        terminationError
          ? `${message}. Process-tree cleanup also failed: ${terminationError.message}`
          : message,
        { result: snapshot(), ...details, terminationError },
      ));
    };

    const captureStdout = (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        overflowed = true;
        void finishError(outputLimitMessage || `${command} exceeded its ${maxOutputBytes}-byte output limit`, {
          code: 'OUTPUT_LIMIT',
          command,
        });
        return;
      }
      stdout.push(chunk);
    };

    const captureStderr = (chunk) => {
      if (settled) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > maxStderrBytes && stderr.length > 1) {
        const dropped = stderr.shift();
        stderrBytes -= dropped.length;
      }
    };

    child.stdout.on('data', captureStdout);
    child.stderr.on('data', captureStderr);
    child.stdin?.once('error', (error) => {
      void finishError(`Could not write input to ${command}: ${error.message}`, {
        code: 'STDIN_ERROR',
        command,
        cause: error,
      });
    });
    child.once('error', (error) => {
      activeChildren.delete(child);
      void finishError(`Could not start ${command}: ${error.message}`, {
        code: 'SPAWN_ERROR',
        command,
        cause: error,
      });
    });
    child.once('close', (code, signal) => {
      activeChildren.delete(child);
      if (settled || overflowed || timedOut) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        signal,
        stdout: decodeStdout(),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (result.code !== 0 && !allowFailure) {
        const detail = String(result.stderr || result.stdout).trim().slice(0, 2000);
        reject(
          new ProcessError(`${command} exited with code ${result.code}${detail ? `: ${detail}` : ''}`, {
            code: 'NON_ZERO_EXIT',
            command,
            result,
          }),
        );
        return;
      }
      resolve(result);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void finishError(`${command} exceeded its ${timeoutMs}ms time limit`, {
        code: 'TIMEOUT',
        command,
      });
    }, timeoutMs);
    timer.unref?.();
    activeChildren.set(child, () => finishError(`Shared review watcher stopped ${command}.`, {
      code: 'TERMINATED',
      command,
    }));

    if (!child.stdin) {
      void finishError(`Could not open standard input for ${command}.`, {
        code: 'STDIN_ERROR',
        command,
      });
    } else if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
