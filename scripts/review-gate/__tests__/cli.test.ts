import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { LIMITS } from '../constants.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

/**
 * These drive the real `cli.mjs` as a subprocess with stdin attached, because
 * that glue is exactly what shipped broken: every unit test called
 * `runPrePush({ input })` directly, so the one line that reads git's ref
 * updates off fd 0 was never executed and the hook rejected every push.
 */
/**
 * `chunks` are written one at a time, each after the event loop has turned, so
 * the child can drain what is available before the next arrives. Writing the
 * whole payload and EOF together — the only shape the first version of these
 * tests used — never exercises a reader that must resume.
 */
function runCli(args: string[], chunks: string[]) {
  // spawn, not execFile: the async execFile has no `input` option, so passing
  // one silently leaves the child's stdin open and a correct implementation
  // blocks forever waiting for EOF.
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // A child that stops reading early makes the remaining write fail with
    // EPIPE/EOF. That is the child's behaviour under test, not a harness
    // failure, so let the assertions judge it from the exit code and stderr
    // instead of crashing the worker with an unhandled error event.
    child.stdin.on('error', () => {});

    const pending = [...chunks];
    const writeNext = () => {
      if (!pending.length) {
        child.stdin.end();
        return;
      }
      child.stdin.write(pending.shift(), () => setTimeout(writeNext, 5));
    };
    writeNext();
  });
}

function refLine(branch: string) {
  return `refs/heads/${branch} ${'a'.repeat(40)} refs/heads/${branch} ${'b'.repeat(40)}\n`;
}

describe('review-gate CLI pre-push stdin', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it('shows subcommand help without an installed policy or repository', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sentinel-help-'));
    dirs.push(scratch);
    const result = await runCli(['gate', '--help', '--repo', scratch], []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Rove Sentinel');
    expect(result.stderr).toBe('');
  });

  it('reads git ref updates off stdin instead of rejecting the descriptor', async () => {
    const result = await runCli(['pre-push', '--repo', process.cwd(), 'origin'], []);

    // The shipped bug surfaced here: fs/promises rejects a numeric fd, so the
    // hook died before it could evaluate any attestation.
    expect(result.stderr).not.toContain('must be of type string');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ reviewed: 0, bypassed: 0 });
  });

  it('actually parses what stdin carries rather than ignoring it', async () => {
    // Positive control for the assertion above: an empty stdin legitimately
    // yields the no-op result, so that result alone cannot prove the pipe was
    // read. A real ref line must take a DIFFERENT path — here it reaches
    // repository resolution and fails, because the target is not a git
    // checkout. Pointing at a non-repository keeps this bounded: it can never
    // reach the daemon or spend a review.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'rove-gate-cli-'));
    dirs.push(scratch);

    const result = await runCli(['pre-push', '--repo', scratch, 'origin'], [refLine('topic')]);

    expect(result.stderr).not.toContain('must be of type string');
    expect(result.stdout).not.toContain('"reviewed": 0');
    expect(result.code).not.toBe(0);
  });

  it('refuses an oversized push instead of buffering it without limit', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'rove-gate-cli-'));
    dirs.push(scratch);
    const line = refLine('bulk');
    const payload = line.repeat(Math.ceil((LIMITS.maxHookInputBytes + 4096) / line.length));

    const result = await runCli(['pre-push', '--repo', scratch, 'origin'], [payload]);

    // A controlled refusal, not a heap failure — and the bound can only be
    // reached by summing chunks across loop iterations, so this is also the
    // only assertion here that depends on the reader RESUMING after a drain.
    expect(result.stderr).toContain('Pre-push input exceeded');
    expect(result.code).not.toBe(0);
  });

  it('measures the limit in bytes, not UTF-16 code units', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'rove-gate-cli-'));
    dirs.push(scratch);
    // U+1D11E is four UTF-8 bytes but only two UTF-16 code units. This payload
    // is over the byte limit while its String.length stays well under it, so a
    // reader that decodes first and measures `.length` lets it straight
    // through — the limit is named and reported in bytes.
    const glyph = '𝄞';
    const payload = glyph.repeat(Math.ceil((LIMITS.maxHookInputBytes + 4096) / 4));
    expect(payload.length).toBeLessThan(LIMITS.maxHookInputBytes);

    const result = await runCli(['pre-push', '--repo', scratch, 'origin'], [payload]);

    expect(result.stderr).toContain('Pre-push input exceeded');
    expect(result.code).not.toBe(0);
  });

  // Still NOT covered: a SUCCESSFUL resume across a mid-line split. Three
  // attempts at forcing one were vacuous — they passed unchanged against a
  // reader hard-coded to stop after the first chunk, because two small writes
  // are coalesced by the pipe into a single read, and an oversized payload
  // makes such a reader exit early, which surfaces as a write failure in the
  // parent rather than an observable error from the child. A test that cannot
  // fail is worse than an acknowledged gap, so this records the gap.
});
