import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildReferenceMap, codeFileBlobs, coChangedSiblings, extractChangedSymbols, readChangedSources } from '../refmap.mjs';

const temporaryDirectories: string[] = [];

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('deterministic reference map', () => {
  it('extracts declared identifiers from added and removed lines only', () => {
    const patch = [
      'diff --git a/src/lib/example.ts b/src/lib/example.ts',
      '--- a/src/lib/example.ts',
      '+++ b/src/lib/example.ts',
      ' export function untouchedContext() {}',
      '+export function closeActivePane(tileId: string) {',
      '+  const startedWorkspaceId = ctx.workspace.id;',
      '-fn legacy_probe() {',
      '+func (n *node) startPendingLogin() {',
      '+  if (true) {',
    ].join('\n');
    const { symbols } = extractChangedSymbols(patch);
    expect(symbols).toContain('closeActivePane');
    expect(symbols).toContain('startedWorkspaceId');
    expect(symbols).toContain('legacy_probe');
    expect(symbols).toContain('startPendingLogin');
    expect(symbols).not.toContain('untouchedContext');
    expect(symbols).not.toContain('true');
  });

  it('orders production declarations before test declarations and counts omissions', () => {
    const patch = [
      '--- a/scripts/review-gate/__tests__/gate.test.ts',
      '+++ b/scripts/review-gate/__tests__/gate.test.ts',
      '+const testHelperAlpha = 1;',
      '+const testHelperBeta = 2;',
      '--- a/scripts/review-gate/gate.mjs',
      '+++ b/scripts/review-gate/gate.mjs',
      '+const productionSymbol = 3;',
    ].join('\n');
    const capped = extractChangedSymbols(patch, { maxSymbols: 2 });
    // The production declaration appears later in the patch but survives the
    // cap; one test declaration is reported as omitted, never silently lost.
    expect(capped.symbols[0]).toBe('productionSymbol');
    expect(capped.symbols).toHaveLength(2);
    expect(capped.omitted).toBe(1);
  });

  it('caps the symbol list and skips stopwords', () => {
    const header = ['--- a/src/lib/many.ts', '+++ b/src/lib/many.ts'];
    const lines = Array.from({ length: 60 }, (_, index) => `+const changedSymbol${String(index).padStart(2, '0')} = 1;`);
    const { symbols, omitted } = extractChangedSymbols([...header, ...lines, '+const value = 2;'].join('\n'), { maxSymbols: 10 });
    expect(symbols).toHaveLength(10);
    expect(symbols).not.toContain('value');
    expect(omitted).toBe(50);
  });

  it('extracts TypeScript methods with return-type annotations', () => {
    const patch = [
      '--- a/src/lib/store.ts',
      '+++ b/src/lib/store.ts',
      '+  async replaceWorkspace(next: Workspace): Promise<void> {',
      '+  hydrateSettings(input: unknown): asserts input is Settings {',
    ].join('\n');
    const { symbols } = extractChangedSymbols(patch);
    expect(symbols).toContain('replaceWorkspace');
    expect(symbols).toContain('hydrateSettings');
  });

  it('extracts interfaces and type aliases — their consumers break on renames too', () => {
    const patch = [
      '--- a/src/lib/types.ts',
      '+++ b/src/lib/types.ts',
      '+export interface WorkspaceLayout {',
      '+export type PaneTile = {',
      '-type LegacyAlias = string;',
    ].join('\n');
    const { symbols } = extractChangedSymbols(patch);
    expect(symbols).toContain('WorkspaceLayout');
    expect(symbols).toContain('PaneTile');
    expect(symbols).toContain('LegacyAlias');
  });

  it('extracts short keyword-prefixed names like the real Job interface', () => {
    const patch = [
      '--- a/src/lib/files/jobs.ts',
      '+++ b/src/lib/files/jobs.ts',
      '+export interface Job {',
      '+fn run() {',
      '+export function go() {}',
    ].join('\n');
    const { symbols } = extractChangedSymbols(patch);
    expect(symbols).toContain('Job');
    expect(symbols).toContain('run');
    // Two-character names stay outside the documented sweep bound.
    expect(symbols).not.toContain('go');
  });

  it('promotes a symbol to the production bucket when both a test and a production file declare it', () => {
    const patch = [
      '--- a/scripts/review-gate/__tests__/gate.test.ts',
      '+++ b/scripts/review-gate/__tests__/gate.test.ts',
      '+const sharedName = 1;',
      '+const testOnlyName = 2;',
      '--- a/scripts/review-gate/gate.mjs',
      '+++ b/scripts/review-gate/gate.mjs',
      '+const sharedName = 3;',
    ].join('\n');
    const { symbols } = extractChangedSymbols(patch, { maxSymbols: 2 });
    // sharedName is re-declared in production, so it survives a cap that
    // drops the test-only bucket — and it appears exactly once.
    expect(symbols).toEqual(['sharedName', 'testOnlyName']);
  });

  it('reports a failed reference sweep as missing evidence, never as absent references', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-nogit-'));
    temporaryDirectories.push(root);
    // Not a git repository: every sweep fails; the map must say so.
    const map = await buildReferenceMap({
      checkout: root,
      headSha: 'a'.repeat(40),
      patch: ['--- a/src/x.ts', '+++ b/src/x.ts', '+const sweptSymbol = 1;'].join('\n'),
      files: ['src/x.ts'],
    });
    expect(map).toContain('TRUNCATED');
    expect(map).toContain('`sweptSymbol`');
    expect(map).toContain('missing evidence, not absent references');
  });

  it('never extracts symbols from prose files', () => {
    const patch = [
      '--- a/docs/example.md',
      '+++ b/docs/example.md',
      '+const proseConstant = documented here;',
      '+someMethodLooking(text) {',
      '--- a/src/real.ts',
      '+++ b/src/real.ts',
      '+const realConstant = 1;',
    ].join('\n');
    expect(extractChangedSymbols(patch).symbols).toEqual(['realConstant']);
  });

  it('maps repository-wide references and untouched co-change siblings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-test-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'changed.ts'), 'export function sharedHelper() {}\n');
    await writeFile(path.join(root, 'src', 'caller.ts'), 'import { sharedHelper } from "./changed";\nsharedHelper();\n');
    await writeFile(path.join(root, 'src', 'lookalike.ts'), 'export const sharedHelperExtra = 1;\n');
    await writeFile(path.join(root, 'src', 'sibling.ts'), 'export const twin = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    // Two commits that always touch changed.ts and sibling.ts together.
    for (const round of ['a', 'b']) {
      await writeFile(path.join(root, 'src', 'changed.ts'), `export function sharedHelper() { return '${round}'; }\n`);
      await writeFile(path.join(root, 'src', 'sibling.ts'), `export const twin = '${round}';\n`);
      git(root, 'add', '.');
      git(root, 'commit', '-m', `co-change ${round}`);
    }
    const headSha = git(root, 'rev-parse', 'HEAD');

    const map = await buildReferenceMap({
      checkout: root,
      headSha,
      patch: [
        '--- a/src/changed.ts',
        '+++ b/src/changed.ts',
        '+export function sharedHelper() { return "c"; }',
      ].join('\n'),
      files: ['src/changed.ts'],
    });
    expect(map).toContain('`sharedHelper`');
    expect(map).toContain('src/caller.ts');
    expect(map).toContain('outside the diff');
    // Word-boundary matching: an identifier that merely CONTAINS the symbol
    // is not a reference to it.
    expect(map).not.toContain('lookalike.ts');
    // The base commit also touches both files, so three commits co-change
    // changed.ts with sibling.ts; caller.ts co-appears only once and stays
    // below the threshold.
    expect(map).toContain('src/sibling.ts (co-changed 3×)');

    const { siblings, sweepFailures } = await coChangedSiblings(root, headSha, ['src/changed.ts']);
    expect(siblings).toEqual([{ sibling: 'src/sibling.ts', count: 3 }]);
    expect(sweepFailures).toBe(0);
  });

  it('counts one shared commit once even when two changed files rode in it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-dedupe-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await mkdir(path.join(root, 'src'), { recursive: true });
    for (const name of ['a.ts', 'b.ts', 's.ts']) {
      await writeFile(path.join(root, 'src', name), 'export const v = 0;\n');
    }
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    for (const round of ['1', '2']) {
      for (const name of ['a.ts', 'b.ts', 's.ts']) {
        await writeFile(path.join(root, 'src', name), `export const v = ${round};\n`);
      }
      git(root, 'add', '.');
      git(root, 'commit', '-m', `co-change ${round}`);
    }
    const headSha = git(root, 'rev-parse', 'HEAD');
    const { siblings } = await coChangedSiblings(root, headSha, ['src/a.ts', 'src/b.ts']);
    // Three commits touch a, b, and s together; sibling s counts each commit
    // ONCE (3), not once per changed file (6).
    expect(siblings).toEqual([{ sibling: 'src/s.ts', count: 3 }]);
  });

  it('carries co-change history across a rename', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-rename-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'old-name.ts'), 'export const value = 0;\n');
    await writeFile(path.join(root, 'src', 'twin.ts'), 'export const twin = 0;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    // Two pre-rename co-changes, then a pure rename, then nothing.
    for (const round of ['1', '2']) {
      await writeFile(path.join(root, 'src', 'old-name.ts'), `export const value = ${round};\n`);
      await writeFile(path.join(root, 'src', 'twin.ts'), `export const twin = ${round};\n`);
      git(root, 'add', '.');
      git(root, 'commit', '-m', `co-change ${round}`);
    }
    git(root, 'mv', 'src/old-name.ts', 'src/new-name.ts');
    git(root, 'commit', '-m', 'rename');
    const headSha = git(root, 'rev-parse', 'HEAD');
    const { siblings } = await coChangedSiblings(root, headSha, ['src/new-name.ts']);
    expect(siblings.find(({ sibling }) => sibling === 'src/twin.ts')?.count).toBeGreaterThanOrEqual(2);
  });

  it('marks a failed co-change sweep as missing evidence in the map', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-cochange-fail-'));
    temporaryDirectories.push(root);
    // Not a git repository: the sweep fails and the map must say so instead
    // of rendering "(none above threshold)" as if history proved absence.
    const map = await buildReferenceMap({
      checkout: root,
      headSha: 'a'.repeat(40),
      patch: '',
      files: ['src/x.ts'],
    });
    expect(map).toContain('co-change sweep FAILED for 1 changed file(s)');
  });

  it('degrades to an explicit placeholder when nothing is detected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-empty-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    await writeFile(path.join(root, 'note.md'), '# Note\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    const headSha = git(root, 'rev-parse', 'HEAD');
    const map = await buildReferenceMap({
      checkout: root,
      headSha,
      patch: ['--- a/note.md', '+++ b/note.md', '+plain prose'].join('\n'),
      files: ['note.md'],
    });
    expect(map).toContain('(no changed symbols detected)');
    expect(map).toContain('(none above threshold)');
  });
});

describe('reference map: comment and string prose is never a declaration (#474)', () => {
  const sorted = (values: string[]) => [...values].sort();
  const patchOf = (file: string, ...lines: string[]) => [`--- a/${file}`, `+++ b/${file}`, '@@ -1,4 +1,4 @@', ...lines].join('\n');

  it('ignores the removed comment that killed the input-drafts gate (`Re-type the …`)', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src/lib/terminal/terminalRestore.ts',
      '-  // Re-type the relaunch-restore draft once the shell has produced output',
      '+  // Restore the relaunch draft once the shell has produced output',
    ));
    expect(symbols).not.toContain('the');
    expect(sorted(symbols)).toEqual(sorted([]));
  });

  it('ignores a doc-comment line whose opener lies outside the hunk (`class and`, PR #519)', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src-tauri/src/api/webview_link_menu.rs',
      '+ * lives in wry\'s vendored WKWebView class and is owned by the macOS plan.',
      '+/// Every link menu row type the user sees is added here.',
    ));
    expect(symbols).not.toContain('and');
    expect(symbols).not.toContain('the');
    expect(sorted(symbols)).toEqual(sorted([]));
  });

  it('follows a block comment across lines, and code resumes after it closes', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src/lib/example.ts',
      '+/*',
      '+ interface or type the caller passes',
      '+ class and struct names are prose here */ export function realAfterComment() {',
      '+export type RealAlias = string; /* type Hidden */ // class Ghost',
    ));
    expect(sorted(symbols)).toEqual(sorted(['realAfterComment', 'RealAlias']));
  });

  it('drops string contents and multi-line template prose (the gate\'s own prompts)', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'scripts/review-gate/providers.mjs',
      "+const label = 'type the name of the class you want';",
      '+const prompt = `Review the diff. If a type changed,',
      '+list every class that consumes it, then the function using it.`;',
      '+function promptAfterTemplate() {',
    ));
    expect(sorted(symbols)).toEqual(sorted(['label', 'prompt', 'promptAfterTemplate']));
  });

  it('keeps removed and added sides apart: a comment opened on one side does not hide the other', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src/lib/example.ts',
      '-/* removed block comment starts here',
      '+export function addedWhileOldSideInComment() {',
      '-   class stillOldComment */',
    ));
    expect(sorted(symbols)).toEqual(sorted(['addedWhileOldSideInComment']));
  });

  it('resets comment state at each hunk header', () => {
    const { symbols } = extractChangedSymbols([
      '--- a/src/lib/example.ts',
      '+++ b/src/lib/example.ts',
      '@@ -1,1 +1,1 @@',
      '+/* an unterminated comment in the first hunk',
      '@@ -40,1 +40,1 @@',
      '+export function inSecondHunk() {',
    ].join('\n'));
    expect(sorted(symbols)).toEqual(sorted(['inSecondHunk']));
  });

  it('reads Rust lifetimes and char literals without swallowing the declaration after them', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src-tauri/src/core/example.rs',
      "+impl<'a> Reader<'a> { fn read_until(&'a self, stop: char) -> bool { stop == '\\'' } }",
      "+struct Holder<'a> { inner: &'a str }",
      "+fn quote_char() -> char { '\"' } // fn commented_out()",
    ));
    expect(sorted(symbols)).toEqual(sorted(['read_until', 'quote_char', 'Holder']));
  });

  it('does not read an escaped slash in a regex literal as a line comment', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src/lib/url.ts',
      '+const SCHEME = /^https?:\\/\\//; function afterRegex() {}',
    ));
    expect(sorted(symbols)).toEqual(sorted(['SCHEME', 'afterRegex']));
  });

  it('ignores Svelte HTML comments and English words in markup', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src/lib/components/Example.svelte',
      '+<!-- type the value, class and all -->',
      '+<p>Type the name of the class and press Enter.</p>',
      '+  function onSubmitName() {',
    ));
    expect(sorted(symbols)).toEqual(sorted(['onSubmitName']));
  });

  it('still extracts real declarations right next to comments', () => {
    const { symbols } = extractChangedSymbols(patchOf(
      'src/lib/example.ts',
      '+type Job = { id: string }; // type the job',
      '-interface LegacyShape { a: number } /* removed */',
      '+  /** Doc for the method. */ async resizeCorner(edge: string): Promise<void> {',
    ));
    expect(sorted(symbols)).toEqual(sorted(['Job', 'LegacyShape', 'resizeCorner']));
  });
});

describe('reference map: a failed sweep never fences the reviewers (PR #519)', () => {
  it('sweeps without latching the provider launch fence and says why evidence is missing', async () => {
    const { providerCleanupFailureLatched, resetProviderCleanupLatch } = await import('../process.mjs');
    resetProviderCleanupLatch();
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const run = async (_checkout: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ args, options });
      if (args[0] === 'grep') {
        throw Object.assign(new Error('git exceeded its 4259840-byte output limit. Process-tree cleanup also failed: taskkill timed out'), { code: 'OUTPUT_LIMIT' });
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const map = await buildReferenceMap({
      checkout: os.tmpdir(),
      headSha: 'a'.repeat(40),
      patch: ['--- a/src/x.ts', '+++ b/src/x.ts', '+const sweptSymbol = 1;'].join('\n'),
      files: [],
      run,
    });
    const grep = calls.find((call) => call.args[0] === 'grep');
    expect(grep?.options).toMatchObject({ latchCleanupFailure: false });
    expect(map).toContain('`sweptSymbol` (git exceeded its 4259840-byte output limit.');
    expect(providerCleanupFailureLatched()).toBe(false);
  });
});

describe('reference map: whole-file lexing knows where a hunk starts (#474 review)', () => {
  const sorted = (values: string[]) => [...values].sort();
  const fileDiff = (file: string, oldBlob: string, newBlob: string, hunk: string, ...lines: string[]) => [
    `diff --git a/${file} b/${file}`,
    `index ${oldBlob}..${newBlob} 100644`,
    `--- a/${file}`,
    `+++ b/${file}`,
    hunk,
    ...lines,
  ].join('\n');

  it('reads a hunk that starts inside a block comment whose opener is outside it', () => {
    const oldText = ['/*', 'Long design note.', ' interface Customers is prose here', ' */', 'export const kept = 1;'].join('\n');
    const newText = ['/*', 'Long design note.', ' interface Customers is prose here', ' type Accounts is prose too', ' */', 'export const kept = 1;'].join('\n');
    const patch = fileDiff('src/lib/note.ts', '1111111', '2222222', '@@ -3,2 +3,3 @@',
      '  interface Customers is prose here',
      '+ type Accounts is prose too',
      '  */');
    const sources = new Map([['1111111', oldText], ['2222222', newText]]);
    expect(extractChangedSymbols(patch, { sources }).symbols).toEqual([]);
    // The hunk-only fallback cannot know; this is what whole-file lexing fixes.
    expect(extractChangedSymbols(patch).symbols).toEqual(['Accounts']);
  });

  it('reads a hunk that starts inside a multi-line template literal', () => {
    const newText = ['const prompt = `Review the diff.', 'Each line is prose,', 'list the class Settings you find', 'and stop.`;', 'function afterPrompt() {}'].join('\n');
    const oldText = ['const prompt = `Review the diff.', 'Each line is prose,', 'and stop.`;', 'function afterPrompt() {}'].join('\n');
    const patch = fileDiff('scripts/review-gate/prompt.mjs', '3333333', '4444444', '@@ -2,2 +2,3 @@',
      ' Each line is prose,',
      '+list the class Settings you find',
      ' and stop.`;');
    const sources = new Map([['3333333', oldText], ['4444444', newText]]);
    expect(extractChangedSymbols(patch, { sources }).symbols).toEqual([]);
  });

  it('reads Svelte markup as prose and only its script and `{…}` expressions as code', () => {
    const newText = [
      '<script lang="ts">',
      '  let count = $state(0);',
      '  function onSaveSettings() {}',
      '</script>',
      '',
      '<p>Choose the class Settings panel, then type the Account name.</p>',
      '{#if count}{@const doubled = count * 2}{doubled}{/if}',
      '<style>',
      '  .class-Styles { color: red; }',
      '</style>',
    ].join('\n');
    const oldText = ['<script lang="ts">', '  let count = $state(0);', '</script>', ''].join('\n');
    const patch = fileDiff('src/lib/components/Panel.svelte', '5555555', '6666666', '@@ -1,4 +1,10 @@',
      ' <script lang="ts">',
      '   let count = $state(0);',
      '+  function onSaveSettings() {}',
      ' </script>',
      ' ',
      '+<p>Choose the class Settings panel, then type the Account name.</p>',
      '+{#if count}{@const doubled = count * 2}{doubled}{/if}',
      '+<style>',
      '+  .class-Styles { color: red; }',
      '+</style>');
    const sources = new Map([['5555555', oldText], ['6666666', newText]]);
    expect(sorted(extractChangedSymbols(patch, { sources }).symbols)).toEqual(sorted(['onSaveSettings', 'doubled']));
  });

  it('reads a removed line that starts with `-- ` as content, not as a file header', () => {
    const patch = [
      'diff --git a/src/lib/sql.ts b/src/lib/sql.ts',
      'index 7777777..8888888 100644',
      '--- a/src/lib/sql.ts',
      '+++ b/src/lib/sql.ts',
      '@@ -1,2 +1,2 @@',
      '--- counts the rows',
      '+export function stillSameFile() {}',
      ' const tail = 1;',
    ].join('\n');
    expect(extractChangedSymbols(patch).symbols).toEqual(['stillSameFile']);
  });

  it('lists the blobs of changed code files, including a deleted file, and nothing else', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index aaaaaaa..bbbbbbb 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index ccccccc..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      'diff --git a/docs/x.md b/docs/x.md',
      'index ddddddd..eeeeeee 100644',
      '--- a/docs/x.md',
      '+++ b/docs/x.md',
    ].join('\n');
    expect(codeFileBlobs(patch)).toEqual(['aaaaaaa', 'bbbbbbb', 'ccccccc']);
  });

  it('marks a symbol read without its file context as unverified and ranks it after verified ones', () => {
    const verifiedFile = fileDiff('src/lib/read.ts', 'aaaaaaa', 'bbbbbbb', '@@ -1,1 +1,2 @@',
      ' export const kept = 1;',
      '+export function readForReal() {}');
    const unreadFile = fileDiff('src/lib/huge.ts', 'ccccccc', 'ddddddd', '@@ -3,2 +3,3 @@',
      '  interface Customers is prose here',
      '+ type Accounts is prose too',
      '  */');
    const sources = new Map([
      ['aaaaaaa', 'export const kept = 1;'],
      ['bbbbbbb', 'export const kept = 1;\nexport function readForReal() {}'],
    ]);
    const unreadFirst = extractChangedSymbols([unreadFile, verifiedFile].join('\n'), { sources, maxSymbols: 1 });
    // The verified declaration keeps the only slot, although it came second.
    expect(unreadFirst.symbols).toEqual(['readForReal']);
    expect(unreadFirst.omitted).toBe(1);
    const both = extractChangedSymbols([unreadFile, verifiedFile].join('\n'), { sources });
    expect(both.symbols).toEqual(['readForReal', 'Accounts']);
    expect(both.unverified).toEqual(['Accounts']);
  });

  it('labels an unverified symbol in the generated map', async () => {
    const patch = fileDiff('src/lib/huge.ts', 'ccccccc', 'ddddddd', '@@ -3,1 +3,2 @@',
      '  interface Customers is prose here',
      '+ type Accounts is prose too');
    const run = async (_checkout: string, args: string[]) => (args[0] === 'cat-file'
      ? { code: 1, stdout: '', stderr: 'too large' }
      : { code: 1, stdout: '', stderr: '' });
    const map = await buildReferenceMap({ checkout: os.tmpdir(), headSha: 'a'.repeat(40), patch, files: [], run });
    expect(map).toContain('### `Accounts`');
    expect(map).toContain('UNVERIFIED symbol');
  });

  it('carries Rust cooked and raw strings across lines', () => {
    const text = [
      'const HELP: &str = "choose the class',
      'Settings then the struct Widget to use";',
      'const RAW_TEXT: &str = r#"a raw string',
      'fn not_a_function() and class Hidden',
      '"#;',
      'const RAW_C: &CStr = cr#"a raw C string with one " quote',
      'fn prose_only() in a C string',
      '"#;',
      'const BYTES: &[u8] = br#"bytes with one " quote',
      'fn prose_in_bytes()"#;',
      'fn after_strings() {}',
    ].join('\n');
    const patch = [
      'diff --git a/src-tauri/src/help.rs b/src-tauri/src/help.rs',
      'new file mode 100644',
      'index 0000000..abcdef1',
      '--- /dev/null',
      '+++ b/src-tauri/src/help.rs',
      '@@ -0,0 +1,11 @@',
      ...text.split('\n').map((line) => `+${line}`),
    ].join('\n');
    const sources = new Map([['abcdef1', text]]);
    expect(sorted(extractChangedSymbols(patch, { sources }).symbols)).toEqual(sorted(['HELP', 'RAW_TEXT', 'RAW_C', 'BYTES', 'after_strings']));
  });

  it('holds the aggregate source bound in bytes: each read gets only what is left', async () => {
    const patch = ['a', 'b', 'c'].map((name, index) => [
      `diff --git a/src/${name}.ts b/src/${name}.ts`,
      `index ${String(index + 1).repeat(7)}..${String(index + 4).repeat(7)} 100644`,
      `--- a/src/${name}.ts`,
      `+++ b/src/${name}.ts`,
    ].join('\n')).join('\n');
    const allowances: number[] = [];
    const run = async (_checkout: string, _args: string[], options: { maxOutputBytes: number }) => {
      allowances.push(options.maxOutputBytes);
      // Multibyte text: 4 characters, 10 UTF-8 bytes.
      return { code: 0, stdout: 'éé€€', stderr: '' };
    };
    const sources = await readChangedSources(os.tmpdir(), patch, run, { maxBlobBytes: 8, maxTotalBytes: 25 });
    // Bytes, not characters: 10 + 10 leaves 5 for the third read, and the
    // fourth is never started.
    expect(allowances).toEqual([8, 8, 5]);
    expect(sources.size).toBe(3);
  });

  it('builds the map from a real repository: prose deep inside a comment is not a symbol', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-wholefile-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'core.autocrlf', 'false');
    await mkdir(path.join(root, 'src'), { recursive: true });
    const prose = Array.from({ length: 12 }, (_, index) => ` line ${index} of a long design note`);
    const before = ['/*', ...prose, ' */', 'export function untouched() {}', ''].join('\n');
    await writeFile(path.join(root, 'src', 'note.ts'), before);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    const baseSha = git(root, 'rev-parse', 'HEAD');
    const after = before
      .replace(' line 6 of a long design note', ' line 6 names the class Customers in prose')
      .replace('export function untouched() {}', 'export function untouched() {}\nexport function addedForReal() {}');
    await writeFile(path.join(root, 'src', 'note.ts'), after);
    git(root, 'commit', '-am', 'change');
    const headSha = git(root, 'rev-parse', 'HEAD');
    const patch = git(root, 'diff', `${baseSha}...${headSha}`);
    const map = await buildReferenceMap({ checkout: root, headSha, patch, files: ['src/note.ts'] });
    expect(map).toContain('`addedForReal`');
    expect(map).not.toContain('`Customers`');
  });
});
