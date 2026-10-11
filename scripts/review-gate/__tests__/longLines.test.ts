import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../constants.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { runGate, settleShardWave, shardFailureSummary } from '../gate.mjs';
import { readPatch } from '../git.mjs';
import { INCOMPLETE_REVIEW, runShardReviewer } from '../providers.mjs';
import {
  boundPatchContext,
  CONTINUATION_PREFIX,
  partitionShards,
  shardPartShards,
  splitPatchByFile,
} from '../shards.mjs';
import { attestationIdentity, ensureState, readAttestation, readReport } from '../storage.mjs';

// A diff that touches a file of very long lines failed the gate closed on
// every run (boxkite, engine 1.11.2, 2026-10-10): six one-line edits to a
// file of 300-character lines became a section of well over 100 KB, Codex
// read the shard's parts in one command, the tool elided the middle of that
// output, and the retry repeated the same instruction.

if (process.platform === 'win32') {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function temporary(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const LONG_FILE = 'crates/app/i18n/metadata.toml';
const CODE_FILES = ['crates/app/src/workspace.rs', 'crates/app/src/canvas.rs', 'crates/app/src/every_object.rs'];
const EDITED_LINES = [40, 420, 800, 1180, 1560, 1940];

/** One 300-character line of the long-line file. */
function longLine(index: number, edited = false) {
  const head = `key_${String(index).padStart(4, '0')} = "${edited ? 'edited' : 'text'} `;
  return `${head}${'m'.repeat(299 - head.length)}"`;
}

/**
 * The reported shape, synthetic: a file of about 2,100 lines of 300
 * characters with six scattered one-line edits, and three small code files.
 */
async function makeLongLineRepository() {
  const root = await temporary('sentinel-long-lines-');
  const write = async (file: string, text: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  const metadata = (edited: boolean) => `${Array.from({ length: 2100 }, (_, index) => longLine(index, edited && EDITED_LINES.includes(index))).join('\n')}\n`;
  const code = (file: string, value: number) => `// ${file}\npub fn value() -> u32 {\n    ${value}\n}\n`;
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/long-lines.git');
  await write(LONG_FILE, metadata(false));
  for (const file of CODE_FILES) await write(file, code(file, 1));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  await write(LONG_FILE, metadata(true));
  for (const file of CODE_FILES) await write(file, code(file, 2));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'edit six metadata lines and three code files');
  const head = git(root, 'rev-parse', 'HEAD').trim();
  return { root, base, head, policy: reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n' }) };
}

/**
 * A provider that reads every file of its assignment in ONE command, as Codex
 * did, behind a tool that shows at most `limitBytes` of one command's output
 * and elides the middle of anything longer. It reports its review complete
 * only when nothing it read was elided.
 */
function batchingProvider({ limitBytes = 38 * 1024 } = {}) {
  const commands: { files: string[]; texts: string[]; bytes: number; complete: boolean }[] = [];
  const runner = async (_command: string, args: string[]) => {
    const prompt = String(args.at(-1));
    const listed = [...prompt.matchAll(/^- (.*shard-\d+\.part-\d+-of-\d+\.diff)$/gm)].map((match) => match[1]);
    const single = /^Read (.*shard-\d+(?:\.part-\d+-of-\d+)?\.diff) ONCE in full/m.exec(prompt)?.[1];
    const files = listed.length ? listed : [single as string];
    const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const bytes = Buffer.byteLength(texts.join(''), 'utf8');
    const complete = bytes <= limitBytes;
    commands.push({ files, texts, bytes, complete });
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
      review_complete: complete,
      effort_request: null,
      summary: complete
        ? 'Read every assigned hunk in full.'
        : `All ${files.length} shard parts were read once, but the combined tool response was truncated, preventing full inspection of the assigned diff; this is not a completed review.`,
      candidates: [],
    }));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { commands, runner };
}

function gateOptions(repository: Awaited<ReturnType<typeof makeLongLineRepository>>, stateRoot: string, runner: unknown) {
  return {
    repoRoot: repository.root,
    stateRoot,
    base: repository.base,
    head: repository.head,
    policy: repository.policy,
    author: 'human',
    risk: 'high',
    availableProviders: ['codex'],
    shardReviewer: (options: Record<string, unknown>) => runShardReviewer({ ...options, runner } as never),
    scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
    deterministicLanes: async () => ({ lanes: [], findings: [] }),
    coordinator: vi.fn(),
  };
}

const withoutContinuation = (part: string) => (part.startsWith(CONTINUATION_PREFIX) ? part.slice(part.indexOf('\n') + 1) : part);

describe('a diff that touches a file of very long lines', () => {
  it('ends in a completed review when the provider reads all the parts in one command', async () => {
    const repository = await makeLongLineRepository();
    const stateRoot = await temporary('sentinel-long-lines-state-');
    const provider = batchingProvider();

    const result = await runGate(gateOptions(repository, stateRoot, provider.runner));

    expect(result.status).toBe('pass');
    // The long-line file shares its shard with the three small code files.
    const patch = await readPatch(repository.root, repository.base, repository.head);
    const [shard, ...others] = partitionShards(patch, { maxShards: LIMITS.shardMaxCountHigh });
    expect(others).toEqual([]);
    expect([...shard.files].sort()).toEqual([...CODE_FILES, LONG_FILE].sort());
    expect(result.shards).toEqual([expect.objectContaining({ files: 4, provider: 'codex', delivery: 'part-by-part' })]);
    // First the whole shard: several parts in one command, more than the tool
    // shows, so the reviewer reported it incomplete.
    const [whole, ...parts] = provider.commands;
    expect(whole.files.length).toBeGreaterThan(1);
    expect(whole.complete).toBe(false);
    // Then one part per reviewer: each command holds one file that fits, and
    // together they are every byte of the shard.
    expect(parts.length).toBe(whole.files.length);
    expect(parts.every((command) => command.files.length === 1 && command.complete)).toBe(true);
    expect(parts.every((command) => command.bytes <= LIMITS.shardPartMaxBytes)).toBe(true);
    const seen = parts
      .sort((a, b) => a.files[0].localeCompare(b.files[0], 'en', { numeric: true }))
      .map((command) => withoutContinuation(command.texts[0]))
      .join('');
    expect(seen).toBe(shard.patch);
    // The record says how the shard was reviewed and by which passes.
    expect(result.providerExecutions).toEqual([
      expect.objectContaining({ provider: 'codex', shard: 1, status: 'failed' }),
      ...parts.map(() => expect.objectContaining({ provider: 'codex', shard: 1, status: 'complete' })),
    ]);
    const report = await readReport(await ensureState(stateRoot), result.reportId);
    expect(report.reviewerSummaries[0].summary).toContain(`Reviewed one part per reviewer (${parts.length} parts)`);
  });

  it('still fails closed when a part itself cannot be read whole: an incomplete read is never a PASS', async () => {
    const repository = await makeLongLineRepository();
    const stateRoot = await temporary('sentinel-long-lines-state-');
    // A tool that shows less than one part: no way of handing the parts over helps.
    const provider = batchingProvider({ limitBytes: 8 * 1024 });

    const error = await runGate(gateOptions(repository, stateRoot, provider.runner)).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/1 shard reviewer\(s\) failed after retry, leaving their hunks unreviewed; the gate failed closed\./);
    expect(error.message).toContain('The retry, one part per reviewer, then failed in');
    expect(error.message).toContain(`largest: ${LONG_FILE}`);
    // Two attempts per hunk, never three: the whole shard once, each part once.
    expect(provider.commands.filter((command) => command.files.length === 1).length).toBe(provider.commands[0].files.length);
    const paths = await ensureState(stateRoot);
    const context = await import('../gate.mjs').then(({ createGateContext }) => createGateContext(repository.root, { stateRoot }));
    expect(await readAttestation(paths, attestationIdentity({
      repository: context.repository, baseSha: repository.base, headSha: repository.head, policyDigest: repository.policy.policyDigest,
    }))).toBeNull();
  });

  it('gives the long-line file fewer context lines and leaves ordinary code its 80', async () => {
    const repository = await makeLongLineRepository();
    const raw = git(repository.root, 'diff', '--no-ext-diff', '--find-renames', '--find-copies', '--unified=80',
      `${repository.base}...${repository.head}`);
    const patch = await readPatch(repository.root, repository.base, repository.head);
    const section = (text: string, file: string) => splitPatchByFile(text).find((entry) => entry.file === file)!.text;
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

    // Six edits with 80 lines either side were ~290 KB; bounded by bytes, each
    // side keeps what 4 KB holds (13 lines of 300 characters).
    expect(bytes(section(raw, LONG_FILE))).toBeGreaterThan(250 * 1024);
    expect(bytes(section(patch, LONG_FILE))).toBeLessThan(56 * 1024);
    const hunks = section(patch, LONG_FILE).split(/^(?=@@ )/m).slice(1);
    expect(hunks.length).toBe(EDITED_LINES.length);
    for (const hunk of hunks) {
      const lines = hunk.split('\n').slice(1).filter(Boolean);
      const change = lines.findIndex((line) => line.startsWith('-'));
      expect(lines.filter((line) => line.startsWith(' ')).length).toBe(26);
      expect(change).toBe(13);
    }
    // Sections that already fit are Git's own bytes.
    for (const file of CODE_FILES) expect(section(patch, file)).toBe(section(raw, file));
    // Only context was dropped: every added and removed line is still there.
    const changed = (text: string) => text.split('\n').filter((line) => /^[+-](?![+-]{2} )/.test(line));
    expect(changed(patch)).toEqual(changed(raw));

    // And it is still the same change: applied to the base, it gives the head.
    const patchFile = path.join(await temporary('sentinel-long-lines-patch-'), 'bounded.diff');
    await writeFile(patchFile, patch);
    git(repository.root, 'checkout', '--quiet', '--detach', repository.base);
    git(repository.root, 'apply', '--index', patchFile);
    expect(git(repository.root, 'write-tree').trim()).toBe(git(repository.root, 'rev-parse', `${repository.head}^{tree}`).trim());
  });
});

describe('context bounded by bytes', () => {
  const header = ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt'];
  const wide = (index: number) => ` line ${index} ${'w'.repeat(100)}`;

  it('keeps the lines nearest each change, splits a hunk whose context no longer meets, and renumbers it', () => {
    const body = [
      ...Array.from({ length: 10 }, (_, index) => wide(index + 1)),
      '-old eleven',
      '+new eleven',
      ...Array.from({ length: 20 }, (_, index) => wide(index + 12)),
      '+added after thirty-one',
      ...Array.from({ length: 10 }, (_, index) => wide(index + 32)),
    ];
    const patch = [...header, '@@ -1,41 +1,42 @@ fn heading()', ...body, ''].join('\n');
    // 250 bytes hold two of these lines; the floor is three.
    const bounded = boundPatchContext(patch, { sideBytes: 250, minLines: 3 });
    expect(bounded.split('\n')).toEqual([
      ...header,
      '@@ -8,7 +8,7 @@',
      wide(8), wide(9), wide(10),
      '-old eleven',
      '+new eleven',
      wide(12), wide(13), wide(14),
      '@@ -29,6 +29,7 @@',
      wide(29), wide(30), wide(31),
      '+added after thirty-one',
      wide(32), wide(33), wide(34),
      '',
    ]);
    // A budget the hunk fits is the hunk byte for byte, heading included.
    expect(boundPatchContext(patch, { sideBytes: 1024 * 1024 })).toBe(patch);
  });

  it('bounds a patch whose hunks are longer than an argument list', () => {
    // A 450 KB added file made `push(...hunk)` throw RangeError (1.12.0 gate
    // finding on itself); so did a long hunk that needed trimming.
    const count = 200_000;
    const added = ['diff --git a/n b/n', 'new file mode 100644', '--- /dev/null', '+++ b/n', `@@ -0,0 +1,${count} @@`,
      ...Array.from({ length: count }, () => '+x'), ''].join('\n');
    expect(boundPatchContext(added)).toBe(added);
    const trimmed = boundPatchContext([...header, `@@ -1,${count + 1} +1,${count + 1} @@`,
      ...Array.from({ length: count }, (_, index) => ` ${index}`), '-old', '+new', ''].join('\n'), { sideBytes: 1024 * 1024 * 1024 });
    expect(trimmed.split('\n').length).toBe(count + 7);
    const removed = [...header, `@@ -1,${count + 200} +1,200 @@`, ...Array.from({ length: 100 }, () => wide(1)),
      ...Array.from({ length: count }, () => '-gone'), ...Array.from({ length: 100 }, () => wide(2)), ''].join('\n');
    const bounded = boundPatchContext(removed, { sideBytes: 250, minLines: 3 }).split('\n');
    expect(bounded[3]).toBe(`@@ -98,${count + 6} +98,6 @@`);
    expect(bounded.length).toBe(3 + 1 + 3 + count + 3 + 1);
  });

  it('keeps a hunk that starts at the first line, the no-newline marker, and text that is not a hunk', () => {
    const patch = [
      ...header,
      '@@ -1,6 +1,6 @@',
      '-first',
      '+FIRST',
      wide(2), wide(3), wide(4), wide(5),
      '-last',
      '\\ No newline at end of file',
      '+LAST',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(boundPatchContext(patch, { sideBytes: 1, minLines: 1 }).split('\n')).toEqual([
      ...header,
      '@@ -1,2 +1,2 @@',
      '-first',
      '+FIRST',
      wide(2),
      '@@ -5,2 +5,2 @@',
      wide(5),
      '-last',
      '\\ No newline at end of file',
      '+LAST',
      '\\ No newline at end of file',
      '',
    ]);
    // Counts that do not match the body: left exactly as written.
    const malformed = [...header, '@@ -1,9 +1,9 @@', ' one', '+two', 'not a diff line', ''].join('\n');
    expect(boundPatchContext(malformed, { sideBytes: 1, minLines: 1 })).toBe(malformed);
    const newFile = ['diff --git a/n b/n', 'new file mode 100644', '--- /dev/null', '+++ b/n', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n');
    expect(boundPatchContext(newFile, { sideBytes: 1, minLines: 1 })).toBe(newFile);
  });
});

describe('a shard handed over one part per reviewer', () => {
  const incomplete = () => Object.assign(new Error('Provider reported an incomplete review; no PASS is permitted.'), { code: INCOMPLETE_REVIEW });
  const section = (file: string, lines: number) => [
    `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => `+${file} ${index} ${'x'.repeat(80)}`),
  ].join('\n');
  const bigShard = (extra = {}) => ({
    index: 2, kind: 'code', files: ['src/a.ts', 'src/b.ts'], changedLines: 700,
    patch: `${section('src/a.ts', 400)}\n${section('src/b.ts', 300)}\n`, ...extra,
  });

  it('cuts the shard into single-part shards that together are the shard, each blocker in exactly one', () => {
    const blocker = (file: string, title: string) => ({ priority: 'P2', file, title });
    const shard = bigShard({
      reverifyBlockers: [blocker('src/b.ts', 'in b'), blocker('src/a.ts', 'in a'), blocker('src/unknown.ts', 'elsewhere')],
      unassignedBlockers: [blocker('src/usage.ts', 'owned')],
    });
    const parts = shardPartShards(shard);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((part) => part.part)).toEqual(parts.map((_, index) => ({ index, count: parts.length })));
    expect(parts.every((part) => part.index === 2 && Buffer.byteLength(part.patch, 'utf8') <= LIMITS.shardPartMaxBytes)).toBe(true);
    expect(parts.map((part) => withoutContinuation(part.patch)).join('')).toBe(shard.patch);
    expect(parts.reduce((sum, part) => sum + part.changedLines, 0)).toBe(700);
    expect(parts[0].files).toEqual(['src/a.ts']);
    expect(parts.at(-1)!.files).toEqual(['src/b.ts']);
    const firstWithB = parts.findIndex((part) => part.files.includes('src/b.ts'));
    expect(parts.map((part) => part.reverifyBlockers.map((finding) => finding.title))).toEqual(
      parts.map((_, index) => [
        ...(index === firstWithB ? ['in b'] : []),
        ...(index === 0 ? ['in a', 'elsewhere'] : []),
      ]),
    );
    expect(parts.map((part) => part.unassignedBlockers.length)).toEqual(parts.map((_, index) => (index === 0 ? 1 : 0)));
    // A shard that fits one read is its own single part.
    const small = { index: 0, kind: 'code', files: ['src/s.ts'], changedLines: 2, patch: `${section('src/s.ts', 2)}\n` };
    expect(shardPartShards(small)).toEqual([expect.objectContaining({ files: ['src/s.ts'], patch: small.patch, part: { index: 0, count: 1 } })]);
  });

  it('retries an incomplete shard of several parts one part per reviewer and merges the answers', async () => {
    const shard = bigShard();
    const count = shardPartShards(shard).length;
    const calls: (number | 'whole')[] = [];
    const settled = await settleShardWave([shard], async (assigned) => {
      calls.push(assigned.part ? assigned.part.index : 'whole');
      if (!assigned.part) throw incomplete();
      return {
        provider: 'codex', roleIndex: 2, summary: `part ${assigned.part.index + 1} read`,
        candidates: [{ id: 'codex-2-0', title: `finding in part ${assigned.part.index + 1}` }],
      };
    });
    expect(calls.slice(0, 1)).toEqual(['whole']);
    expect([...calls.slice(1)].sort()).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(settled).toEqual([expect.objectContaining({ status: 'fulfilled', retried: true, delivery: 'part-by-part' })]);
    // Every part numbered its candidates from zero: the merge keeps them apart.
    expect(settled[0].value.candidates.map((candidate) => candidate.id)).toEqual(
      Array.from({ length: count }, (_, index) => `codex-2-${index}`),
    );
    expect(settled[0].value.candidates.map((candidate) => candidate.title)).toEqual(
      Array.from({ length: count }, (_, index) => `finding in part ${index + 1}`),
    );
  });

  it('counts the shard only when every part completes, and never gives a part a third attempt', async () => {
    const calls: (number | 'whole')[] = [];
    const settled = await settleShardWave([bigShard()], async (assigned) => {
      calls.push(assigned.part ? assigned.part.index : 'whole');
      if (!assigned.part || assigned.part.index === 1) throw incomplete();
      return { provider: 'codex', roleIndex: 2, summary: 'read', candidates: [] };
    });
    expect(settled[0]).toMatchObject({ status: 'rejected', retried: true, delivery: 'part-by-part' });
    expect(settled[0].reason.message).toMatch(/The retry, one part per reviewer, then failed in 1 of \d+ part\(s\): part 2: Provider reported an incomplete review/);
    expect(calls.filter((call) => call === 1).length).toBe(1);
    expect(calls.filter((call) => call === 'whole').length).toBe(1);
  });

  it('gives any other failure, and an incomplete shard of one part, the ordinary retry', async () => {
    const small = { index: 0, kind: 'code', files: ['src/s.ts'], changedLines: 2, patch: `${section('src/s.ts', 2)}\n` };
    const attempts = new Map<string, number>();
    const settled = await settleShardWave([bigShard(), small], async (assigned) => {
      const key = `${assigned.index}:${assigned.part ? assigned.part.index : 'whole'}`;
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      if (attempts.get(key) === 1) throw assigned.index === 0 ? incomplete() : new Error('codex exceeded its 300000ms time limit');
      return { provider: 'codex', roleIndex: assigned.index, summary: 'read', candidates: [] };
    });
    expect(settled.map((result) => [result.status, result.retried, result.delivery])).toEqual([
      ['fulfilled', true, undefined],
      ['fulfilled', true, undefined],
    ]);
    expect([...attempts]).toEqual([['2:whole', 2], ['0:whole', 2]]);
  });
});

describe('a rerun after a fail-closed round', () => {
  /** Three code files of 300 added lines each: three shards. */
  async function makeThreeShardRepository() {
    const root = await temporary('sentinel-rerun-');
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'remote', 'add', 'origin', 'https://github.com/example/rerun.git');
    await writeFile(path.join(root, 'README.md'), '# Fixture\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD').trim();
    await mkdir(path.join(root, 'src'), { recursive: true });
    for (const name of ['a', 'b', 'c']) {
      await writeFile(path.join(root, 'src', `${name}.ts`), `${Array.from({ length: 300 }, (_, index) => `export const ${name}${index} = ${index};`).join('\n')}\n`);
    }
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'three files');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    return { root, base, head, policy: reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n' }) };
  }

  it('keeps the shard reviews that completed and reviews again only the one that did not', async () => {
    const repository = await makeThreeShardRepository();
    const stateRoot = await temporary('sentinel-rerun-state-');
    let failing = true;
    const reviewer = vi.fn(async ({ provider, roleIndex, shard }) => {
      if (shard.files[0] === 'src/b.ts' && failing) throw new Error('codex exceeded its 300000ms time limit');
      return {
        provider, roleIndex, summary: `Reviewed ${shard.files[0]}.`,
        candidates: shard.files[0] === 'src/a.ts' ? [{
          title: 'A kept finding', priority: 'P3', confidence: 90, category: 'correctness', file: 'src/a.ts', line: 3,
          scenario: 's', evidence: 'e', proposed_test: 't',
        }] : [],
      };
    });
    const coordinator = vi.fn(async ({ candidates }) => ({
      summary: 'Adjudicated.',
      findings: candidates.map((candidate) => ({
        candidate_id: candidate.id, title: candidate.title, priority: 'P3', file: candidate.file, line: candidate.line,
        disposition: 'dismissed', reason: 'Not a defect.', scenario: 's', proposed_test: 't',
      })),
    }));
    const progress: string[] = [];
    const options = {
      repoRoot: repository.root, stateRoot, base: repository.base, head: repository.head, policy: repository.policy,
      author: 'human', risk: 'high', availableProviders: ['codex'], reviewer, coordinator,
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
      progress: (message: string) => progress.push(message),
    };
    const shardsOf = (from: number) => reviewer.mock.calls.slice(from).map(([call]) => call.shard.files[0]).sort();

    // First round: shard 2 fails twice; the gate fails closed and says what a rerun costs.
    const first = await runGate(options).catch((caught) => caught);
    expect(first.message).toMatch(/^1 shard reviewer\(s\) failed after retry, leaving their hunks unreviewed; the gate failed closed\. Rerun the gate: the 2 shard review\(s\) that completed are kept for this exact base, head and policy for 24 hours, so only the failed shard\(s\) are reviewed again\. If the same shard fails again, another rerun alone is unlikely to pass\./);
    expect(shardsOf(0)).toEqual(['src/a.ts', 'src/b.ts', 'src/b.ts', 'src/c.ts']);
    expect(coordinator).not.toHaveBeenCalled();
    const firstReport = await readReport(await ensureState(stateRoot), first.reportId);
    expect(firstReport.shards.map((entry) => entry.completed)).toEqual([true, false, true]);

    // Second round, same head: only shard 2 is reviewed, it fails again, and the message says it repeated.
    const second = await runGate(options).catch((caught) => caught);
    expect(shardsOf(4)).toEqual(['src/b.ts', 'src/b.ts']);
    expect(second.message).toContain('Shard(s) 2 failed in 2 consecutive runs of this head, so another rerun alone is unlikely to pass.');
    expect(second.message).toContain('shard 2, codex shard reviewer role 1 (src/b.ts; 1 part(s), ');
    // Each failure is described once.
    expect(second.message.split('codex exceeded its 300000ms time limit').length).toBe(2);
    expect(second.message).toContain('failed in 2 consecutive runs of this head): codex exceeded its 300000ms time limit');
    expect(progress.at(-1)).toContain('Reviewing 1 shard(s) (2 more completed in an earlier round of this exact head and are kept)');

    // Third round: the shard completes; the kept reviews' candidate is adjudicated afresh and the head passes.
    failing = false;
    const third = await runGate(options);
    expect(third.status).toBe('pass');
    expect(shardsOf(6)).toEqual(['src/b.ts']);
    expect(coordinator).toHaveBeenCalledTimes(1);
    expect(coordinator.mock.calls[0][0].candidates).toEqual([expect.objectContaining({ id: 'codex-0-0', title: 'A kept finding' })]);
    expect(third.shards.map((entry) => [entry.reused === true, typeof entry.reviewedAt])).toEqual([
      [true, 'string'], [false, 'undefined'], [true, 'string'],
    ]);
    const report = await readReport(await ensureState(stateRoot), third.reportId);
    expect(report.reviewerSummaries.map((entry) => entry.summary)).toEqual(['Reviewed src/a.ts.', 'Reviewed src/b.ts.', 'Reviewed src/c.ts.']);

    // The round ended in a report, so nothing is kept.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir((await ensureState(stateRoot)).shardCheckpoints)).toEqual([]);
    // A forced review of the head reviews every shard.
    await runGate({ ...options, force: true });
    expect(shardsOf(7)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('keeps nothing across a different head, a forced run, or a kept record that would not pass as a fresh answer', async () => {
    const repository = await makeThreeShardRepository();
    const stateRoot = await temporary('sentinel-rerun-state-');
    const reviewer = vi.fn(async ({ provider, roleIndex, shard }) => {
      if (shard.files[0] === 'src/b.ts') throw new Error('provider unavailable');
      return { provider, roleIndex, summary: 'Reviewed.', candidates: [] };
    });
    const options = {
      repoRoot: repository.root, stateRoot, base: repository.base, head: repository.head, policy: repository.policy,
      author: 'human', risk: 'high', availableProviders: ['codex'], reviewer, coordinator: vi.fn(),
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    };
    await expect(runGate(options)).rejects.toThrow(/the 2 shard review\(s\) that completed are kept/);
    expect(reviewer).toHaveBeenCalledTimes(4);

    // A forced run is a fresh review of every shard.
    await expect(runGate({ ...options, force: true })).rejects.toThrow(/failed after retry/);
    expect(reviewer).toHaveBeenCalledTimes(8);

    // A kept review from another provider, or one that is not a valid answer, is reviewed again.
    const paths = await ensureState(stateRoot);
    const { readdir } = await import('node:fs/promises');
    const [name] = await readdir(paths.shardCheckpoints);
    const stored = JSON.parse(await readFile(path.join(paths.shardCheckpoints, name), 'utf8'));
    const [first, second] = Object.keys(stored.shards);
    stored.shards[first].review.provider = 'claude';
    stored.shards[second].review.candidates = [{ title: 'no priority' }];
    await writeFile(path.join(paths.shardCheckpoints, name), JSON.stringify(stored));
    await expect(runGate(options)).rejects.toThrow(/failed after retry/);
    expect(reviewer).toHaveBeenCalledTimes(12);

    // A new head has its own identity: nothing of the old head's is kept.
    await writeFile(path.join(repository.root, 'src', 'd.ts'), 'export const d = 1;\n');
    git(repository.root, 'add', '.');
    git(repository.root, 'commit', '-m', 'one more file');
    const head = git(repository.root, 'rev-parse', 'HEAD').trim();
    await expect(runGate({ ...options, head })).rejects.toThrow(/failed after retry/);
    expect(reviewer.mock.calls.slice(12).map(([call]) => call.shard.files[0]).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('keeps the completed shards when the scout leaves an unverified process tree', async () => {
    const repository = await makeThreeShardRepository();
    const stateRoot = await temporary('sentinel-rerun-state-');
    const reviewer = vi.fn(async ({ provider, roleIndex }) => ({ provider, roleIndex, summary: 'Reviewed.', candidates: [] }));
    const options = {
      repoRoot: repository.root, stateRoot, base: repository.base, head: repository.head, policy: repository.policy,
      author: 'human', risk: 'high', availableProviders: ['codex'], reviewer, coordinator: vi.fn(),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    };
    await expect(runGate({
      ...options,
      scout: async () => { throw Object.assign(new Error('scout tree left behind'), { code: 'ORPHANED_PROCESS_TREE' }); },
    })).rejects.toMatchObject({ code: 'ORPHANED_PROCESS_TREE' });
    expect(reviewer).toHaveBeenCalledTimes(3);
    const result = await runGate({ ...options, scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }) });
    expect(result.status).toBe('pass');
    expect(reviewer).toHaveBeenCalledTimes(3);
    expect(result.shards.every((entry) => entry.reused === true)).toBe(true);
  });

  it('keeps nothing when the candidate set exceeds its bound, so the rerun is not the same failure', async () => {
    const repository = await makeThreeShardRepository();
    const stateRoot = await temporary('sentinel-rerun-state-');
    let flood = true;
    const reviewer = vi.fn(async ({ provider, roleIndex, shard }) => ({
      provider, roleIndex, summary: 'Reviewed.',
      candidates: flood ? Array.from({ length: 20 }, (_, index) => ({
        id: `${provider}-${roleIndex}-${index}`, title: `Finding ${roleIndex}-${index}`, priority: 'P3', confidence: 90, category: 'c',
        file: shard.files[0], line: index + 1, scenario: 's', evidence: 'e', proposed_test: 't',
      })) : [],
    }));
    const options = {
      repoRoot: repository.root, stateRoot, base: repository.base, head: repository.head, policy: repository.policy,
      author: 'human', risk: 'high', availableProviders: ['codex'], reviewer, coordinator: vi.fn(),
      scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
      deterministicLanes: async () => ({ lanes: [], findings: [] }),
    };
    await expect(runGate(options)).rejects.toThrow(/candidate set exceeded its safe bound/);
    flood = false;
    expect((await runGate(options)).status).toBe('pass');
    expect(reviewer).toHaveBeenCalledTimes(6);
  });

  it('says what to do when the same shard keeps failing', () => {
    expect(shardFailureSummary({ failed: 1 })).toBe([
      '1 shard reviewer(s) failed after retry, leaving their hunks unreviewed; the gate failed closed.',
      'Rerun the gate.',
      'If the same shard fails again, another rerun alone is unlikely to pass.',
      "Read that reviewer's account below: it says which read failed. A timeout or a provider error: check the provider's CLI (rove-sentinel doctor) and try again later. A shard part that keeps coming back truncated is an engine limit: move the shard's largest file, named below, into a change of its own so the rest can pass. A required context read (charter, lessons, briefs) that keeps failing fails every shard the same way, and splitting the change does not help. Report either with this report (docs/troubleshooting.md).",
    ].join(' '));
    expect(shardFailureSummary({ failed: 2, kept: 6, repeated: [{ shard: 3, runs: 3 }, { shard: 5, runs: 2 }] }))
      .toContain('Shard(s) 3, 5 failed in 3 consecutive runs of this head');
  });
});
