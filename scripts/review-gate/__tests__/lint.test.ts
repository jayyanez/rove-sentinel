import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  markdownlintModuleUrl,
  deterministicFinding,
  parseClippyMessages,
  runClippyLane,
  runDeterministicLanes,
  runMarkdownlintLane,
} from '../lint.mjs';
import { addedLinesByFile } from '../shards.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeCheckout(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rove-review-lint-'));
  temporaryDirectories.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

function markdownPatch(file: string, addedLineNumbers: number[]) {
  // One hunk per added line, new-side numbering.
  return addedLineNumbers.map((line) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${line},0 +${line},1 @@`,
    '+added',
  ].join('\n')).join('\n');
}

function clippyMessage({ level, message, code, file, line, help }: {
  level: string; message: string; code?: string; file: string; line: number; help?: string;
}) {
  return JSON.stringify({
    reason: 'compiler-message',
    message: {
      level,
      message,
      code: code ? { code } : null,
      spans: [{ file_name: file, line_start: line, is_primary: true }],
      children: help ? [{ level: 'help', message: help }] : [],
    },
  });
}

describe('deterministic lanes', () => {
  it('reports markdownlint hits only on added lines and honors the repository config', async () => {
    const checkout = await makeCheckout({
      'docs/a.md': '# Title\n\n> quoted\n\n> quoted again\n\nSome text\twith a tab\n',
      '.markdownlint.jsonc': '{\n  // house style: blank lines inside blockquotes\n  "MD028": false /* decided once */\n}\n',
    });
    // Line 3/5 form the MD028 blank-line-in-blockquote case (disabled by
    // config); line 7 carries a hard tab (MD010). Only line 7 is "added".
    const patch = markdownPatch('docs/a.md', [7]);
    const { lint } = await import('markdownlint/promise');
    const inProcess = (input: { strings: Record<string, string>; config?: unknown }) => lint({ strings: input.strings, config: input.config as never });
    const lane = await runMarkdownlintLane({ checkout, files: ['docs/a.md'], patch, lintRunner: inProcess });
    expect(lane.status).toBe('ok');
    expect(lane.findings.map((finding) => [finding.file, finding.line, finding.priority])).toEqual([
      ['docs/a.md', 7, 'P3'],
    ]);
    expect(lane.findings[0].title).toMatch(/^MD010/);
    expect(lane.findings[0].adjudicatedDisposition).toBe('deterministic');
    expect(lane.findings[0].disposition).toBe('verified');

    // The same file with the MD028 rule enabled and line 4 added reports it.
    const enabled = await makeCheckout({ 'docs/a.md': '# Title\n\n> quoted\n\n> quoted again\n' });
    const withRule = await runMarkdownlintLane({ checkout: enabled, files: ['docs/a.md'], patch: markdownPatch('docs/a.md', [4]), lintRunner: inProcess });
    // The default path lints in a child process, bounded by runProcess.
    const viaChild = await runMarkdownlintLane({ checkout: enabled, files: ['docs/a.md'], patch: markdownPatch('docs/a.md', [4]) });
    expect(viaChild.findings.map((finding) => finding.title)).toEqual([expect.stringMatching(/^MD028/)]);
    expect(withRule.findings.map((finding) => finding.title)).toEqual([
      expect.stringMatching(/^MD028/),
    ]);
  });

  it('skips the Markdown lane when no Markdown file changed and degrades when the module is missing', async () => {
    const checkout = await makeCheckout({});
    await expect(runMarkdownlintLane({ checkout, files: ['src/a.ts'], patch: '' })).resolves.toMatchObject({ status: 'skipped', findings: [] });
    await expect(runMarkdownlintLane({
      checkout,
      files: ['docs/a.md'],
      patch: '',
      loadModule: async () => { throw new Error('not installed'); },
    })).resolves.toMatchObject({ status: 'unavailable', findings: [] });
  });

  it('parses clippy JSON: warnings on added lines only, compile errors anywhere', () => {
    const patch = [
      'diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs',
      '--- a/src-tauri/src/lib.rs',
      '+++ b/src-tauri/src/lib.rs',
      '@@ -10,0 +10,1 @@',
      '+added',
    ].join('\n');
    const output = [
      '{"reason":"compiler-artifact","target":{"name":"dep"}}',
      clippyMessage({ level: 'warning', message: 'unneeded `return` statement', code: 'clippy::needless_return', file: 'src/lib.rs', line: 10, help: 'remove `return`' }),
      clippyMessage({ level: 'warning', message: 'too many arguments', code: 'clippy::too_many_arguments', file: 'src/lib.rs', line: 40 }),
      clippyMessage({ level: 'error', message: 'mismatched types', code: 'E0308', file: 'src/core/a.rs', line: 5 }),
      'not json',
    ].join('\n');
    const parsed = parseClippyMessages(output, { addedLines: addedLinesByFile(patch) });
    expect(parsed).toMatchObject({ warnings: 2, errors: 1, truncated: false });
    // Compile errors are listed first so a bound can never drop them.
    expect(parsed.findings.map((finding) => [finding.file, finding.line, finding.priority])).toEqual([
      ['src-tauri/src/core/a.rs', 5, 'P2'],
      ['src-tauri/src/lib.rs', 10, 'P3'],
    ]);
    // An error without a source span (manifest, linker) is still a head that
    // does not compile: reported against the crate manifest.
    const unlocated = parseClippyMessages(JSON.stringify({
      reason: 'compiler-message', message: { level: 'error', message: 'linking failed', code: null, spans: [] },
    }), { addedLines: new Map() });
    expect(unlocated.findings).toEqual([expect.objectContaining({ file: 'src-tauri/Cargo.toml', line: null, priority: 'P2' })]);
    // A compile error behind a wall of warnings survives the bound.
    const flood = [
      ...Array.from({ length: 5 }, (_, index) => clippyMessage({ level: 'warning', message: `w${index}`, code: 'clippy::x', file: 'src/lib.rs', line: 10 })),
      clippyMessage({ level: 'error', message: 'late error', code: 'E0001', file: 'src/lib.rs', line: 10 }),
    ].join('\n');
    const bounded = parseClippyMessages(flood, { addedLines: addedLinesByFile(patch), maxFindings: 3 });
    expect(bounded.findings[0]).toMatchObject({ priority: 'P2', candidate_id: 'clippy-0' });
    expect(bounded.findings).toHaveLength(3);
    expect(bounded.truncated).toBe(true);
    // The bound holds even for an error flood, and truncated stays exact.
    const errorFlood = Array.from({ length: 4 }, (_, index) => clippyMessage({ level: 'error', message: `e${index}`, code: 'E0001', file: 'src/lib.rs', line: index + 1 })).join('\n');
    const errorsBounded = parseClippyMessages(errorFlood, { addedLines: new Map(), maxFindings: 3 });
    expect(errorsBounded.findings).toHaveLength(3);
    expect(errorsBounded.truncated).toBe(true);
    expect(parsed.findings[1].reason).toContain('remove `return`');
    expect(parsed.findings[0].title).toContain('Rust compile error');
  });

  it('runs clippy only for Rust changes, with a dedicated target directory, and degrades on timeout or a missing cargo', async () => {
    const checkout = await makeCheckout({ 'src-tauri/Cargo.toml': '[package]\nname = "x"\n' });
    const stateRoot = await makeCheckout({});
    await expect(runClippyLane({ checkout, files: ['src/a.ts'], patch: '', stateRoot })).resolves.toMatchObject({ status: 'skipped' });

    const run = vi.fn(async () => ({ stdout: clippyMessage({ level: 'warning', message: 'w', code: 'clippy::x', file: 'src/lib.rs', line: 3 }), stderr: '', code: 0 }));
    const patch = 'diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs\n--- a/src-tauri/src/lib.rs\n+++ b/src-tauri/src/lib.rs\n@@ -3,0 +3,1 @@\n+x\n';
    const lane = await runClippyLane({ checkout, files: ['src-tauri/src/lib.rs'], patch, stateRoot, run });
    expect(lane.status).toBe('ok');
    expect(lane.findings).toHaveLength(1);
    expect(run).toHaveBeenCalledWith('cargo', ['clippy', '--no-deps', '--quiet', '--message-format', 'json'], expect.objectContaining({
      cwd: path.join(checkout, 'src-tauri'),
      env: expect.objectContaining({ CARGO_TARGET_DIR: path.join(stateRoot, 'cargo-target') }),
      allowFailure: true,
    }));

    // A non-zero cargo exit without a located compiler error is never "ok".
    await expect(runClippyLane({
      checkout, files: ['src-tauri/src/lib.rs'], patch, stateRoot,
      run: async () => ({ stdout: '', stderr: 'error: failed to parse manifest', code: 101 }),
    })).resolves.toMatchObject({ status: 'error', note: expect.stringContaining('failed to parse manifest'), findings: [] });
    // A non-zero exit WITH a located compile error keeps the ok status and the P2.
    await expect(runClippyLane({
      checkout, files: ['src-tauri/src/lib.rs'], patch, stateRoot,
      run: async () => ({ stdout: clippyMessage({ level: 'error', message: 'mismatched types', code: 'E0308', file: 'src/lib.rs', line: 3 }), stderr: '', code: 101 }),
    })).resolves.toMatchObject({ status: 'ok', findings: [expect.objectContaining({ priority: 'P2' })] });
    const timeout = Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    await expect(runClippyLane({ checkout, files: ['src-tauri/src/lib.rs'], patch, stateRoot, run: async () => { throw timeout; } }))
      .resolves.toMatchObject({ status: 'timeout', findings: [] });
    const missing = Object.assign(new Error('spawn cargo ENOENT'), { code: 'ENOENT' });
    await expect(runClippyLane({ checkout, files: ['src-tauri/src/lib.rs'], patch, stateRoot, run: async () => { throw missing; } }))
      .resolves.toMatchObject({ status: 'unavailable', findings: [] });
    // The §5 process-tree fence is never swallowed by a lane.
    const orphan = Object.assign(new Error('tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    await expect(runClippyLane({ checkout, files: ['src-tauri/src/lib.rs'], patch, stateRoot, run: async () => { throw orphan; } }))
      .rejects.toBe(orphan);
  });

  it('aggregates lane findings with unique deterministic candidate ids', async () => {
    const checkout = await makeCheckout({
      'docs/a.md': '# A\n\ntext\twith tab\n',
      'src-tauri/Cargo.toml': '[package]\nname = "x"\n',
    });
    const stateRoot = await makeCheckout({});
    const patch = [
      markdownPatch('docs/a.md', [3]),
      'diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs\n--- a/src-tauri/src/lib.rs\n+++ b/src-tauri/src/lib.rs\n@@ -3,0 +3,1 @@\n+x',
    ].join('\n');
    const run = async () => ({ stdout: clippyMessage({ level: 'warning', message: 'w', code: 'clippy::x', file: 'src/lib.rs', line: 3 }), stderr: '', code: 0 });
    const result = await runDeterministicLanes({ checkout, files: ['docs/a.md', 'src-tauri/src/lib.rs'], patch, stateRoot, run, config: { clippy: true } });
    // (`run` is the fake for cargo; the Markdown lane's child process is real here.)
    expect(result.lanes.map((lane) => [lane.lane, lane.status])).toEqual([['markdownlint', 'ok'], ['clippy', 'ok']]);
    expect(result.findings.map((finding) => finding.candidate_id)).toEqual(['deterministic-0', 'deterministic-1']);
    // A lane that could not produce diagnostics stays a note, never a finding.
    const errored = await runDeterministicLanes({
      checkout, files: ['src-tauri/src/lib.rs'], patch, stateRoot, config: { clippy: true },
      run: async () => ({ stdout: '', stderr: 'error: failed to parse manifest', code: 101 }),
    });
    expect(errored.findings).toEqual([]);
    expect(errored.lanes.find((lane) => lane.lane === 'clippy')).toMatchObject({ status: 'error' });
    // A hung linter — or a hung module load — degrades to a timeout note.
    const hung = await runMarkdownlintLane({
      checkout: await makeCheckout({ 'docs/a.md': '# A\n' }), files: ['docs/a.md'], patch: '', timeoutMs: 20,
      loadModule: async () => ({ readConfig: async () => ({}) }), lintRunner: () => new Promise(() => {}),
    });
    expect(hung).toMatchObject({ status: 'timeout', findings: [] });
    const hungConfig = await runMarkdownlintLane({
      checkout: await makeCheckout({ 'docs/a.md': '# A\n', '.markdownlint.jsonc': '{}' }), files: ['docs/a.md'], patch: '', timeoutMs: 20,
      loadModule: async () => ({ readConfig: () => new Promise(() => {}) }),
    });
    expect(hungConfig).toMatchObject({ status: 'timeout', findings: [] });
    const hungLoad = await runMarkdownlintLane({
      checkout: await makeCheckout({ 'docs/a.md': '# A\n' }), files: ['docs/a.md'], patch: '', timeoutMs: 20,
      loadModule: () => new Promise(() => {}),
    });
    expect(hungLoad).toMatchObject({ status: 'timeout', findings: [] });
    // The lint child process receives only the time that remains of the
    // lane's single deadline, and its timeout (runProcess terminates the
    // tree) is the lane's timeout.
    const childRun = vi.fn(async (_command: string, _args: string[], options: { timeoutMs: number }) => {
      expect(options.timeoutMs).toBeLessThanOrEqual(500);
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    });
    const childTimeout = await runMarkdownlintLane({
      checkout: await makeCheckout({ 'docs/a.md': '# A\n' }), files: ['docs/a.md'], patch: '', timeoutMs: 500, run: childRun,
    });
    expect(childTimeout).toMatchObject({ status: 'timeout', findings: [] });
    expect(childRun).toHaveBeenCalledTimes(1);
    // The child imports markdownlint by the URL resolved from the gate's own
    // installation and runs in the gate directory, so `--repo` from another
    // directory cannot make it resolve nothing.
    const captured = vi.fn(async (_command: string, _args: string[], _options: { cwd: string }) => ({ stdout: '{}', stderr: '', code: 0 }));
    await runMarkdownlintLane({ checkout: await makeCheckout({ 'docs/a.md': '# A\n' }), files: ['docs/a.md'], patch: '', run: captured });
    const [, childArgs, childOptions] = captured.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(childArgs[2]).toContain(markdownlintModuleUrl());
    expect(markdownlintModuleUrl()).toMatch(/^file:.*markdownlint/);
    expect(path.resolve(childOptions.cwd)).toBe(path.resolve(process.cwd(), 'scripts/review-gate'));
    expect(markdownlintModuleUrl(() => { throw new Error('unresolvable'); })).toBe('markdownlint/promise');
    // A process-tree cleanup failure from the child is never swallowed.
    const orphan = Object.assign(new Error('tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    await expect(runMarkdownlintLane({
      checkout: await makeCheckout({ 'docs/a.md': '# A\n' }), files: ['docs/a.md'], patch: '', run: async () => { throw orphan; },
    })).rejects.toBe(orphan);
    expect(deterministicFinding({ source: 's', index: 0, rule: 'R', title: 't', file: 'a\\b.md', line: 0, detail: '' })).toMatchObject({
      file: 'a/b.md', line: null, priority: 'P3',
    });
  });
});
