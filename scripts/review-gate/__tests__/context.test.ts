import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createContextBundle,
  readOpenBugBriefs,
  reviewPolicySnapshot,
  selectReviewLessons,
} from '../context.mjs';
import { recoverStaleReviewResources } from '../git.mjs';

describe('review context ownership', () => {
  it('inlines only path-relevant lessons plus a short index', () => {
    const lessons = `# Lessons

## 1. Auto-opened surfaces need an end-of-life rule

This is about job panels.

## 2. Compact history stays behind one link

This is about FileView.svelte.

## 3. The canvas must never move by itself

Unrelated canvas rule.
`;
    const selected = selectReviewLessons(lessons, ['src/lib/components/files/FileView.svelte']);
    expect(selected).toContain('## Index');
    expect(selected).toContain('2. Compact history stays behind one link');
    expect(selected).toContain('This is about FileView.svelte.');
    expect(selected).not.toContain('This is about job panels.');
    expect(selected).not.toContain('Unrelated canvas rule.');
  });

  it('indexes every open bug brief and inlines only path-matched ones', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'rove-open-briefs-test-'));
    try {
      const briefsDir = path.join(checkout, 'docs', 'bugs', 'open');
      await mkdir(briefsDir, { recursive: true });
      await writeFile(path.join(briefsDir, 'aa-unrelated.md'), '# Elsewhere\n\nAbout some other surface.\n');
      await writeFile(path.join(briefsDir, 'zz-id-collision.md'), '# IDs collide\n\nAbout commandRegistry.ts identifiers.\n');
      const briefs = await readOpenBugBriefs(checkout, ['src/lib/commands/commandRegistry.ts']);
      expect(briefs).toContain('- zz-id-collision.md');
      expect(briefs).toContain('- aa-unrelated.md');
      expect(briefs).toContain('About commandRegistry.ts identifiers.');
      expect(briefs).not.toContain('About some other surface.');
      // Content matching scans past the index cap: with the index capped to
      // the first (non-matching) file, the alphabetically-later matching
      // brief is still inlined.
      const capped = await readOpenBugBriefs(checkout, ['src/lib/commands/commandRegistry.ts'], { maxIndexed: 1 });
      expect(capped).not.toContain('- zz-id-collision.md');
      expect(capped).toContain('About commandRegistry.ts identifiers.');
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it('never matches a brief through a generic parent-directory word', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'rove-open-briefs-generic-'));
    try {
      const briefsDir = path.join(checkout, 'docs', 'bugs', 'open');
      await mkdir(briefsDir, { recursive: true });
      // Every brief carries "Status: open"; a changed file under
      // docs/bugs/open must not inline unrelated briefs through the "open"
      // needle, and the changed brief itself travels in the patch, so it
      // must not consume the inline budget either. An UNCHANGED brief that
      // references the changed one still inlines.
      await writeFile(path.join(briefsDir, 'aa-filler.md'), '# Filler\n\n**Status:** open. Nothing about the change.\n');
      await writeFile(path.join(briefsDir, 'new-brief.md'), '# New brief\n\n**Status:** open. The changed brief body mentions new-brief.md.\n');
      await writeFile(path.join(briefsDir, 'ref-brief.md'), '# Referencing brief\n\n**Status:** open. See new-brief.md for the sibling defect.\n');
      const briefs = await readOpenBugBriefs(checkout, ['docs/bugs/open/new-brief.md']);
      expect(briefs).not.toContain('Nothing about the change.');
      expect(briefs).toContain('See new-brief.md for the sibling defect.');
      // The changed brief may inline too — but only AFTER unchanged matches:
      // with the budget capped to one slot, the unchanged referencing brief
      // wins even though the changed brief sorts alphabetically first.
      const capped = await readOpenBugBriefs(checkout, ['docs/bugs/open/new-brief.md'], { maxInlined: 1 });
      expect(capped).toContain('See new-brief.md for the sibling defect.');
      expect(capped).not.toContain('The changed brief body');
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it('matches a generic basename through its parent-qualified needle', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'rove-open-briefs-qualified-'));
    try {
      const briefsDir = path.join(checkout, 'docs', 'bugs', 'open');
      await mkdir(briefsDir, { recursive: true });
      await writeFile(path.join(briefsDir, 'mesh-login.md'), '# Mesh login\n\nAbout `sidecar/rove-mesh/main.go` re-arming.\n');
      await writeFile(path.join(briefsDir, 'other.md'), '# Other\n\nUnrelated surface.\n');
      // main.go alone is too generic to be a needle, but the brief names the
      // qualified path, so a change to that file must still attach it.
      const briefs = await readOpenBugBriefs(checkout, ['sidecar/rove-mesh/main.go']);
      expect(briefs).toContain('re-arming');
      expect(briefs).not.toContain('Unrelated surface.');
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it('announces briefs left outside the bounded scan instead of implying no match', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'rove-open-briefs-many-'));
    try {
      const briefsDir = path.join(checkout, 'docs', 'bugs', 'open');
      await mkdir(briefsDir, { recursive: true });
      await Promise.all(Array.from({ length: 205 }, (_, index) =>
        writeFile(
          path.join(briefsDir, `brief-${String(index).padStart(3, '0')}.md`),
          '# Filler\n\nNothing relevant.\n',
        )));
      const briefs = await readOpenBugBriefs(checkout, ['src/lib/example.ts']);
      expect(briefs).toContain('5 brief(s) beyond the bounded 200-file scan were NOT searched');
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it('reports an absent open-briefs directory instead of failing the bundle', async () => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), 'rove-open-briefs-none-'));
    try {
      await expect(readOpenBugBriefs(checkout, ['src/lib/example.ts'])).resolves.toContain('absent from this checkout');
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  it('rejects an installed policy snapshot with an unknown schema', () => {
    expect(() => reviewPolicySnapshot({
      schemaVersion: 2,
      charter: '# Charter\n',
      lessons: '# Lessons\n',
    })).toThrow('schema version 2 is unsupported');
  });

  it('removes its temporary directory when no trusted policy snapshot is supplied', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-context-test-'));
    try {
      await expect(createContextBundle({
        checkout: temporaryRoot,
        policyRoot: path.join(temporaryRoot, 'missing-policy'),
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        branch: 'codex/test',
        author: 'codex',
        risk: 'high',
        riskReasons: ['test'],
        files: ['src/example.ts'],
        stats: { additions: 1, deletions: 0 },
        patch: '+change',
        temporaryRoot,
      })).rejects.toThrow('trusted installed review policy snapshot is required');
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });


  it('marks and recovers a context bundle left by a dead owner', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-context-test-'));
    try {
      execFileSync('git', ['-C', temporaryRoot, 'init', '-b', 'main']);
      execFileSync('git', ['-C', temporaryRoot, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', temporaryRoot, 'config', 'user.name', 'Test']);
      await writeFile(path.join(temporaryRoot, 'src-example.ts'), 'export const value = 1;\n');
      execFileSync('git', ['-C', temporaryRoot, 'add', '.']);
      execFileSync('git', ['-C', temporaryRoot, 'commit', '-m', 'base context']);
      const headSha = execFileSync('git', ['-C', temporaryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const bundle = await createContextBundle({
        checkout: temporaryRoot,
        policyRoot: temporaryRoot,
        policy: { charter: '# Charter\n', lessons: '# Lessons\n' },
        baseSha: headSha,
        headSha,
        branch: 'codex/test',
        author: 'codex',
        risk: 'high',
        riskReasons: ['test'],
        files: ['src-example.ts'],
        stats: { additions: 1, deletions: 0 },
        patch: '+change',
        temporaryRoot,
      });
      await expect(access(path.join(bundle.directory, 'change.diff'))).resolves.toBeUndefined();
      await expect(access(path.join(bundle.directory, 'git-history.md'))).resolves.toBeUndefined();
      // v1.6.0 evidence files exist even when their generators were skipped,
      // so a reviewer prompt can always reference them; the follow-up diff is
      // written only when a real incremental patch was supplied.
      await expect(access(path.join(bundle.directory, 'reference-map.md'))).resolves.toBeUndefined();
      await expect(access(path.join(bundle.directory, 'open-bug-briefs.md'))).resolves.toBeUndefined();
      await expect(access(path.join(bundle.directory, 'follow-up.diff'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await recoverStaleReviewResources(temporaryRoot, {
        temporaryRoot,
        isAlive: () => false,
      })).toBe(1);
      await expect(access(bundle.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('carries the incremental follow-up patch and focus note when supplied', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'rove-review-context-followup-'));
    try {
      execFileSync('git', ['-C', temporaryRoot, 'init', '-b', 'main']);
      execFileSync('git', ['-C', temporaryRoot, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', temporaryRoot, 'config', 'user.name', 'Test']);
      await writeFile(path.join(temporaryRoot, 'src-example.ts'), 'export const value = 1;\n');
      execFileSync('git', ['-C', temporaryRoot, 'add', '.']);
      execFileSync('git', ['-C', temporaryRoot, 'commit', '-m', 'base context']);
      const headSha = execFileSync('git', ['-C', temporaryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const bundle = await createContextBundle({
        checkout: temporaryRoot,
        policyRoot: temporaryRoot,
        policy: { charter: '# Charter\n', lessons: '# Lessons\n' },
        baseSha: headSha,
        headSha,
        branch: 'codex/test',
        author: 'codex',
        risk: 'medium',
        riskReasons: ['test'],
        files: ['src-example.ts'],
        stats: { additions: 1, deletions: 0 },
        patch: '+change',
        referenceMap: '# Reference map\n\ncontent\n',
        openBriefs: '# Open bug briefs\n\ncontent\n',
        followUpPatch: '+incremental change',
        followUpBaseSha: 'f'.repeat(40),
        temporaryRoot,
      });
      try {
        const followUp = await readFile(path.join(bundle.directory, 'follow-up.diff'), 'utf8');
        expect(followUp).toBe('+incremental change');
        const context = await readFile(path.join(bundle.directory, 'review-context.md'), 'utf8');
        expect(context).toContain('## Follow-up focus');
        expect(context).toContain('f'.repeat(40));
        expect(context).toContain('reference-map.md');
      } finally {
        await bundle.cleanup();
      }

      // An EMPTY incremental diff (empty commit after an attested head) still
      // gets its focus artifact and note — the cheap plan's justification.
      const emptyBundle = await createContextBundle({
        checkout: temporaryRoot,
        policyRoot: temporaryRoot,
        policy: { charter: '# Charter\n', lessons: '# Lessons\n' },
        baseSha: headSha,
        headSha,
        branch: 'codex/test',
        author: 'codex',
        risk: 'medium',
        riskReasons: ['test'],
        files: ['src-example.ts'],
        stats: { additions: 0, deletions: 0 },
        patch: '+change',
        followUpPatch: '',
        followUpBaseSha: 'f'.repeat(40),
        temporaryRoot,
      });
      try {
        const emptyFollowUp = await readFile(path.join(emptyBundle.directory, 'follow-up.diff'), 'utf8');
        expect(emptyFollowUp).toContain('incremental diff since the attested pass head is empty');
        const context = await readFile(path.join(emptyBundle.directory, 'review-context.md'), 'utf8');
        expect(context).toContain('## Follow-up focus');
      } finally {
        await emptyBundle.cleanup();
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
