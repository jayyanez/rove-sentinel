import { describe, expect, it } from 'vitest';

import {
  addedControlIds,
  branchEvidenceSlug,
  changedRegistryRowIds,
  evidenceScreenshotPaths,
  expressionControlAttributes,
  formatGuiEvidenceRefusal,
  isForwardedControlProp,
  guiEvidenceProblems,
  isGuiDiff,
  isPngBlob,
  normalizeChangedFiles,
  patchFileSections,
  registryControlIds,
  removedControlIds,
  reviewDocPath,
} from '../guiEvidence.mjs';

const BRANCH = 'claude/visual-redesign-v1';
const PNG = 'docs/design/reviews/claude-visual-redesign-v1/pane-header-dark.png';
const REVIEW = 'docs/design/reviews/claude-visual-redesign-v1/REVIEW.md';
const REGISTRY = 'docs/design/control-registry.md';
// A real 1x1 PNG (signature + IHDR + IDAT + IEND), the smallest file the
// byte check must accept.
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const REGISTRY_TEXT = [
  '| Column | Meaning |',
  '|---|---|',
  '| `id` | The exact value |',
  '',
  '| id | surface | zone | order | visibility | precedent | catalog action |',
  '|---|---|---|---|---|---|---|',
  '| `pane.close` | pane-header | trailing | 1 | always | none | `pane.close` |',
  '| `pane.split` | pane-header | trailing | 2 | always | none | — |',
].join('\n');

function patchFor(file: string, lines: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,3 +1,3 @@', ...lines].join('\n');
}

/** A registry patch that adds (or rewrites) the row of `id`. */
function registryRowPatch(id: string, surface = 'pane-header'): string {
  return patchFor(REGISTRY, [`+| \`${id}\` | ${surface} | trailing | 3 | always | none | — |`]);
}

describe('GUI evidence gate', () => {
  it('derives the evidence folder slug from the branch name', () => {
    expect(branchEvidenceSlug(BRANCH)).toBe('claude-visual-redesign-v1');
    expect(branchEvidenceSlug('codex/a/b')).toBe('codex-a-b');
    expect(branchEvidenceSlug('main')).toBe('main');
    // Same sanitiser as scripts/design-review/capture.mjs: every char outside
    // [A-Za-z0-9._-] becomes "-", so both sides agree on the folder name.
    expect(branchEvidenceSlug('feat/ñ#1')).toBe('feat---1');
  });

  it('classifies tag vs branch by the explicit refType, never by a tag/ name prefix', () => {
    // A BRANCH literally named `tag/release` is a branch: its evidence lives
    // under docs/design/reviews/tag-release/, and a PNG under another folder
    // is not its evidence. Only refType 'tag' relaxes the folder rule.
    const files = ['src/lib/components/PaneHeader.svelte', PNG, REVIEW];
    const asBranch = guiEvidenceProblems({ files, branch: 'tag/release', refType: 'branch' });
    expect(asBranch).toHaveLength(2);
    expect(asBranch[0]).toContain('no .png under docs/design/reviews/tag-release/');
    expect(asBranch[0]).toContain('belong to a different branch');
    expect(asBranch[1]).toContain('docs/design/reviews/tag-release/REVIEW.md is not added or modified in this diff');
    // Omitting refType is the branch rule too.
    expect(guiEvidenceProblems({ files, branch: 'tag/release' })).toEqual(asBranch);
    expect(evidenceScreenshotPaths(files, 'tag/release')).toEqual([]);
    expect(evidenceScreenshotPaths(files, 'tag/release', 'branch')).toEqual([]);
    // The same diff on a real tag follows the tag rule, whatever its name.
    expect(guiEvidenceProblems({ files, branch: 'tag/release', refType: 'tag' })).toEqual([]);
    expect(guiEvidenceProblems({ files, branch: 'v0.9.0', refType: 'tag' })).toEqual([]);
    expect(evidenceScreenshotPaths(files, 'v0.9.0', 'tag')).toEqual([PNG]);
    // Anything that is not 'tag' is the branch rule (fail closed on a typo).
    expect(guiEvidenceProblems({ files, branch: 'tag/release', refType: 'tags' as never })).toEqual(asBranch);
  });

  it('normalises plain paths (assumed added) and status-carrying entries', () => {
    expect(normalizeChangedFiles(['a.svelte', { path: 'b.png', status: 'D' }, { path: 'c.png', status: 'R100' }, '', null]))
      .toEqual([
        { path: 'a.svelte', status: 'A' },
        { path: 'b.png', status: 'D' },
        { path: 'c.png', status: 'R' },
      ]);
    expect(normalizeChangedFiles(undefined)).toEqual([]);
  });

  it('recognises a GUI diff by the governed file kinds and never by prose', () => {
    expect(isGuiDiff(['src/lib/components/PaneHeader.svelte'])).toBe(true);
    expect(isGuiDiff([{ path: 'src/app.css', status: 'M' }])).toBe(true);
    expect(isGuiDiff(['src/lib/theme/tokens.ts'])).toBe(true);
    expect(isGuiDiff(['src/lib/components/shared/Icon.svelte'])).toBe(true);
    // The first-paint bootstrap carries palette values and stamps the theme
    // attributes the mode-derived tokens key on: a change there is visual.
    expect(isGuiDiff(['src/app.html'])).toBe(true);
    expect(isGuiDiff([{ path: 'src/app.html', status: 'M' }])).toBe(true);
    expect(isGuiDiff(['src/app.d.ts'])).toBe(false);
    expect(isGuiDiff(['docs/design/design-system.md'])).toBe(false);
    expect(isGuiDiff(['docs/svelte-notes.svelte.md'])).toBe(false);
    expect(isGuiDiff(['src/lib/layout/engine.ts', 'src-tauri/src/lib.rs'])).toBe(false);
    // Component-adjacent TS (positioning, keyboard contracts) and the story /
    // route sources decide what the GUI does; their tests do not.
    expect(isGuiDiff(['src/lib/components/shared/popoverPosition.ts'])).toBe(true);
    expect(isGuiDiff(['src/lib/components/shared/modalKeydown.ts'])).toBe(true);
    expect(isGuiDiff(['src/routes/dev/components/+page.svelte'])).toBe(true);
    expect(isGuiDiff(['src/routes/+layout.ts'])).toBe(true);
    expect(isGuiDiff(['src/lib/components/shared/__tests__/x.test.ts'])).toBe(false);
    expect(isGuiDiff(['src/lib/components/shared/__tests__/fixture.ts'])).toBe(false);
    expect(isGuiDiff(['src/lib/components/shared/popoverPosition.test.ts'])).toBe(false);
    expect(isGuiDiff(['src/lib/theme/__tests__/tokenLint.test.ts'])).toBe(false);
    expect(isGuiDiff(['src/routes/dev/components/__tests__/page.test.ts'])).toBe(false);
    expect(isGuiDiff(['src/lib/layout/x.ts'])).toBe(false);
    expect(isGuiDiff([])).toBe(false);
    expect(isGuiDiff(undefined)).toBe(false);
  });

  it('splits a patch into per-file sections keyed by the post-image path', () => {
    const patch = [
      patchFor('src/A.svelte', ['+a']),
      'diff --git a/old.svelte b/new.svelte',
      'similarity index 90%',
      'rename from old.svelte',
      'rename to new.svelte',
      '--- a/old.svelte',
      '+++ b/new.svelte',
      '+b',
      'diff --git a/gone.svelte b/gone.svelte',
      'deleted file mode 100644',
      '--- a/gone.svelte',
      '+++ /dev/null',
      '-c',
    ].join('\n');
    expect(patchFileSections(patch).map(({ file, lines }) => [file, lines.filter((l) => /^[+-]/.test(l))])).toEqual([
      ['src/A.svelte', ['+a']],
      ['new.svelte', ['+b']],
      ['gone.svelte', ['-c']],
    ]);
    // Bare hunks (no headers) form one anonymous section.
    expect(patchFileSections('+x\n-y')).toEqual([{ file: '', lines: ['+x', '-y'] }]);
  });

  it('extracts only genuinely new data-control ids from added lines', () => {
    const patch = patchFor('src/lib/components/A.svelte', [
      ' <button data-control="pane.close">',
      '-<button data-control="pane.split-old" data-control=\'pane.moved\'>',
      '+<button data-control="pane.split" data-control=\'pane.moved\'>',
      '+<button data-control="pane.close">',
    ]);
    expect(addedControlIds(patch)).toEqual(['pane.split']);
    expect(addedControlIds('')).toEqual([]);
  });

  it('treats an id as new in a file where it did not exist at base, even when removed elsewhere', () => {
    // The old "removed anywhere" subtraction let a control move from one
    // surface to another without a placement decision.
    const patch = [
      patchFor('src/lib/components/Toolbar.svelte', ['-<button data-control="pane.split">']),
      patchFor('src/lib/components/PaneHeader.svelte', ['+<button data-control="pane.split">']),
    ].join('\n');
    expect(addedControlIds(patch)).toEqual(['pane.split']);
    // The same edit inside ONE file is a move, not a new control.
    expect(addedControlIds(patchFor('src/lib/components/PaneHeader.svelte', [
      '-<button data-control="pane.split">',
      '+<IconButton data-control="pane.split" />',
    ]))).toEqual([]);
  });

  it('scans only component sources: fixtures in tests, scripts and docs are text about controls', () => {
    const patch = [
      patchFor('scripts/review-gate/__tests__/guiEvidence.test.ts', ['+  const patch = "+<button data-control=\"pane.fixture\">";']),
      patchFor('docs/design/control-registry.md', ['+| `pane.doc` | … |', '+data-control={expr}']),
      patchFor('src/lib/theme/__tests__/controlRegistry.test.ts', ['+<i data-control={id}>']),
      patchFor('src/lib/components/PaneHeader.svelte', ['+<button data-control="pane.real">']),
    ].join('\n');
    expect(addedControlIds(patch)).toEqual(['pane.real']);
    expect(expressionControlAttributes(patch)).toEqual([]);
  });

  it('finds expression-valued data-control attributes on added lines only', () => {
    const patch = patchFor('src/lib/components/Row.svelte', [
      '-<button data-control={oldId}>',
      '+<button data-control={`row.${kind}`}>',
      '+<button data-control={id} data-control="row.literal">',
      ' <button data-control={contextOnly}>',
    ]);
    expect(expressionControlAttributes(patch)).toEqual([
      { file: 'src/lib/components/Row.svelte', value: '{`row.${kind}`}>' },
      { file: 'src/lib/components/Row.svelte', value: '{id}' },
    ]);
    expect(expressionControlAttributes('+<a data-control="fine">')).toEqual([]);
  });

  it('allows only a shared primitive forwarding its dataControl prop', () => {
    expect(isForwardedControlProp('src/lib/components/shared/Button.svelte', '{dataControl}')).toBe(true);
    expect(isForwardedControlProp('src/lib/components/shared/Button.svelte', '{dataControl}>')).toBe(true);
    expect(isForwardedControlProp('src/lib/components/PaneHeader.svelte', '{dataControl}')).toBe(false);
    expect(isForwardedControlProp('src/lib/components/shared/Button.svelte', '{id}')).toBe(false);
    expect(expressionControlAttributes(patchFor('src/lib/components/shared/Button.svelte', [
      '+  data-control={dataControl}',
    ]))).toEqual([]);
    expect(expressionControlAttributes(patchFor('src/lib/components/PaneHeader.svelte', [
      '+  data-control={dataControl}',
    ]))).toEqual([{ file: 'src/lib/components/PaneHeader.svelte', value: '{dataControl}' }]);
  });

  it('reads registry ids from seven-column rows with a backticked id', () => {
    expect([...registryControlIds(REGISTRY_TEXT)]).toEqual(['pane.close', 'pane.split']);
    expect(registryControlIds('')).toEqual(new Set());
  });

  it('refuses a GUI diff that carries no screenshot for this branch', () => {
    const problems = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', REVIEW],
      branch: BRANCH,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docs/design/reviews/claude-visual-redesign-v1/');
    expect(problems[0]).toContain('pnpm design:capture');
  });

  it('accepts a GUI diff whose screenshot and REVIEW.md live under the branch slug', () => {
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW],
      branch: BRANCH,
    })).toEqual([]);
    for (const status of ['A', 'M', 'R', 'C']) {
      expect(guiEvidenceProblems({
        files: [{ path: 'src/lib/components/PaneHeader.svelte', status: 'M' }, { path: PNG, status }, { path: REVIEW, status }],
        branch: BRANCH,
      }), status).toEqual([]);
    }
  });

  it('requires the branch REVIEW.md to be added or modified IN THE DIFF, not only present at head', () => {
    // A PNG-only evidence diff: screenshots without the checklist / findings /
    // deviations are not a review.
    const pngOnly = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG],
      branch: BRANCH,
    });
    expect(pngOnly).toHaveLength(1);
    expect(pngOnly[0]).toContain(`GUI diff without its review document: ${REVIEW} is not added or modified in this diff`);
    // A deleted REVIEW.md is not a review either.
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, { path: REVIEW, status: 'D' }],
      branch: BRANCH,
    })[0]).toContain(REVIEW);
    // Another branch's REVIEW.md does not count.
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, 'docs/design/reviews/codex-other-branch/REVIEW.md'],
      branch: BRANCH,
    })[0]).toContain(REVIEW);
    // Present at head but untouched by this diff (inherited from an ancestor
    // commit): the evidence is new, the review is not — refused, even when a
    // head reader says the file exists.
    const inherited = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG],
      branch: BRANCH,
      hasFile: (file: string) => file === REVIEW,
    });
    expect(inherited).toHaveLength(1);
    expect(inherited[0]).toContain(`${REVIEW} is not added or modified in this diff`);
    // Added or modified in the diff passes; deleted is refused.
    for (const status of ['A', 'M']) {
      expect(guiEvidenceProblems({
        files: [{ path: 'src/lib/components/PaneHeader.svelte', status: 'M' }, PNG, { path: REVIEW, status }],
        branch: BRANCH,
        hasFile: () => true,
      }), status).toEqual([]);
    }
    expect(guiEvidenceProblems({
      files: [{ path: 'src/lib/components/PaneHeader.svelte', status: 'M' }, PNG, { path: REVIEW, status: 'D' }],
      branch: BRANCH,
      hasFile: () => true,
    })[0]).toContain(`${REVIEW} is not added or modified in this diff`);
    expect(reviewDocPath('x-y')).toBe('docs/design/reviews/x-y/REVIEW.md');
  });

  it('keeps the present-at-head rule for a tag: its REVIEW.md may predate the diff', () => {
    // A tag has no branch of its own; the review next to the PNG it carries
    // is read at head through the reader, whether or not this diff touched it.
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG],
      branch: 'v0.9.0',
      refType: 'tag',
      hasFile: (file: string) => file === REVIEW,
    })).toEqual([]);
    const absent = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW],
      branch: 'v0.9.0',
      refType: 'tag',
      hasFile: () => false,
    });
    expect(absent).toHaveLength(1);
    expect(absent[0]).toContain(`${REVIEW} is not present at head`);
  });

  it('never counts a DELETED screenshot as evidence', () => {
    const problems = guiEvidenceProblems({
      files: [{ path: 'src/lib/components/PaneHeader.svelte', status: 'M' }, { path: PNG, status: 'D' }, REVIEW],
      branch: BRANCH,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('DELETES screenshots');
    expect(problems[0]).toContain('a removed file is not evidence');
  });

  it('does not inherit a screenshot committed under another branch slug', () => {
    const problems = guiEvidenceProblems({
      files: [
        'src/lib/components/PaneHeader.svelte',
        'docs/design/reviews/codex-other-branch/pane-header-dark.png',
        REVIEW,
      ],
      branch: BRANCH,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docs/design/reviews/codex-other-branch/');
    expect(problems[0]).toContain('belong to a different branch');
    expect(problems[0]).toContain('pnpm design:capture');
  });

  it('does not skip a tag: its diff must carry a screenshot under ANY reviews folder', () => {
    // Git never requires a tagged commit to have been pushed through a
    // branch, so the tag cannot inherit a branch review that may never have
    // happened. A tag has no slug, so any reviews folder counts.
    const bare = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte'],
      branch: 'v0.9.0',
      refType: 'tag',
    });
    expect(bare).toHaveLength(2);
    expect(bare[0]).toContain('no .png under docs/design/reviews/<slug>/');
    expect(bare[0]).toContain('A tag has no branch slug');
    expect(bare[1]).toContain('docs/design/reviews/<slug>/REVIEW.md is not present at head');
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW],
      branch: 'v0.9.0',
      refType: 'tag',
    })).toEqual([]);
    // The REVIEW.md is the one NEXT TO the counted PNG: any folder, but the
    // same folder.
    const other = 'docs/design/reviews/codex-other-branch/shot.png';
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', other, 'docs/design/reviews/codex-other-branch/REVIEW.md'],
      branch: 'v0.9.0',
      refType: 'tag',
    })).toEqual([]);
    const mismatched = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', other, REVIEW],
      branch: 'v0.9.0',
      refType: 'tag',
    });
    expect(mismatched).toHaveLength(1);
    expect(mismatched[0]).toContain('docs/design/reviews/codex-other-branch/REVIEW.md is not present at head');
    expect(mismatched[0]).toContain('next to the evidence PNGs the tag carries');
    // Two folders contribute counted PNGs: EVERY one needs its REVIEW.md, not
    // just one of them.
    const twoFolders = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW, other],
      branch: 'v0.9.0',
      refType: 'tag',
    });
    expect(twoFolders).toHaveLength(1);
    expect(twoFolders[0]).toContain('docs/design/reviews/codex-other-branch/REVIEW.md is not present at head');
    expect(twoFolders[0]).not.toContain(REVIEW);
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW, other, 'docs/design/reviews/codex-other-branch/REVIEW.md'],
      branch: 'v0.9.0',
      refType: 'tag',
    })).toEqual([]);
    // A deleted screenshot is still no evidence for a tag.
    const deleted = guiEvidenceProblems({
      files: [{ path: 'src/lib/components/PaneHeader.svelte', status: 'M' }, { path: PNG, status: 'D' }, REVIEW],
      branch: 'v0.9.0',
      refType: 'tag',
    });
    expect(deleted).toHaveLength(2);
    expect(deleted[0]).toContain('DELETES screenshots');
    // The registry rule applies unchanged on a tag.
    const control = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW],
      branch: 'v0.9.0',
      refType: 'tag',
      patch: patchFor('src/lib/components/PaneHeader.svelte', ['+<button data-control="pane.unregistered">x</button>']),
      registry: REGISTRY_TEXT,
    });
    expect(control).toHaveLength(1);
    expect(control[0]).toContain('data-control="pane.unregistered"');
  });

  it('lists the screenshots prepush must read back: the branch folder, or any folder for a tag', () => {
    const other = 'docs/design/reviews/codex-other-branch/shot.png';
    const files = [
      'src/lib/components/PaneHeader.svelte',
      PNG,
      { path: 'docs/design/reviews/claude-visual-redesign-v1/gone.png', status: 'D' },
      other,
      'docs/design/reviews/claude-visual-redesign-v1/notes.md',
    ];
    expect(evidenceScreenshotPaths(files, BRANCH)).toEqual([PNG]);
    expect(evidenceScreenshotPaths(files, 'v1', 'tag')).toEqual([PNG, other]);
  });

  it('recognises a PNG blob by its 8-byte signature and a body beyond it', () => {
    expect(isPngBlob(REAL_PNG)).toBe(true);
    expect(isPngBlob(Buffer.from('png'))).toBe(false);
    expect(isPngBlob(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).toBe(false); // signature only
    expect(isPngBlob(Buffer.from([1]))).toBe(false);
    expect(isPngBlob(null)).toBe(false);
    expect(isPngBlob(undefined)).toBe(false);
    expect(isPngBlob('\x89PNG\r\n\x1a\n....')).toBe(false); // a string is not bytes
  });

  it('validates the chunk structure: IHDR first, chunks inside the file, IEND last', () => {
    const signature = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');
    // Signature + one garbage byte: not a chunk header.
    expect(isPngBlob(Buffer.concat([signature, Buffer.from([0x42])]))).toBe(false);
    // Signature + 12 bytes that spell a chunk of length 0 with a non-IHDR type.
    expect(isPngBlob(Buffer.concat([signature, Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0])]))).toBe(false);
    // A real PNG cut before its IEND chunk (the last 12 bytes).
    expect(isPngBlob(REAL_PNG.subarray(0, REAL_PNG.length - 12))).toBe(false);
    // A real PNG truncated in the middle of its IDAT chunk.
    expect(isPngBlob(REAL_PNG.subarray(0, REAL_PNG.length - 20))).toBe(false);
    // Trailing garbage after IEND is not a PNG file either.
    expect(isPngBlob(Buffer.concat([REAL_PNG, Buffer.from([0])]))).toBe(false);
    // IHDR that declares a zero-sized image.
    const zeroWidth = Buffer.from(REAL_PNG);
    zeroWidth.writeUInt32BE(0, 16);
    expect(isPngBlob(zeroWidth)).toBe(false);
    // The signature followed by an IHDR-sized chunk of the wrong type.
    const wrongFirst = Buffer.from(REAL_PNG);
    wrongFirst.write('tEXt', 12, 'latin1');
    expect(isPngBlob(wrongFirst)).toBe(false);
  });

  it('requires at least one non-empty IDAT chunk: IHDR + IEND alone is no image', () => {
    // Structurally valid chunk walk, no pixel data at all: a capture that
    // wrote a header and closed the file is not a screenshot.
    const ihdr = REAL_PNG.subarray(0, 8 + 12 + 13); // signature + IHDR chunk
    const iend = REAL_PNG.subarray(REAL_PNG.length - 12);
    expect(isPngBlob(Buffer.concat([ihdr, iend]))).toBe(false);
    // An EMPTY IDAT chunk carries no data either.
    const emptyIdat = Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0]);
    expect(isPngBlob(Buffer.concat([ihdr, emptyIdat, iend]))).toBe(false);
    // The real file (its IDAT is non-empty) still passes, as does one with an
    // ancillary chunk between IHDR and IDAT.
    expect(isPngBlob(REAL_PNG)).toBe(true);
    const text = Buffer.from([0, 0, 0, 1, 0x74, 0x45, 0x58, 0x74, 0x41, 0, 0, 0, 0]);
    expect(isPngBlob(Buffer.concat([ihdr, text, REAL_PNG.subarray(8 + 12 + 13)]))).toBe(true);
  });

  it('inflates the IDAT stream and checks it against the IHDR geometry', () => {
    const ihdr = REAL_PNG.subarray(0, 8 + 12 + 13); // signature + IHDR chunk
    const iend = REAL_PNG.subarray(REAL_PNG.length - 12);
    const idatChunk = (payload: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(payload.length, 0);
      head.write('IDAT', 4, 'latin1');
      return Buffer.concat([head, payload, Buffer.alloc(4)]);
    };
    // Valid framing around a one-byte garbage IDAT payload: not a deflate stream.
    expect(isPngBlob(Buffer.concat([ihdr, idatChunk(Buffer.from([0x42])), iend]))).toBe(false);
    // The real deflate stream cut short: inflate fails on the truncated input.
    const realIdat = REAL_PNG.subarray(8 + 12 + 13 + 8, REAL_PNG.length - 12 - 4);
    expect(realIdat.length).toBeGreaterThan(4);
    expect(isPngBlob(Buffer.concat([ihdr, idatChunk(realIdat.subarray(0, realIdat.length - 4)), iend]))).toBe(false);
    // A valid deflate stream whose raw size does not match the header: the
    // real 1x1 stream (one filter byte + 4 RGBA bytes) under an IHDR claiming 2x1.
    const twoWide = Buffer.from(ihdr);
    twoWide.writeUInt32BE(2, 16);
    expect(isPngBlob(Buffer.concat([twoWide, idatChunk(realIdat), iend]))).toBe(false);
    // An interlaced (Adam7) header is refused even over a stream that inflates:
    // screenshot tools never write it, and its pass geometry is not validated.
    const interlaced = Buffer.from(ihdr);
    interlaced[8 + 8 + 12] = 1; // signature + chunk length/type + IHDR field 12
    expect(isPngBlob(Buffer.concat([interlaced, idatChunk(realIdat), iend]))).toBe(false);
    // The stream split across two IDAT chunks is still one stream.
    const split = Buffer.concat([ihdr, idatChunk(realIdat.subarray(0, 3)), idatChunk(realIdat.subarray(3)), iend]);
    expect(isPngBlob(split)).toBe(true);
    expect(isPngBlob(REAL_PNG)).toBe(true);
  });

  it('pngValid(path) is the bounded per-file verdict and takes precedence over readBlob', () => {
    const svelte = 'src/lib/components/PaneHeader.svelte';
    const files = [svelte, 'docs/design/reviews/claude-x/REVIEW.md', 'docs/design/reviews/claude-x/a.png', 'docs/design/reviews/claude-x/b.png'];
    const calls: string[] = [];
    // A reader that would ACCEPT both is ignored when pngValid is given.
    const problems = guiEvidenceProblems({
      files, branch: 'claude/x', registry: '',
      readBlob: () => REAL_PNG,
      pngValid: (path) => { calls.push(path); return path.endsWith('a.png'); }
    });
    expect(calls).toEqual(['docs/design/reviews/claude-x/a.png', 'docs/design/reviews/claude-x/b.png']);
    expect(problems.join('\n')).toContain('b.png');
    expect(problems.join('\n')).not.toContain('a.png');
    expect(guiEvidenceProblems({ files, branch: 'claude/x', registry: '', pngValid: () => true })).toEqual([]);
  });

  it('refuses an evidence file whose bytes at head are not a PNG, naming its path', () => {
    const svelte = 'src/lib/components/PaneHeader.svelte';
    expect(guiEvidenceProblems({
      files: [svelte, PNG, REVIEW],
      branch: BRANCH,
      readBlob: () => REAL_PNG,
    })).toEqual([]);
    const text = guiEvidenceProblems({
      files: [svelte, PNG, REVIEW],
      branch: BRANCH,
      readBlob: () => Buffer.from('not really a png\n'),
    });
    expect(text).toHaveLength(2);
    expect(text[0]).toContain('no .png under docs/design/reviews/claude-visual-redesign-v1/');
    expect(text[1]).toContain(`not a readable PNG as committed at head: ${PNG}`);
    // An unreadable blob (absent at head) is refused the same way.
    expect(guiEvidenceProblems({ files: [svelte, PNG, REVIEW], branch: BRANCH, readBlob: () => null })[1])
      .toContain(PNG);
    // One real screenshot does not launder a fake one next to it.
    const fake = 'docs/design/reviews/claude-visual-redesign-v1/fake.png';
    const mixed = guiEvidenceProblems({
      files: [svelte, PNG, fake, REVIEW],
      branch: BRANCH,
      readBlob: (file: string) => (file === PNG ? REAL_PNG : Buffer.from('text')),
    });
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toContain(fake);
    expect(mixed[0]).not.toContain('pane-header-dark.png');
  });

  it('ignores non-png files under the evidence folder', () => {
    expect(guiEvidenceProblems({
      files: ['src/app.css', 'docs/design/reviews/claude-visual-redesign-v1/notes.md', REVIEW],
      branch: BRANCH,
    })).toHaveLength(1);
  });

  it('demands a registry ROW at head for every new data-control id, not a touched file', () => {
    const patch = patchFor('src/lib/components/PaneHeader.svelte', ['+<button data-control="pane.new">']);
    const files = ['src/lib/components/PaneHeader.svelte', PNG, REVIEW, REGISTRY];
    // The registry changed in the diff but has no row for the id: still refused.
    const touchedOnly = guiEvidenceProblems({ files, branch: BRANCH, patch, registry: REGISTRY_TEXT });
    expect(touchedOnly).toHaveLength(1);
    expect(touchedOnly[0]).toContain('data-control="pane.new"');
    expect(touchedOnly[0]).toContain('changes in this diff but has no row');
    expect(touchedOnly[0]).toContain('surface · zone · order · visibility rule · precedent');
    // Untouched registry, no row.
    const untouched = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW], branch: BRANCH, patch, registry: REGISTRY_TEXT,
    });
    expect(untouched).toHaveLength(1);
    expect(untouched[0]).toContain(`${REGISTRY} at head has no row`);
    // A row present at head passes when that ROW is part of the diff.
    const withRow = `${REGISTRY_TEXT}\n| \`pane.new\` | pane-header | trailing | 3 | always | none | — |`;
    const rowPatch = `${patch}\n${registryRowPatch('pane.new')}`;
    expect(guiEvidenceProblems({ files, branch: BRANCH, patch: rowPatch, registry: withRow })).toEqual([]);
    // The registry file in the diff with an UNRELATED row changed: the row for
    // this id pre-exists at head but was never revisited here — refused.
    const unrelated = guiEvidenceProblems({
      files, branch: BRANCH, patch: `${patch}\n${registryRowPatch('pane.other')}`, registry: withRow,
    });
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]).toContain('data-control="pane.new"');
    expect(unrelated[0]).toContain('changes in this diff but its row is not among the changed lines');
    // A row that pre-exists at head while the registry is NOT in the diff is
    // a placement never decided in this change: refused.
    const stale = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW], branch: BRANCH, patch, registry: withRow,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('data-control="pane.new"');
    expect(stale[0]).toContain(`without touching ${REGISTRY}`);
    expect(stale[0]).toContain('update its registry row');
  });

  it('a registered control moved to another component must update its registry row in the diff', () => {
    // Removed from the toolbar, added to the pane header: the row still says
    // "app-toolbar" unless the diff revisits it.
    const patch = [
      patchFor('src/lib/components/Toolbar.svelte', ['-<button data-control="pane.split">']),
      patchFor('src/lib/components/PaneHeader.svelte', ['+<button data-control="pane.split">']),
    ].join('\n');
    expect(removedControlIds(patch)).toEqual(['pane.split']);
    expect(removedControlIds(patchFor('src/lib/components/PaneHeader.svelte', [
      '-<button data-control="pane.split">',
      '+<IconButton data-control="pane.split" />',
    ]))).toEqual([]);
    const files = ['src/lib/components/Toolbar.svelte', 'src/lib/components/PaneHeader.svelte', PNG, REVIEW];
    const untouched = guiEvidenceProblems({ files, branch: BRANCH, patch, registry: REGISTRY_TEXT });
    expect(untouched).toHaveLength(1);
    expect(untouched[0]).toContain('moved control data-control="pane.split"');
    expect(untouched[0]).toContain('update its registry row');
    // The same move with the control's OWN row changed in the diff (and the
    // row at head) passes; a removed-then-re-added row counts too.
    const ownRow = `${patch}\n${registryRowPatch('pane.split')}`;
    expect(changedRegistryRowIds(ownRow)).toEqual(new Set(['pane.split']));
    expect(guiEvidenceProblems({ files: [...files, REGISTRY], branch: BRANCH, patch: ownRow, registry: REGISTRY_TEXT })).toEqual([]);
    const rewritten = `${patch}\n${patchFor(REGISTRY, [
      '-| `pane.split` | app-toolbar | trailing | 2 | always | none | — |',
      '+| `pane.split` | pane-header | trailing | 2 | always | none | — |',
    ])}`;
    expect(guiEvidenceProblems({ files: [...files, REGISTRY], branch: BRANCH, patch: rewritten, registry: REGISTRY_TEXT })).toEqual([]);
    // An UNRELATED registry edit in the same diff does not satisfy the move.
    const unrelated = guiEvidenceProblems({
      files: [...files, REGISTRY], branch: BRANCH, patch: `${patch}\n${registryRowPatch('pane.other')}`, registry: REGISTRY_TEXT,
    });
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]).toContain('moved control data-control="pane.split"');
    expect(unrelated[0]).toContain(`${REGISTRY} changes in this diff but its row is not among the changed lines`);
    // Prose or a legend line in the registry patch is not a row either.
    expect(changedRegistryRowIds(patchFor(REGISTRY, ['+| `pane.split` | The exact value |', '+some prose about pane.split']))).toEqual(new Set());
    // A row changed in another Markdown file is not the registry.
    expect(changedRegistryRowIds(patchFor('docs/design/other.md', ['+| `pane.split` | pane-header | trailing | 2 | always | none | — |']))).toEqual(new Set());
    // A deleted registry does not count as touched.
    expect(guiEvidenceProblems({
      files: [...files, { path: REGISTRY, status: 'D' }], branch: BRANCH, patch, registry: REGISTRY_TEXT,
    })).toHaveLength(1);
    // Re-added on a second surface without removal: still a placement change.
    const second = guiEvidenceProblems({
      files: ['src/lib/components/Toolbar.svelte', PNG, REVIEW],
      branch: BRANCH,
      patch: patchFor('src/lib/components/Toolbar.svelte', ['+<button data-control="pane.split">']),
      registry: REGISTRY_TEXT,
    });
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('registered control data-control="pane.split" added on a surface where it did not exist');
    // An in-file edit of an existing control is not a placement change.
    expect(guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte', PNG, REVIEW],
      branch: BRANCH,
      patch: patchFor('src/lib/components/PaneHeader.svelte', [
        '-<button data-control="pane.split">',
        '+<IconButton data-control="pane.split" />',
      ]),
      registry: REGISTRY_TEXT,
    })).toEqual([]);
  });

  it('refuses an expression-valued data-control on an added line', () => {
    const patch = patchFor('src/lib/components/Row.svelte', ['+<button data-control={id}>']);
    const problems = guiEvidenceProblems({
      files: ['src/lib/components/Row.svelte', PNG, REVIEW], branch: BRANCH, patch, registry: REGISTRY_TEXT,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('data-control must be a string literal so the registry can be checked');
    expect(problems[0]).toContain('src/lib/components/Row.svelte: data-control={id}');
  });

  it('reports every missing piece at once so one round trip fixes them', () => {
    const problems = guiEvidenceProblems({
      files: ['src/lib/components/PaneHeader.svelte'],
      branch: BRANCH,
      patch: patchFor('src/lib/components/PaneHeader.svelte', [
        '+<button data-control="pane.new">',
        '+<button data-control={dynamic}>',
      ]),
      registry: REGISTRY_TEXT,
    });
    // No PNG, no REVIEW.md, an expression id, an unregistered id.
    expect(problems).toHaveLength(4);
  });

  it('never asks a docs-only diff for evidence', () => {
    expect(guiEvidenceProblems({
      files: ['docs/design/visual-redesign-plan.md', REGISTRY],
      branch: BRANCH,
      patch: '+| data-control="pane.split" | header | …',
    })).toEqual([]);
    expect(guiEvidenceProblems({ files: [], branch: BRANCH })).toEqual([]);
  });

  it('formats the refusal with every problem and the local command', () => {
    const text = formatGuiEvidenceRefusal(BRANCH, ['first', 'second']);
    expect(text).toContain(`refused ${BRANCH} before any reviewer ran`);
    expect(text).toContain('  - first');
    expect(text).toContain('  - second');
    expect(text).toContain('node scripts/review-gate/cli.mjs design-evidence --base origin/main --head HEAD');
  });
});
