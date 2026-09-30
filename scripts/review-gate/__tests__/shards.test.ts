import { describe, expect, it } from 'vitest';

import {
  addedLinesByFile,
  classifyShardFile,
  CONTINUATION_PREFIX,
  metadataOnlySections,
  partitionShards,
  splitPatchByFile,
  splitShardPatch,
  unquoteGitPath,
} from '../shards.mjs';

/** A binary section as `git diff` (without --binary) prints it. */
function binarySection(file: string, { renamedFrom = null as string | null, added = false } = {}) {
  const from = renamedFrom ?? file;
  return [
    `diff --git a/${from} b/${file}`,
    ...(renamedFrom
      ? ['similarity index 100%', `rename from ${renamedFrom}`, `rename to ${file}`]
      : added
        ? ['new file mode 100644', 'index 0000000..1234567']
        : ['index 1234567..89abcde 100644']),
    ...(renamedFrom ? [] : [`Binary files ${added ? '/dev/null' : `a/${file}`} and b/${file} differ`]),
  ].join('\n');
}

function fileSection(file: string, added: number, removed = 0) {
  const lines = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed + 1} +1,${added + 1} @@`,
    ' context',
    ...Array.from({ length: removed }, (_, index) => `-old ${index}`),
    ...Array.from({ length: added }, (_, index) => `+new ${index}`),
  ];
  return lines.join('\n');
}

describe('sharded coverage partition', () => {
  it('classifies files by the lens family a reviewer should apply', () => {
    expect(classifyShardFile('src/lib/stores/workspaceStore.svelte.ts')).toBe('code');
    expect(classifyShardFile('src-tauri/src/core/mesh/mod.rs')).toBe('code');
    expect(classifyShardFile('docs/implementation-plan.md')).toBe('docs');
    expect(classifyShardFile('src/lib/layout/__tests__/fuzz.test.ts')).toBe('tests');
    expect(classifyShardFile('docs/bugs/fixtures/README.md')).toBe('tests');
    expect(classifyShardFile('tests/visual/notes.md')).toBe('tests');
    expect(classifyShardFile('tests/visual/chrome.spec.ts')).toBe('tests');
    expect(classifyShardFile('scripts/sign-artifact.mjs')).toBe('scripts');
    expect(classifyShardFile('src-tauri/launch-shim/src/bin/rove_agent_hook.rs')).toBe('scripts');
    expect(classifyShardFile('src-tauri/resources/agent-notifications/global/pi.js')).toBe('scripts');
    expect(classifyShardFile('src-tauri/permissions/default.toml')).toBe('config');
  });

  it('splits a patch into per-file sections with changed-line counts', () => {
    const patch = [fileSection('src/a.ts', 3, 1), fileSection('docs/b.md', 2)].join('\n');
    const sections = splitPatchByFile(patch);
    expect(sections.map(({ file, kind, changedLines }) => ({ file, kind, changedLines }))).toEqual([
      { file: 'src/a.ts', kind: 'code', changedLines: 4 },
      { file: 'docs/b.md', kind: 'docs', changedLines: 2 },
    ]);
    // Every section carries its own header so a reviewer can read it alone.
    expect(sections[1].text.startsWith('diff --git a/docs/b.md')).toBe(true);
  });

  it('assigns every changed hunk to exactly one shard, code before docs', () => {
    const patch = [
      fileSection('docs/z.md', 100),
      fileSection('src/a.ts', 300),
      fileSection('src/b.ts', 300),
      fileSection('scripts/c.mjs', 50),
    ].join('\n');
    const shards = partitionShards(patch, { targetLines: 500, maxShards: 8 });
    const files = shards.flatMap((shard) => shard.files);
    expect(new Set(files).size).toBe(4);
    expect(files.length).toBe(4);
    // Code shards come first; the docs file is never mixed into a code shard
    // when its own shard is available.
    expect(shards[0].kind).toBe('code');
    expect(shards.at(-1)?.kind).toBe('docs');
    expect(shards.every((shard) => shard.patch.includes('diff --git'))).toBe(true);
    // A shard's patch reproduces its files' sections and nothing else.
    for (const shard of shards) {
      for (const file of shard.files) expect(shard.patch).toContain(`diff --git a/${file}`);
      expect(shard.patch.match(/^diff --git /gm)?.length).toBe(shard.files.length);
    }
  });

  it('keeps the shard count within the cap by raising the per-shard target', () => {
    const patch = Array.from({ length: 20 }, (_, index) => fileSection(`src/f${index}.ts`, 200)).join('\n');
    const shards = partitionShards(patch, { targetLines: 100, maxShards: 4 });
    expect(shards.length).toBeLessThanOrEqual(4);
    expect(shards.reduce((sum, shard) => sum + shard.changedLines, 0)).toBe(4000);
    expect(shards.flatMap((shard) => shard.files).length).toBe(20);
  });

  it('bounds a shard by bytes as well as changed lines', () => {
    // Sections whose text is large but whose changed lines are few.
    const patch = Array.from({ length: 1500 }, (_, index) => (
      fileSection(`src/f${index}.ts`, 1).replace('+new 0', `+${'y'.repeat(400)}`)
    )).join('\n');
    const shards = partitionShards(patch, { targetLines: 5_000, maxShards: 8 });
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.length).toBeLessThanOrEqual(8);
    expect(shards.flatMap((shard) => shard.files).length).toBe(1500);
    const evenShare = Math.ceil(Buffer.byteLength(patch, 'utf8') / 8);
    expect(shards.every((shard) => Buffer.byteLength(shard.patch, 'utf8') <= evenShare + 4_096)).toBe(true);
    // Bytes are UTF-8 bytes, not UTF-16 code units.
    const wide = Array.from({ length: 6 }, (_, index) => fileSection(`src/w${index}.ts`, 1).replace('+new 0', `+${'界'.repeat(30_000)}`)).join('\n');
    const wideShards = partitionShards(wide, { targetLines: 500, maxShards: 8 });
    // Each ~90 KB section exceeds the byte target on its own, so none may
    // be merged with another: one file per shard.
    expect(wideShards.length).toBe(6);
    expect(wideShards.every((shard) => shard.files.length === 1)).toBe(true);
  });

  it('rebalances under the cap instead of pairing two full shards', () => {
    // 60/60/20/20 KB sections with a cap of 2: two ~80 KB shards are feasible.
    const big = (file: string, kb: number) => fileSection(file, 1).replace('+new 0', `+${'x'.repeat(kb * 1024)}`);
    const patch = [big('src/a.ts', 60), big('src/b.ts', 60), big('src/c.ts', 20), big('src/d.ts', 20)].join('\n');
    const shards = partitionShards(patch, { targetLines: 500, maxShards: 2 });
    expect(shards.length).toBe(2);
    const sizes = shards.map((shard) => Buffer.byteLength(shard.patch, 'utf8'));
    expect(Math.max(...sizes)).toBeLessThan(90 * 1024);
  });

  it('orders paths by code unit, not by the host locale', () => {
    const patch = ['src/z.ts', 'src/ä.ts', 'src/a.ts'].map((file) => fileSection(file, 1)).join('\n');
    const [shard] = partitionShards(patch, { targetLines: 500, maxShards: 8 });
    expect(shard.files).toEqual(['src/a.ts', 'src/z.ts', 'src/ä.ts']);
  });

  it('is deterministic and excludes binary visual baselines', () => {
    const patch = [fileSection('src/a.ts', 10), fileSection('tests/visual/x-snapshots/y.png', 1)].join('\n');
    const first = partitionShards(patch, { excludedFiles: ['tests/visual/x-snapshots/y.png'] });
    const second = partitionShards(patch, { excludedFiles: ['tests/visual/x-snapshots/y.png'] });
    expect(first).toEqual(second);
    expect(first.flatMap((shard) => shard.files)).toEqual(['src/a.ts']);
    expect(partitionShards('')).toEqual([]);
  });

  it('gives no shard a section without a textual hunk, and lists it as metadata instead', () => {
    // A reviewer cannot read binary content, and a pure rename or a mode
    // change has no text at all. Owning ~25 such files per shard made 1.11
    // reviewers declare review_complete:false on every asset-moving branch.
    const patch = [
      fileSection('src/a.ts', 10),
      binarySection('assets/photo.png'),
      binarySection('assets/new.webp', { added: true }),
      binarySection('addons/sound/a.ogg', { renamedFrom: 'static/sound/a.ogg' }),
      [
        'diff --git a/src/old.ts b/src/moved.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to src/moved.ts',
      ].join('\n'),
      [
        'diff --git a/scripts/run.sh b/scripts/run.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
      [
        'diff --git a/docs/empty.md b/docs/empty.md',
        'new file mode 100644',
        'index 0000000..e69de29',
      ].join('\n'),
      [
        'diff --git a/src/base.ts b/src/copy.ts',
        'similarity index 100%',
        'copy from src/base.ts',
        'copy to src/copy.ts',
      ].join('\n'),
      fileSection('tests/visual/x-snapshots/y.png', 1),
    ].join('\n');
    const excludedFiles = ['tests/visual/x-snapshots/y.png'];
    const shards = partitionShards(patch, { maxShards: 8, excludedFiles });
    expect(shards.flatMap((shard) => shard.files)).toEqual(['src/a.ts']);
    expect(shards[0].patch).not.toContain('Binary files');
    expect(metadataOnlySections(patch, { excludedFiles })).toEqual([
      { file: 'addons/sound/a.ogg', renamedFrom: 'static/sound/a.ogg', reason: 'rename' },
      { file: 'assets/new.webp', reason: 'binary' },
      { file: 'assets/photo.png', reason: 'binary' },
      { file: 'docs/empty.md', reason: 'empty' },
      { file: 'scripts/run.sh', reason: 'mode' },
      { file: 'src/copy.ts', reason: 'copy' },
      { file: 'src/moved.ts', renamedFrom: 'src/old.ts', reason: 'rename' },
    ]);
  });

  it('keeps every section that has a hunk in a shard, a partial rename and a text deletion included', () => {
    const partialRename = [
      'diff --git a/src/before.ts b/src/after.ts',
      'similarity index 90%',
      'rename from src/before.ts',
      'rename to src/after.ts',
      '--- a/src/before.ts',
      '+++ b/src/after.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
    ].join('\n');
    const deletion = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index 1234567..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const gone = 1;',
    ].join('\n');
    const binaryRewrite = [
      'diff --git a/assets/a.png b/assets/b.png',
      'similarity index 60%',
      'rename from assets/a.png',
      'rename to assets/b.png',
      'index 1234567..89abcde 100644',
      'Binary files a/assets/a.png and b/assets/b.png differ',
    ].join('\n');
    const patch = [partialRename, deletion, binaryRewrite].join('\n');
    const files = partitionShards(patch, { maxShards: 8 }).flatMap((shard) => shard.files).sort();
    expect(files).toEqual(['src/after.ts', 'src/gone.ts']);
    expect(metadataOnlySections(patch)).toEqual([
      { file: 'assets/b.png', renamedFrom: 'assets/a.png', reason: 'binary' },
    ]);
  });

  it('splits a shard into parts that each fit one read, naming the file a part continues', () => {
    expect(splitShardPatch('diff --git a/x b/x\n+one\n', 1024)).toEqual(['diff --git a/x b/x\n+one\n']);
    const big = `${fileSection('src/big.ts', 200).replace(/\+new (\d+)/g, (_, index) => `+new ${index} ${'z'.repeat(40)}`)}\n`;
    const small = `${fileSection('src/small.ts', 2)}\n`;
    const patch = big + small;
    const parts = splitShardPatch(patch, 4096);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((part) => Buffer.byteLength(part, 'utf8') <= 4096)).toBe(true);
    // Only parts that begin inside a file carry the continuation line.
    expect(parts[0].startsWith('diff --git a/src/big.ts')).toBe(true);
    for (const part of parts.slice(1, -1)) {
      expect(part.startsWith(`${CONTINUATION_PREFIX}src/big.ts`)).toBe(true);
    }
    expect(parts.some((part) => part.startsWith('diff --git a/src/small.ts') || part.includes('\ndiff --git a/src/small.ts'))).toBe(true);
    const restored = parts.map((part) => (part.startsWith(CONTINUATION_PREFIX) ? part.slice(part.indexOf('\n') + 1) : part)).join('');
    expect(restored).toBe(patch);
    // A line longer than a part keeps a part of its own instead of vanishing.
    const wide = `diff --git a/w b/w\n+${'w'.repeat(5000)}\n+tail\n`;
    const wideParts = splitShardPatch(wide, 1024);
    expect(wideParts.map((part) => (part.startsWith(CONTINUATION_PREFIX) ? part.slice(part.indexOf('\n') + 1) : part)).join('')).toBe(wide);
  });

  it('leaves a diff of metadata-only sections without shards (the lens reviewers take it)', () => {
    const patch = [binarySection('a.png'), binarySection('b/c.ogg', { renamedFrom: 'c.ogg' })].join('\n');
    expect(partitionShards(patch, { maxShards: 8 })).toEqual([]);
    expect(metadataOnlySections(patch).map((entry) => entry.file)).toEqual(['a.png', 'b/c.ogg']);
  });

  it('gives an oversized single file its own shard instead of dropping it', () => {
    const patch = [fileSection('src/big.ts', 2000), fileSection('src/small.ts', 5)].join('\n');
    const shards = partitionShards(patch, { targetLines: 500, maxShards: 8 });
    expect(shards.length).toBe(2);
    expect(shards[0].files).toEqual(['src/big.ts']);
  });

  it('decodes Git-quoted (non-ASCII) paths so sharding and changed-line lookup keep working', () => {
    expect(unquoteGitPath('docs/gu\\303\\255a.md')).toBe('docs/guía.md');
    expect(unquoteGitPath('a\\"b\\\\c\\t')).toBe('a"b\\c\t');
    expect(unquoteGitPath('plain/path.md')).toBe('plain/path.md');
    const patch = [
      'diff --git "a/docs/gu\\303\\255a.md" "b/docs/gu\\303\\255a.md"',
      '--- "a/docs/gu\\303\\255a.md"',
      '+++ "b/docs/gu\\303\\255a.md"',
      '@@ -1,0 +1,1 @@',
      '+hola',
    ].join('\n');
    expect(splitPatchByFile(patch).map(({ file, kind }) => ({ file, kind }))).toEqual([{ file: 'docs/guía.md', kind: 'docs' }]);
    expect([...addedLinesByFile(patch).get('docs/guía.md') ?? []]).toEqual([1]);
  });

  it('keeps an unquoted path that itself contains " b/" intact', () => {
    const file = 'docs/foo b/bar.md';
    const patch = [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1,0 +1,1 @@',
      '+x',
    ].join('\n');
    expect(splitPatchByFile(patch).map(({ file: parsed }) => parsed)).toEqual([file]);
    expect([...addedLinesByFile(patch).get(file) ?? []]).toEqual([1]);
    // A rename has no equal split; the `+++ b/` line settles it, even when
    // the old path itself contains " b/".
    expect(splitPatchByFile('diff --git a/old.md b/new.md\n').map(({ file: parsed }) => parsed)).toEqual(['new.md']);
    const rename = [
      'diff --git a/docs/x b/y.md b/docs/z.md',
      '--- a/docs/x b/y.md',
      '+++ b/docs/z.md',
      '@@ -1,0 +1,1 @@',
      '+x',
    ].join('\n');
    expect(splitPatchByFile(rename).map(({ file: parsed }) => parsed)).toEqual(['docs/z.md']);
    expect([...addedLinesByFile(rename).get('docs/z.md') ?? []]).toEqual([1]);
    // A rename-only or binary rename has no +++ line; `rename to` settles it.
    const renameOnly = [
      'diff --git a/docs/x b/y.md b/docs/z.md',
      'similarity index 100%',
      'rename from docs/x b/y.md',
      'rename to docs/z.md',
    ].join('\n');
    expect(splitPatchByFile(renameOnly).map(({ file: parsed }) => parsed)).toEqual(['docs/z.md']);
    // Metadata lines before the first hunk never advance the line counter,
    // so the later +++ / rename-to line still settles the path.
    const renamedWithHunk = [
      'diff --git a/docs/x b/y.md b/docs/z.md',
      'similarity index 90%',
      'rename from docs/x b/y.md',
      'rename to docs/z.md',
      'index 1..2 100644',
      '--- a/docs/x b/y.md',
      '+++ b/docs/z.md',
      '@@ -1,0 +1,1 @@',
      '+x',
    ].join('\n');
    expect([...addedLinesByFile(renamedWithHunk).get('docs/z.md') ?? []]).toEqual([1]);
    expect(splitPatchByFile(renamedWithHunk)[0]).toMatchObject({ file: 'docs/z.md', renamedFrom: 'docs/x b/y.md' });
  });

  it('maps added lines to new-side line numbers per file', () => {
    const patch = [
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -10,3 +10,5 @@',
      ' keep',
      '-gone',
      '+added eleven',
      '+added twelve',
      ' keep',
      '+added fourteen',
      '@@ -40,1 +42,2 @@',
      ' keep',
      '+added forty-three',
    ].join('\n');
    const added = addedLinesByFile(patch);
    expect([...added.get('docs/a.md') ?? []]).toEqual([11, 12, 14, 43]);
    expect(added.has('docs/none.md')).toBe(false);
  });
});
