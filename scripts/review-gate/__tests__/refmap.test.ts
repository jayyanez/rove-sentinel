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
    // Every blob is reported as 10 bytes: multibyte text of 4 characters.
    const calls: Array<{ args: string[]; input: string; binary?: boolean }> = [];
    const run = async (_checkout: string, args: string[], options: { input: string; binary?: boolean }) => {
      calls.push({ args, input: options.input, binary: options.binary });
      const oids = options.input.trim().split('\n');
      if (args[1] === '--batch-check') {
        return { code: 0, stdout: oids.map((oid) => `${oid}abc blob 10`).join('\n'), stderr: '' };
      }
      return {
        code: 0,
        stdout: Buffer.concat(oids.map((oid) => Buffer.from(`${oid} blob 10\néé€€\n`))),
        stderr: '',
      };
    };
    const sources = await readChangedSources(os.tmpdir(), patch, run, { maxBlobBytes: 12, maxTotalBytes: 25 });
    // Two processes however many blobs (1.13.0), sizes first.
    expect(calls.map((call) => call.args[1])).toEqual(['--batch-check', '--batch']);
    expect(calls[1].binary).toBe(true);
    // Bytes, not characters: 10 + 10 leaves 5, so the third and every later
    // blob is not read; only the selected blobs' contents are requested.
    expect(calls[1].input.trim().split('\n')).toHaveLength(2);
    expect([...sources.keys()]).toEqual(['1111111', '4444444']);
    expect(sources.get('1111111')).toBe('éé€€');
  });

  it('skips a blob over its own bound and still reads the later ones that fit', async () => {
    const patch = ['a', 'b'].map((name, index) => [
      `diff --git a/src/${name}.ts b/src/${name}.ts`,
      `index ${String(index + 1).repeat(7)}..0000000 100644`,
      `--- a/src/${name}.ts`,
      `+++ b/src/${name}.ts`,
    ].join('\n')).join('\n');
    const sizes = new Map([['1111111', 9], ['2222222', 3]]);
    const run = async (_checkout: string, args: string[], options: { input: string }) => {
      const oids = options.input.trim().split('\n');
      if (args[1] === '--batch-check') return { code: 0, stdout: oids.map((oid) => `${oid} blob ${sizes.get(oid)}`).join('\n'), stderr: '' };
      return { code: 0, stdout: Buffer.concat(oids.map((oid) => Buffer.from(`${oid} blob 3\nabc\n`))), stderr: '' };
    };
    const sources = await readChangedSources(os.tmpdir(), patch, run, { maxBlobBytes: 8, maxTotalBytes: 25 });
    expect([...sources.entries()]).toEqual([['2222222', 'abc']]);
  });

  it('reads every changed blob of a real repository in one batch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rove-refmap-batch-'));
    temporaryDirectories.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'core.autocrlf', 'false');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = "é";\n');
    await writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    const baseSha = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = "é€";\nexport function added() {}\n');
    await writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
    git(root, 'commit', '-am', 'change');
    const headSha = git(root, 'rev-parse', 'HEAD');
    const patch = git(root, 'diff', `${baseSha}...${headSha}`);
    const sources = await readChangedSources(root, patch);
    expect(sources.size).toBe(4);
    expect([...sources.values()]).toContain('export const a = "é€";\nexport function added() {}\n');
    expect([...sources.values()]).toContain('export const b = 1;\n');
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

describe('reference map: parallel sweeps render as if run in order (1.13.0)', () => {
  it('applies the reference-line budget in symbol order whichever sweep finishes first', async () => {
    const names = Array.from({ length: 30 }, (_, index) => `sweptName${String(index).padStart(2, '0')}`);
    const patch = ['--- a/src/x.ts', '+++ b/src/x.ts', ...names.map((name) => `+export function ${name}() {}`)].join('\n');
    let inFlight = 0;
    let peak = 0;
    const run = async (_checkout: string, args: string[]) => {
      if (args[0] !== 'grep') return { code: 1, stdout: '', stderr: '' };
      const symbol = args[args.indexOf('-e') + 1];
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Later symbols finish first.
      await new Promise((resolve) => setTimeout(resolve, 2 * (30 - names.indexOf(symbol))));
      inFlight -= 1;
      const lines = Array.from({ length: 12 }, (_, index) => `${'a'.repeat(40)}:src/use-${index}.ts:${index + 1}:${symbol}()`);
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    };
    const map = await buildReferenceMap({ checkout: os.tmpdir(), headSha: 'a'.repeat(40), patch, files: ['src/x.ts'], run });
    // 240 reference lines at 12 a symbol: the first 20 are listed, in order.
    const listed = [...map.matchAll(/^### `(sweptName\d+)` — 12 reference\(s\), 12 outside the diff$/gm)].map((match) => match[1]);
    expect(listed).toEqual(names.slice(0, 20));
    expect(map).toContain(`truncated the sweep before these extracted symbols: ${names.slice(20).map((name) => `\`${name}\``).join(', ')}`);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

describe('reference map: declarations beyond JavaScript, Rust and Go (1.13.0)', () => {
  const sorted = (values: string[]) => [...values].sort();
  const added = (file: string, ...lines: string[]) => [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..abcdef1',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');

  it('reads Python definitions and ignores hash comments and docstrings', () => {
    const lines = [
      'class InvoiceStore:',
      '    """Docstring that mentions class Ghost and def phantom(x)."""',
      '    def load_invoice(self, invoice_id):',
      "        # def commented_out(): and class Hidden",
      "        return f'def notreal({invoice_id})'",
      '    async def refresh_cache(self):',
      "        text = '''",
      '        class InsideTripleQuotes',
      "        '''",
      '        pass',
      'def __init__(self): pass',
    ];
    const patch = added('app/invoices.py', ...lines);
    const sources = new Map([['abcdef1', lines.join('\n')]]);
    expect(sorted(extractChangedSymbols(patch, { sources }).symbols)).toEqual(sorted(['InvoiceStore', 'load_invoice', 'refresh_cache']));
  });

  it('reads Java, C# and Kotlin methods and types', () => {
    const java = added('src/main/java/Billing.java',
      'public final class BillingService {',
      '  // public void commentedOut() {}',
      '  private static Map<String, List<Integer>> totalsByAccount(String id) {',
      '    char quote = \'"\';',
      '    return null;',
      '  }',
      '  public record LineItem(String sku) {}',
      '}');
    expect(sorted(extractChangedSymbols(java).symbols)).toEqual(sorted(['BillingService', 'totalsByAccount', 'LineItem']));
    const csharp = added('src/Billing.cs',
      'public sealed class Ledger {',
      '  public async Task<int> PostEntryAsync(Entry entry) { return 0; }',
      '  internal override string Summarize() => "class Fake";',
      '}');
    expect(sorted(extractChangedSymbols(csharp).symbols)).toEqual(sorted(['Ledger', 'PostEntryAsync', 'Summarize']));
    const kotlin = added('app/src/Session.kt',
      'class SessionManager {',
      '  fun startSession(user: User): Session = TODO()',
      '  suspend fun <T> withRetry(block: () -> T): T = block()',
      '  val doc = """ fun notReal() """',
      '}');
    expect(sorted(extractChangedSymbols(kotlin).symbols)).toEqual(sorted(['SessionManager', 'startSession', 'withRetry']));
  });

  it('lists the blobs of the newly supported languages for whole-file lexing', () => {
    const patch = ['app/a.py', 'src/B.java', 'src/C.cs', 'src/d.kt', 'src/e.rb', 'src/f.php', 'src/g.swift', 'src/h.cpp'].map((file, index) => [
      `diff --git a/${file} b/${file}`,
      `index ${String(index + 1).repeat(7)}..${String(index + 1).repeat(6)}a 100644`,
      `--- a/${file}`,
      `+++ b/${file}`,
    ].join('\n')).join('\n');
    expect(codeFileBlobs(patch)).toHaveLength(16);
  });
});

describe('reference map: C-family signatures and escaped triple quotes (1.13.0 self-review)', () => {
  const sorted = (values: string[]) => [...values].sort();
  const changed = (file: string, ...lines: string[]) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${lines.filter((line) => !line.startsWith('+')).length} +1,${lines.filter((line) => !line.startsWith('-')).length} @@`,
    ...lines,
  ].join('\n');

  it('extracts return-typed C and C++ functions, prototypes and removed definitions', () => {
    const c = changed('src/money.c',
      '-int calculate_total(int count)',
      '+long calculate_total(long count, int scale) {',
      '+static double apply_discount(double value);',
      '+struct invoice *load_invoice(const char *path,',
      '+  int flags)',
      '+  return compute_tax(value);',
      '+  int result = round_cents(total);',
      '+  else update_ledger(entry);',
      '+  if (ready) notify_owner(entry);');
    expect(sorted(extractChangedSymbols(c).symbols)).toEqual(sorted(['calculate_total', 'apply_discount', 'load_invoice']));
    const cpp = changed('src/ledger.cpp',
      '+Money Ledger::post(const Entry& entry) const {',
      '+std::vector<Line> Ledger::linesFor(Account account) noexcept;',
      '+  delete release_buffer(buffer);');
    expect(sorted(extractChangedSymbols(cpp).symbols)).toEqual(sorted(['post', 'linesFor']));
    // The same shape in JavaScript is a call.
    expect(extractChangedSymbols(changed('src/a.ts', '+  await loadInvoice(path);', '+  yield fetchRows(query);')).symbols).toEqual([]);
  });

  it('does not end a Python docstring at an escaped quote', () => {
    const lines = [
      'def documented():',
      '    """Mentions \\""" then class Phantom inside the docstring."""',
      '    return 1',
      'def load_invoice(invoice_id):',
      '    pass',
    ];
    const patch = [
      'diff --git a/app/a.py b/app/a.py',
      'new file mode 100644',
      'index 0000000..abcdef2',
      '--- /dev/null',
      '+++ b/app/a.py',
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n');
    const sources = new Map([['abcdef2', lines.join('\n')]]);
    expect(sorted(extractChangedSymbols(patch, { sources }).symbols)).toEqual(sorted(['documented', 'load_invoice']));
  });

  it('keeps a long line of words linear for the C-family pattern', () => {
    const long = `+${Array.from({ length: 3000 }, (_, index) => `word${index}`).join(' ')}`;
    const started = Date.now();
    extractChangedSymbols(changed('src/long.c', long));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('reference map: C signatures with default arguments or a return type of their own line (1.13.0 follow-up)', () => {
  const sorted = (values: string[]) => [...values].sort();
  const changed = (file: string, ...lines: string[]) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${lines.filter((line) => !line.startsWith('+')).length} +1,${lines.filter((line) => !line.startsWith('-')).length} @@`,
    ...lines,
  ].join('\n');

  it('extracts a definition whose parameters have default values', () => {
    const cpp = changed('src/ledger.cpp',
      '-int round_cents(double value, int places = 2) {',
      '+long round_cents(double value, int places = 2, bool bankers = false) {',
      '+  int total = sum_lines(lines);');
    expect(extractChangedSymbols(cpp).symbols).toEqual(['round_cents']);
  });

  it('extracts GNU-style definitions whose return type has a line of its own', () => {
    const c = changed('src/money.c',
      '+static int',
      '+calculate_total (int count)',
      '+{',
      '+  return count;',
      '+}',
      '-struct invoice *',
      '-load_invoice (const char *path,',
      '-              int flags)',
      '+MODULE_LICENSE("GPL");',
      '+  indented_call (value);');
    expect(sorted(extractChangedSymbols(c).symbols)).toEqual(sorted(['calculate_total', 'load_invoice']));
    // Java keeps one-line signatures only.
    expect(extractChangedSymbols(changed('src/A.java', '+compute (value)')).symbols).toEqual([]);
  });

  it('says in the generated map that declarations come from line patterns', async () => {
    const run = async () => ({ code: 1, stdout: '', stderr: '' });
    const map = await buildReferenceMap({ checkout: os.tmpdir(), headSha: 'a'.repeat(40), patch: '', files: [], run });
    expect(map).toContain('declarations are found by line patterns, not a parser');
  });
});

describe('reference map: a split signature needs a return type on the line before (1.13.0 follow-up)', () => {
  it('does not read a multi-line top-level macro invocation as a definition', () => {
    const lines = [
      '#include "money.h"',
      '',
      'MODULE_LICENSE(',
      '    "GPL");',
      'static int',
      'calculate_total (int count)',
      '{',
      '  return count;',
      '}',
      'EXPORT_SYMBOL(',
      '    calculate_total);',
    ];
    const patch = [
      'diff --git a/src/money.c b/src/money.c',
      'new file mode 100644',
      'index 0000000..abcdef3',
      '--- /dev/null',
      '+++ b/src/money.c',
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n');
    const sources = new Map([['abcdef3', lines.join('\n')]]);
    expect(extractChangedSymbols(patch, { sources }).symbols).toEqual(['calculate_total']);
    // The hunk lexer, without the file, reaches the same answer.
    expect(extractChangedSymbols(patch).symbols).toEqual(['calculate_total']);
  });
});
