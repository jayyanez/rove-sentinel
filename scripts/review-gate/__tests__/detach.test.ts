import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_MARKER_PREFIX, defaultDetachLogPath, stripDetachFlags } from '../detach.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function waitForExitMarker(logPath: string, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = await readFile(logPath, 'utf8').catch(() => '');
    if (text.includes(EXIT_MARKER_PREFIX)) return text;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No exit marker in ${logPath} after ${timeoutMs} ms`);
}

describe('detached gate runs (no console window)', () => {
  it('drops only the launcher flags from the forwarded gate arguments', () => {
    expect(stripDetachFlags(['--', '--base', 'origin/main', '--detach', '--log', 'x.log', '--head', 'HEAD']))
      .toEqual(['--base', 'origin/main', '--head', 'HEAD']);
  });

  it('defaults the log to a unique name in the checkout\'s ignored output folder', () => {
    const now = new Date('2026-09-22T23:48:40.506Z');
    const log = defaultDetachLogPath(path.join('D:', 'repo'), now, 4242);
    expect(log).toBe(path.join('D:', 'repo', 'output', 'review-gate-20260922-234840-506Z-4242.log'));
    // Two launches in the same second no longer share a log.
    expect(defaultDetachLogPath('r', new Date('2026-09-22T23:48:40.507Z'), 4242)).not.toBe(defaultDetachLogPath('r', now, 4242));
    expect(defaultDetachLogPath('r', now, 4243)).not.toBe(defaultDetachLogPath('r', now, 4242));
  });

  it('returns at once with the pid and log, and the log ends with the gate\'s exit code', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rove-gate-detach-'));
    temporaryDirectories.push(directory);
    const logPath = path.join(directory, 'gate.log');
    // An unresolvable head makes the detached gate fail fast and
    // deterministically, without launching any reviewer.
    const launcher = spawnSync(process.execPath, [
      CLI, 'gate', '--detach', '--log', logPath, '--repo', REPO,
      '--base', 'HEAD', '--head', 'rove-detach-test-missing-ref',
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(launcher.status).toBe(0);
    const started = JSON.parse(launcher.stdout);
    expect(started).toMatchObject({ log: logPath });
    expect(Number.isInteger(started.pid)).toBe(true);

    const log = await waitForExitMarker(logPath);
    expect(log).toContain('Shared review gate:');
    expect(log.trimEnd().endsWith(`${EXIT_MARKER_PREFIX} 1`)).toBe(true);
  });
});
