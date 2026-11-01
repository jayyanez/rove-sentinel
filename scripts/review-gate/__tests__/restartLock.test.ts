import { spawn } from 'node:child_process';
import { access, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reviewPolicySnapshot } from '../context.mjs';
import { runWatcher } from '../daemon.mjs';
import { recoverStaleDaemonState, stopDaemon } from '../install.mjs';
import {
  acquireDaemonLock,
  atomicWriteJson,
  bootTimeMs,
  daemonLockOutlivedOwner,
  daemonOwnerIsHealthy,
  ensureState,
  readJson,
  withTakeoverMarker,
} from '../storage.mjs';

const BOOT = Date.parse('2026-08-03T12:00:00.000Z');
const BEFORE_BOOT = '2026-08-03T11:59:50.000Z';
const AFTER_BOOT = '2026-08-03T12:00:10.000Z';
const DEAD_OWNER = 'dead-owner-token';
const LOCK = { pid: 4242, ownerToken: DEAD_OWNER };
const HEARTBEAT = { pid: 4242, ownerToken: DEAD_OWNER, at: BEFORE_BOOT };
const proofOptions = { isAlive: () => false, bootTime: () => BOOT };

const temporaryDirectories: string[] = [];

async function stateRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sentinel-restart-lock-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A lock and heartbeat as a restart leaves them. */
async function leftByRestart(heartbeat: Record<string, unknown> = {}, lock: Record<string, unknown> = {}) {
  const paths = await ensureState(await stateRoot());
  await atomicWriteJson(paths.lock, { ...LOCK, ...lock });
  await atomicWriteJson(paths.heartbeat, { ...HEARTBEAT, ...heartbeat });
  return paths;
}

async function exists(target: string) {
  return await access(target).then(() => true, () => false);
}

/** The id of a process that really ended. */
async function endedProcessId() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => { child.once('close', resolve); });
  return child.pid as number;
}

/** Holds whoever reaches `target` through `openFile` until `release` is called. */
function heldAt(target: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const arrival = new Promise<void>((resolve) => { reached = resolve; });
  const openFile = async (file: string, flags: string, mode: number) => {
    if (file === target) {
      reached();
      await released;
    }
    return await open(file, flags, mode);
  };
  return { openFile, arrival, release };
}

/** Holds a starter between taking the marker and reading the lock again. */
function heldAtSecondLook(paths: { lock: string }) {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reached = () => {};
  const arrival = new Promise<void>((resolve) => { reached = resolve; });
  let looks = 0;
  const read = async (target: string, fallback?: unknown) => {
    if (target === paths.lock && ++looks === 2) {
      reached();
      await released;
    }
    return await readJson(target, fallback);
  };
  return { read, arrival, release };
}

describe('the boot time', () => {
  it('reads a moment in the past on this machine', () => {
    const booted = bootTimeMs();
    expect(booted).toBeGreaterThan(0);
    expect(booted).toBeLessThan(Date.now());
  });

  it('is the wall clock less the uptime', () => {
    expect(bootTimeMs({ now: () => 10_000, uptime: () => 4 })).toBe(6_000);
  });

  it.each([
    ['throws', () => { throw new Error('uptime is unavailable'); }],
    ['is zero', () => 0],
    ['is negative', () => -5],
    ['is not a number', () => Number.NaN],
    ['is endless', () => Number.POSITIVE_INFINITY],
    ['is missing', () => undefined],
  ])('is unknown when the uptime %s', (_name, uptime) => {
    expect(bootTimeMs({ uptime })).toBeNull();
  });
});

describe('what proves a lock outlived its owner', () => {
  it('takes a heartbeat of this owner older than the boot, and its process gone', () => {
    expect(daemonLockOutlivedOwner(LOCK, HEARTBEAT, proofOptions)).toBe(true);
  });

  it('refuses a heartbeat newer than the boot', () => {
    expect(daemonLockOutlivedOwner(LOCK, { ...HEARTBEAT, at: AFTER_BOOT }, proofOptions)).toBe(false);
  });

  it('refuses a heartbeat at the very moment of the boot', () => {
    expect(daemonLockOutlivedOwner(LOCK, { ...HEARTBEAT, at: new Date(BOOT).toISOString() }, proofOptions)).toBe(false);
  });

  it('refuses a live process, however old its heartbeat', () => {
    expect(daemonLockOutlivedOwner(LOCK, HEARTBEAT, { ...proofOptions, isAlive: () => true })).toBe(false);
  });

  it('takes EPERM for a process that exists, as only ESRCH says it is gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(daemonLockOutlivedOwner(LOCK, HEARTBEAT, { bootTime: () => BOOT })).toBe(false);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(daemonLockOutlivedOwner(LOCK, HEARTBEAT, { bootTime: () => BOOT })).toBe(true);
  });

  it('refuses when the boot time is missing', () => {
    expect(daemonLockOutlivedOwner(LOCK, HEARTBEAT, { ...proofOptions, bootTime: () => null })).toBe(false);
    expect(daemonLockOutlivedOwner(LOCK, HEARTBEAT, {
      ...proofOptions,
      bootTime: () => bootTimeMs({ uptime: () => { throw new Error('uptime is unavailable'); } }),
    })).toBe(false);
  });

  it.each([
    ['no heartbeat', null],
    ['one of another owner', { ...HEARTBEAT, ownerToken: 'another-owner-token' }],
    ['one of another process', { ...HEARTBEAT, pid: 4243 }],
    ['one without a time', { pid: 4242, ownerToken: DEAD_OWNER }],
    ['one with a time that does not parse', { ...HEARTBEAT, at: 'yesterday' }],
  ])('refuses %s', (_name, heartbeat) => {
    expect(daemonLockOutlivedOwner(LOCK, heartbeat, proofOptions)).toBe(false);
  });

  it('refuses a lock without an owner token, even beside a heartbeat without one', () => {
    expect(daemonLockOutlivedOwner({ pid: 4242 }, { pid: 4242, at: BEFORE_BOOT }, proofOptions)).toBe(false);
  });

  it('refuses when the clock moved backward after the restart', () => {
    const hour = 3_600_000;
    const heartbeatAt = BOOT - 10_000;
    const bootTime = () => bootTimeMs({ now: () => BOOT + 240_000 - hour, uptime: () => 240 });
    expect(daemonLockOutlivedOwner(LOCK, { ...HEARTBEAT, at: new Date(heartbeatAt).toISOString() }, { isAlive: () => false, bootTime })).toBe(false);
  });

  it('takes a crash in this boot once the clock moved forward past its heartbeat: the process really is gone', () => {
    const day = 86_400_000;
    const heartbeat = { ...HEARTBEAT, at: new Date(BOOT + 60_000).toISOString() };
    const bootTime = () => bootTimeMs({ now: () => BOOT + 120_000 + day, uptime: () => 120 });
    expect(daemonLockOutlivedOwner(LOCK, heartbeat, { isAlive: () => false, bootTime })).toBe(true);
  });

  it('refuses a live owner when the clock moved forward past its heartbeat', () => {
    const day = 86_400_000;
    const heartbeatAt = BOOT + 60_000;
    const bootTime = () => bootTimeMs({ now: () => BOOT + 120_000 + day, uptime: () => 120 });
    const heartbeat = { ...HEARTBEAT, at: new Date(heartbeatAt).toISOString() };
    expect(bootTime()).toBeGreaterThan(heartbeatAt);
    expect(daemonLockOutlivedOwner(LOCK, heartbeat, { isAlive: () => true, bootTime })).toBe(false);
  });
});

describe('a starter finding a lock', () => {
  it('replaces a lock left by a restart, on nothing but the machine it runs on', async () => {
    // This is the incident: before the rule every start refused with "dead PID".
    const pid = await endedProcessId();
    const paths = await leftByRestart({ pid, at: '2001-01-01T00:00:00.000Z' }, { pid });

    const lock = await acquireDaemonLock(paths);

    expect(lock).toMatchObject({ replaced: { pid, lastHeartbeatAt: '2001-01-01T00:00:00.000Z' } });
    await expect(readJson(paths.lock)).resolves.toMatchObject({ pid: process.pid, ownerToken: lock.ownerToken });
    expect(await exists(paths.takeover)).toBe(false);
    await lock.release();
    expect(await exists(paths.lock)).toBe(false);
  });

  it.each([
    ['a heartbeat newer than the boot', { at: AFTER_BOOT }, 'refusing automatic removal'],
    ['a heartbeat of another owner', { ownerToken: 'another-owner-token' }, 'refusing automatic removal'],
  ])('keeps the lock on %s', async (_name, heartbeat, message) => {
    const paths = await leftByRestart(heartbeat);
    const before = await readFile(paths.lock, 'utf8');

    await expect(acquireDaemonLock(paths, proofOptions)).rejects.toThrow(message);

    expect(await readFile(paths.lock, 'utf8')).toBe(before);
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('keeps the lock when a power cut tore the heartbeat', async () => {
    const paths = await leftByRestart();
    await writeFile(paths.heartbeat, '{"pid":42');

    await expect(acquireDaemonLock(paths, proofOptions)).rejects.toThrow('refusing automatic removal');

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
  });

  it('keeps the lock when the boot time is missing', async () => {
    const paths = await leftByRestart();

    await expect(acquireDaemonLock(paths, { ...proofOptions, bootTime: () => null })).rejects.toThrow('refusing automatic removal');

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
  });

  it('keeps the lock when its process id was reused after the boot', async () => {
    // This test process is the unrelated program that received the id.
    const paths = await leftByRestart({ pid: process.pid }, { pid: process.pid });

    await expect(acquireDaemonLock(paths, { bootTime: () => BOOT })).rejects.toThrow('refusing to trust a possibly reused PID');

    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: DEAD_OWNER });
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('keeps the lock of an owner that may not be signalled', async () => {
    const paths = await leftByRestart();
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });

    await expect(acquireDaemonLock(paths, { bootTime: () => BOOT })).rejects.toThrow('refusing to trust a possibly reused PID');

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
  });

  it('keeps the lock and leaves no marker when it cannot remove it', async () => {
    const paths = await leftByRestart();
    const denied = Object.assign(new Error('in use'), { code: 'EPERM' });
    const remove = vi.fn(async (target: string) => {
      if (target === paths.lock) throw denied;
      await rm(target, { force: true });
    });

    await expect(acquireDaemonLock(paths, { ...proofOptions, remove })).rejects.toBe(denied);

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('frees the marker when it cannot create its own lock', async () => {
    const paths = await leftByRestart();
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    let lockOpens = 0;
    const openFile = async (target: string, flags: string, mode: number) => {
      if (target === paths.lock && ++lockOpens === 2) throw denied;
      return await open(target, flags, mode);
    };

    await expect(acquireDaemonLock(paths, { ...proofOptions, openFile })).rejects.toBe(denied);

    expect(await exists(paths.takeover)).toBe(false);
  });
});

describe('starters meeting over a lock left by a restart', () => {
  it('lets one of two starters held at the marker take it', async () => {
    const paths = await leftByRestart();
    const hold = heldAt(paths.takeover);
    const first = acquireDaemonLock(paths, { ...proofOptions, openFile: hold.openFile, ownerTokenFactory: () => 'first-owner-token' });
    const second = acquireDaemonLock(paths, { ...proofOptions, openFile: hold.openFile, ownerTokenFactory: () => 'second-owner-token' });
    await hold.arrival;
    // Let the second reach the same point before either moves.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    hold.release();

    const results = await Promise.all([first, second]);

    const owners = results.filter(Boolean);
    expect(owners).toHaveLength(1);
    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: owners[0].ownerToken });
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('gives way to a winner it finds after judging the old lock dead', async () => {
    const paths = await leftByRestart();
    const hold = heldAt(paths.takeover);
    const late = acquireDaemonLock(paths, { ...proofOptions, openFile: hold.openFile, ownerTokenFactory: () => 'late-owner-token' });
    await hold.arrival;

    const winner = await acquireDaemonLock(paths, { ...proofOptions, ownerTokenFactory: () => 'winner-token' });
    hold.release();

    await expect(late).resolves.toBeNull();
    expect(winner.ownerToken).toBe('winner-token');
    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: 'winner-token' });
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('gives way to any lock that changed before it held the marker', async () => {
    const paths = await leftByRestart();
    const hold = heldAt(paths.takeover);
    const late = acquireDaemonLock(paths, { ...proofOptions, openFile: hold.openFile });
    await hold.arrival;
    await atomicWriteJson(paths.lock, { pid: 7, ownerToken: 'replacement-owner' });
    hold.release();

    await expect(late).resolves.toBeNull();
    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: 'replacement-owner' });
  });

  it('gives way to a lock it cannot read yet, which only its new owner can be writing', async () => {
    const paths = await leftByRestart();
    const hold = heldAt(paths.takeover);
    const late = acquireDaemonLock(paths, { ...proofOptions, openFile: hold.openFile });
    await hold.arrival;
    await writeFile(paths.lock, '');
    hold.release();

    await expect(late).resolves.toBeNull();
    expect(await readFile(paths.lock, 'utf8')).toBe('');
  });

  it('gives way to nothing when the second look fails for another reason', async () => {
    const paths = await leftByRestart();
    const failure = Object.assign(new Error('disk'), { code: 'EIO' });
    let looks = 0;
    const read = async (target: string, fallback?: unknown) => {
      if (target === paths.lock && ++looks === 2) throw failure;
      return await readJson(target, fallback);
    };

    await expect(acquireDaemonLock(paths, { ...proofOptions, read })).rejects.toBe(failure);

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('takes the name when the lock vanished before it held the marker', async () => {
    const paths = await leftByRestart();
    const hold = heldAt(paths.takeover);
    const late = acquireDaemonLock(paths, { ...proofOptions, openFile: hold.openFile, ownerTokenFactory: () => 'late-owner-token' });
    await hold.arrival;
    await rm(paths.lock);
    hold.release();

    await expect(late).resolves.toMatchObject({ ownerToken: 'late-owner-token' });
    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: 'late-owner-token' });
  });

  it('gives way to a plain starter that takes the name inside its removal', async () => {
    const paths = await leftByRestart();
    const remove = async (target: string, options: { force: boolean }) => {
      await rm(target, options);
      if (target === paths.lock) await writeFile(paths.lock, `${JSON.stringify({ pid: 7, ownerToken: 'plain-starter' })}\n`, { flag: 'wx' });
    };

    await expect(acquireDaemonLock(paths, { ...proofOptions, remove })).resolves.toBeNull();

    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: 'plain-starter' });
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('gives way beside a marker in use, and stays silent about it', async () => {
    const paths = await leftByRestart();
    await writeFile(paths.takeover, '');

    await expect(acquireDaemonLock(paths, proofOptions)).resolves.toBeNull();

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(true);
  });

  it('refuses beside a marker whose holder never finished, naming the file to delete', async () => {
    const paths = await leftByRestart();
    await writeFile(paths.takeover, '');
    await utimes(paths.takeover, new Date(BOOT), new Date(BOOT));

    await expect(acquireDaemonLock(paths, proofOptions)).rejects.toThrow(`delete ${paths.takeover}`);

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(true);
  });

  it('announces its owner while it still holds the marker', async () => {
    const paths = await leftByRestart();
    const seen: unknown[] = [];
    const lock = await acquireDaemonLock(paths, {
      ...proofOptions,
      announceOwner: async (ownerToken: string) => { seen.push(ownerToken, await exists(paths.takeover)); },
    });

    expect(seen).toEqual([lock.ownerToken, true]);
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('keeps the lock it took when announcing its owner fails', async () => {
    const paths = await leftByRestart();
    const lock = await acquireDaemonLock(paths, { ...proofOptions, announceOwner: async () => { throw new Error('disk full'); } });

    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: lock.ownerToken });
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('gives way to a replacement in progress rather than naming recover', async () => {
    const paths = await leftByRestart({}, { pid: process.pid, ownerToken: 'replacing-owner-token' });
    await writeFile(paths.takeover, '');

    await expect(acquireDaemonLock(paths, proofOptions)).resolves.toBeNull();
  });

  it('gives way when the lock changed between its reads, rather than naming recover', async () => {
    const paths = await leftByRestart();
    let looks = 0;
    const read = async (target: string, fallback?: unknown) => {
      if (target !== paths.lock) return await readJson(target, fallback);
      looks += 1;
      return looks === 1 ? LOCK : { pid: process.pid, ownerToken: 'replacing-owner-token' };
    };

    await expect(acquireDaemonLock(paths, { ...proofOptions, bootTime: () => null, read })).resolves.toBeNull();
  });

  it('gives way when the heartbeat came between its reads, rather than naming recover', async () => {
    const owner = { pid: process.pid, ownerToken: 'replacing-owner-token' };
    const paths = await leftByRestart({}, owner);
    let beats = 0;
    const read = async (target: string, fallback?: unknown) => {
      if (target !== paths.heartbeat) return await readJson(target, fallback);
      beats += 1;
      return beats === 1 ? HEARTBEAT : { ...owner, at: new Date().toISOString() };
    };

    await expect(acquireDaemonLock(paths, { ...proofOptions, read })).resolves.toBeNull();
  });

  it('counts a marker that vanished under it as in use: its holder has finished', async () => {
    const paths = await leftByRestart();
    const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
    await writeFile(paths.takeover, '');

    await expect(withTakeoverMarker(paths, async () => 'worked', { inspect: async () => { throw gone; } }))
      .rejects.toMatchObject({ code: 'TAKEOVER_IN_USE' });
  });

  it('never leaves two owners among real processes racing', async () => {
    const storage = pathToFileURL(path.resolve('scripts/review-gate/storage.mjs')).href;
    const racer = path.join(await stateRoot(), 'racer.mjs');
    await writeFile(racer, [
      `import { acquireDaemonLock, ensureState, writeHeartbeat } from ${JSON.stringify(storage)};`,
      'const paths = await ensureState(process.argv[2]);',
      'process.stdout.write("ready\\n");',
      'await new Promise((resolve) => { process.stdin.once("data", resolve); });',
      'const announceOwner = (ownerToken) => writeHeartbeat(paths, { ownerToken });',
      'const lock = await acquireDaemonLock(paths, { bootTime: () => Date.now() + 60000, announceOwner }).catch((error) => ({ refused: error.message }));',
      'process.stdout.write(`${JSON.stringify({ owner: lock?.ownerToken ?? null, refused: lock?.refused ?? null })}\\n`);',
      'setTimeout(() => process.exit(0), 750);',
    ].join('\n'));
    for (let round = 0; round < 3; round += 1) {
      const pid = await endedProcessId();
      const paths = await leftByRestart({ pid, at: '2001-01-01T00:00:00.000Z' }, { pid });
      const racers = Array.from({ length: 8 }, () => {
        const child = spawn(process.execPath, [racer, paths.root], { stdio: ['pipe', 'pipe', 'inherit'] });
        let output = '';
        const ready = new Promise<void>((resolve) => {
          child.stdout.on('data', (chunk) => {
            output += chunk;
            if (output.includes('ready')) resolve();
          });
        });
        const ended = new Promise<string>((resolve) => { child.once('close', () => resolve(output)); });
        return { child, ready, ended };
      });
      await Promise.all(racers.map(({ ready }) => ready));
      for (const { child } of racers) child.stdin.write('go\n');

      const outcomes = (await Promise.all(racers.map(({ ended }) => ended)))
        .map((output) => JSON.parse(output.trim().split('\n').at(-1) as string));

      const owners = outcomes.filter(({ owner }) => owner).map(({ owner }) => owner);
      expect(outcomes).toHaveLength(8);
      expect(owners).toHaveLength(1);
      expect(outcomes.filter(({ refused }) => refused)).toEqual([]);
      await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: owners[0] });
      expect(await exists(paths.takeover)).toBe(false);
    }
  }, 30_000);
});

describe('a person beside a takeover', () => {
  const recover = (paths: Awaited<ReturnType<typeof ensureState>>) => recoverStaleDaemonState(
    { repoRoot: process.cwd(), paths },
    { reason: 'a stale watcher to recover', recoverResources: async () => 0 },
  );

  it('recover waits for a takeover in progress, and removes no lock under it', async () => {
    const paths = await leftByRestart();
    const hold = heldAtSecondLook(paths);
    const starter = acquireDaemonLock(paths, { ...proofOptions, read: hold.read, ownerTokenFactory: () => 'new-owner-token' });
    await hold.arrival;

    await expect(recover(paths)).rejects.toThrow('Retry shortly');

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(true);
    hold.release();
    await expect(starter).resolves.toMatchObject({ ownerToken: 'new-owner-token' });
    await expect(readJson(paths.lock)).resolves.toMatchObject({ ownerToken: 'new-owner-token' });
  });

  it('a stop waits for a takeover in progress, and removes no lock under it', async () => {
    const paths = await leftByRestart();
    const hold = heldAtSecondLook(paths);
    const starter = acquireDaemonLock(paths, { ...proofOptions, read: hold.read, ownerTokenFactory: () => 'new-owner-token' });
    await hold.arrival;

    await expect(stopDaemon({ repoRoot: process.cwd(), paths }, { isAlive: () => false })).rejects.toThrow('Retry shortly');

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    await expect(readJson(paths.heartbeat)).resolves.toMatchObject({ ownerToken: DEAD_OWNER });
    hold.release();
    await expect(starter).resolves.toMatchObject({ ownerToken: 'new-owner-token' });
  });

  it('a starter gives way while recover holds the marker', async () => {
    const paths = await leftByRestart();
    let duringRecovery: unknown;

    await withTakeoverMarker(paths, async () => {
      duringRecovery = await acquireDaemonLock(paths, proofOptions);
    });

    expect(duringRecovery).toBeNull();
    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('recover leaves a marker left behind to the person, and works once it is deleted', async () => {
    const paths = await leftByRestart();
    await writeFile(paths.takeover, '');
    await utimes(paths.takeover, new Date(BOOT), new Date(BOOT));

    await expect(recover(paths)).rejects.toThrow(`delete ${paths.takeover}`);
    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(true);

    await rm(paths.takeover);
    await expect(recover(paths)).resolves.toMatchObject({ recovered: true, previousLockPid: LOCK.pid });
    expect(await exists(paths.lock)).toBe(false);
    const lock = await acquireDaemonLock(paths);
    expect(lock.replaced).toBeUndefined();
  });

  it('a stop leaves a marker left behind to recover', async () => {
    const paths = await leftByRestart();
    await writeFile(paths.takeover, '');
    await utimes(paths.takeover, new Date(BOOT), new Date(BOOT));

    await expect(stopDaemon({ repoRoot: process.cwd(), paths }, { isAlive: () => false })).rejects.toThrow(`delete ${paths.takeover}`);

    await expect(readJson(paths.lock)).resolves.toMatchObject(LOCK);
    expect(await exists(paths.takeover)).toBe(true);
  });

  it('recover still refuses a healthy owner, and frees the marker', async () => {
    const paths = await ensureState(await stateRoot());
    const owner = { pid: process.pid, ownerToken: 'healthy-owner-token' };
    await atomicWriteJson(paths.lock, owner);
    await atomicWriteJson(paths.heartbeat, { ...owner, at: new Date().toISOString() });

    await expect(recover(paths)).rejects.toThrow('is healthy at PID');

    await expect(readJson(paths.lock)).resolves.toMatchObject(owner);
    expect(await exists(paths.takeover)).toBe(false);
  });

  it('a stop that finds no lock has nothing to remove, whatever marker it finds', async () => {
    const paths = await ensureState(await stateRoot());
    await writeFile(paths.takeover, '');

    await expect(stopDaemon({ repoRoot: process.cwd(), paths }, { isAlive: () => false })).resolves.toBe(true);

    expect(await exists(paths.takeover)).toBe(true);
  });
});

describe('a watcher started after a restart', () => {
  it('announces itself with a heartbeat that makes it healthy', async () => {
    const pid = await endedProcessId();
    const paths = await leftByRestart({ pid, at: '2001-01-01T00:00:00.000Z' }, { pid });
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));
    let healthyWhileHoldingMarker = false;

    await runWatcher({
      repoRoot: process.cwd(), stateRoot: paths.root, once: true, github: false,
      recoverResources: async () => {}, recoverQueuedClaims: async () => {},
      acquireLock: (target: typeof paths, options: { announceOwner: (ownerToken: string) => Promise<void> }) => acquireDaemonLock(target, {
        ...options,
        announceOwner: async (ownerToken: string) => {
          await options.announceOwner(ownerToken);
          healthyWhileHoldingMarker = await exists(paths.takeover)
            && daemonOwnerIsHealthy(await readJson(paths.lock), await readJson(paths.heartbeat));
        },
      }),
    });

    expect(healthyWhileHoldingMarker).toBe(true);
  });

  it('replaces the lock, runs, and records that it did', async () => {
    const pid = await endedProcessId();
    const paths = await leftByRestart({ pid, at: '2001-01-01T00:00:00.000Z' }, { pid });
    await atomicWriteJson(paths.policy, reviewPolicySnapshot({ charter: '# Installed charter', lessons: '# Installed lessons', config: {} }));

    let duringRecovery = false;
    const outcome = await runWatcher({
      repoRoot: process.cwd(), stateRoot: paths.root, once: true, github: false,
      recoverResources: async () => {
        const heartbeat = await readJson(paths.heartbeat);
        duringRecovery = heartbeat.activity === 'recovering' && daemonOwnerIsHealthy(await readJson(paths.lock), heartbeat);
      },
      recoverQueuedClaims: async () => {},
    });

    expect(outcome).toMatchObject({ alreadyRunning: false });
    expect(duringRecovery).toBe(true);
    expect(await exists(paths.lock)).toBe(false);
    const events = await Promise.all((await readdir(paths.events)).map((name) => readJson(path.join(paths.events, name))));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'restart-lock-replaced', previousLockPid: pid, lastHeartbeatAt: '2001-01-01T00:00:00.000Z',
    }));
  });
});
