import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLedgerEntries,
  formatLedgerResult,
  gateVerdictFor,
  parseExternalComments,
  parseExternalContainers,
  recomputeCounters,
  renderRows,
  reportForHead,
  upsertLedgerSection,
} from '../ledger.mjs';
import { ensureState, writeReport } from '../storage.mjs';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const bot = (id: number, file: string, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  user: { login: 'coderabbitai[bot]' },
  path: file,
  line: 12,
  commit_id: 'abcdef1234567890abcdef1234567890abcdef12',
  html_url: `https://github.com/x/y/pull/1#discussion_r${id}`,
  created_at: `2026-09-02T00:00:0${id % 10}Z`,
  body,
  ...extra,
});

const LEDGER = `# Ledger

## Counters (since the last analysis)

| Since | PRs triaged | Rows | Open |
|---|---|---|---|
| 2026-09-02 (gate 1.8.1) | 1 | 1 | 1 |

## Rows

### #10 — first

| PR | Location | External finding | Real? | Gate saw | Class | Status |
|---|---|---|---|---|---|---|
| #10 | \`a.ts\` | Old | yes | nothing | judgment | open — x |

## Analyses

_None yet._
`;

describe('review gate recall ledger', () => {
  it('parses external reviewer comments only, with title, severity, head and location', () => {
    const entries = parseExternalComments([
      bot(2, 'scripts/review-gate/gate.mjs', '_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_\n\n<details>\n<summary>🔎 Supported by static analysis</summary>\nnoise **not the title**\n</details>\n\n**Do not mark carried P0/P1 blockers as deferrable.**\n\nBody.'),
      bot(1, 'docs\\a.md', '_📐 Maintainability_ | _🟡 Minor_\n\n**Use file-level | attribution.**', { line: null, original_line: 7 }),
      { ...bot(3, 'x.ts', '**Human comment**'), user: { login: 'someone' } },
      bot(4, 'y.ts', 'No bold title here\nsecond line'),
      bot(5, 'z.ts', '**A reply in a thread**', { in_reply_to_id: 2 }),
      bot(6, 'w.ts', '<details>\n<summary>🔎 Supported by static analysis</summary>\n\nsed -n **__tests__** x\n</details>\n\n**Preserve the complete key.** `assertString()` allows long values.'),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual([1, 2, 4, 6]);
    expect(entries[3].title).toBe('Preserve the complete key.');
    expect(entries[1]).toMatchObject({ file: 'scripts/review-gate/gate.mjs', line: 12, severity: 'major', title: 'Do not mark carried P0/P1 blockers as deferrable.' });
    expect(entries[0]).toMatchObject({ file: 'docs/a.md', line: 7, severity: 'minor', title: 'Use file-level / attribution.' });
    expect(entries[2]).toMatchObject({ severity: 'unrated', title: 'No bold title here' });
  });

  it('turns review bodies and issue comments that announce out-of-diff findings into container rows', () => {
    const review = (id: number, body: string, login = 'coderabbitai[bot]') => ({ id, user: { login }, body, commit_id: 'c'.repeat(40), submitted_at: `2026-09-02T01:00:0${id}Z`, html_url: `https://x/r${id}` });
    const entries = parseExternalContainers(
      [
        review(1, '**Actionable comments posted: 2**\n<details>\n<summary>⚠️ Outside diff range comments (2)</summary>\nstuff\n</details>'),
        review(2, '**Actionable comments posted: 0**\n<details>\n<summary>🧹 Nitpick comments (1)</summary>\n</details>'),
        review(3, '<details><summary>Outside diff range comments (1)</summary></details>', 'someone'),
        review(4, '<details><summary><strong>Additional comments</strong> outside diff (2)</summary></details>'),
      ],
      [{ id: 9, user: { login: 'coderabbitai[bot]' }, body: '<details><summary>Additional comments not posted (3)</summary></details>', created_at: '2026-09-02T02:00:00Z' }],
    );
    expect(entries.map((entry) => entry.id)).toEqual(['review-1', 'review-2', 'review-4', 'issue-9']);
    expect(entries[2].title).toBe('Additional comments outside diff (2)');
    expect(entries[1].title).toBe('🧹 Nitpick comments (1)');
    expect(entries[0]).toMatchObject({ file: '(review 1)', severity: 'container', title: '⚠️ Outside diff range comments (2)' });
    const rows = renderRows(3, entries.map((entry) => ({ ...entry, verdict: { saw: 'container', matches: [] } })));
    expect(rows[0]).toContain('<!-- ext:review-1 -->');
    expect(upsertLedgerSection(upsertLedgerSection(LEDGER, 3, 'h', rows).markdown, 3, 'h', rows).added).toBe(0);
  });

  it('reports what the retained report says about the file, strongest verdict first', () => {
    const report = {
      findings: [
        { file: 'a.ts', title: 'Blocked', priority: 'P2', enforcement: 'blocking', disposition: 'verified' },
        { file: 'a.ts', title: 'Advisory', priority: 'P3', enforcement: 'advisory', disposition: 'verified' },
        { file: 'b.ts', title: 'Gone', priority: 'P2', enforcement: 'advisory', disposition: 'dismissed' },
        { file: 'c.ts', title: 'Later', priority: 'P2', enforcement: 'advisory', disposition: 'verified', deferral: { headSha: 'x', reason: 'r' } },
      ],
    };
    expect(gateVerdictFor(report, { file: 'a.ts' })).toMatchObject({ saw: 'blocker' });
    expect(gateVerdictFor(report, { file: 'a.ts' }).matches.map((match) => match.saw)).toEqual(['blocker', 'advisory']);
    expect(gateVerdictFor(report, { file: 'b.ts' }).saw).toBe('dismissed');
    expect(gateVerdictFor(report, { file: 'c.ts' }).saw).toBe('deferred');
    expect(gateVerdictFor(report, { file: 'd.ts' })).toEqual({ saw: 'nothing', matches: [] });
    expect(gateVerdictFor(null, { file: 'a.ts' }).saw).toBe('nothing');
  });

  it('renders rows with TODO cells, a blocker hint, and an idempotent marker', () => {
    const rows = renderRows(7, [
      { id: 5, file: 'a.ts', line: 3, title: 'T', severity: 'major', verdict: { saw: 'nothing', matches: [] } },
      { id: 6, file: 'a.ts', line: null, title: 'U', severity: 'minor', verdict: { saw: 'blocker', matches: [{ title: 'Same', priority: 'P2', saw: 'blocker' }] } },
      { id: 8, file: 'z.ts', line: 1, title: 'V', severity: 'minor', verdict: null },
    ]);
    expect(rows[0]).toBe('| #7 | `a.ts:3` | T (major) | TODO | nothing | TODO | open — TODO: what was corrected; which mechanism would catch the class <!-- ext:5 --> |');
    expect(rows[1]).toContain('gate findings in the file: P2 "Same" (blocker)');
    expect(rows[1]).toContain('same issue as the blocker? then delete this row');
    expect(rows[2]).toContain('no retained report for that head');
  });

  it('upserts a PR section before the analyses, never duplicating a marked row, and recounts', () => {
    const rows = renderRows(11, [{ id: 21, file: 'a.ts', line: 1, title: 'New', severity: 'major', verdict: { saw: 'nothing', matches: [] } }]);
    const first = upsertLedgerSection(LEDGER, 11, 'gate 1.8.1', rows);
    expect(first.added).toBe(1);
    expect(first.markdown.indexOf('### #11 — gate 1.8.1')).toBeGreaterThan(first.markdown.indexOf('### #10'));
    expect(first.markdown.indexOf('### #11')).toBeLessThan(first.markdown.indexOf('## Analyses'));
    // Same rows again: nothing added; a new row for the same PR lands in its section.
    expect(upsertLedgerSection(first.markdown, 11, 'gate 1.8.1', rows).added).toBe(0);
    const more = renderRows(11, [{ id: 22, file: 'b.ts', line: 2, title: 'More', severity: 'minor', verdict: { saw: 'nothing', matches: [] } }]);
    const second = upsertLedgerSection(first.markdown, 11, 'gate 1.8.1', more);
    expect(second.added).toBe(1);
    expect((second.markdown.match(/### #11/g) || []).length).toBe(1);
    expect(second.markdown.indexOf('ext:22')).toBeGreaterThan(second.markdown.indexOf('ext:21'));
    expect(second.markdown.indexOf('ext:22')).toBeLessThan(second.markdown.indexOf('## Analyses'));
    // A filename quoting a marker cannot impersonate the row's own marker.
    const spoof = renderRows(11, [{ id: 23, file: 'weird<!-- ext:22 -->.ts', line: 1, title: 'Spoof', severity: 'minor', verdict: { saw: 'nothing', matches: [] } }]);
    expect(upsertLedgerSection(second.markdown, 11, 'gate 1.8.1', spoof).added).toBe(1);
    // An archived section (below "## Analyses") does not absorb a late finding.
    const archived = LEDGER.replace('## Analyses\n', '## Analyses\n\n### #12 — archived\n\n| PR |\n|---|\n| #12 | old <!-- ext:90 --> |\n');
    const late = upsertLedgerSection(archived, 12, 'late', renderRows(12, [{ id: 91, file: 'x.ts', line: 1, title: 'Late', severity: 'minor', verdict: null }]));
    expect(late.added).toBe(1);
    expect(late.markdown.indexOf('ext:91')).toBeLessThan(late.markdown.indexOf('## Analyses'));
    // A row quoting "### #11" is not the section heading.
    const quoted = first.markdown.replace('| #10 | `a.ts` | Old |', '| #10 | `a.ts` | Old mentions ### #11 here |');
    const third = upsertLedgerSection(quoted, 11, 'gate 1.8.1', more);
    expect(third.markdown.indexOf('ext:22')).toBeGreaterThan(third.markdown.indexOf('### #11 — gate 1.8.1'));
    const counted = recomputeCounters(second.markdown);
    expect(counted).toMatchObject({ prs: 2, rows: 3, open: 3 });
    expect(counted.markdown).toContain('| 2026-09-02 (gate 1.8.1) | 2 | 3 | 3 |');
    // A row whose status is not open is not counted as open.
    const closed = counted.markdown.replace('| open — x |', '| fixed 1.9.0 (lane) |');
    expect(recomputeCounters(closed)).toMatchObject({ rows: 3, open: 2 });
  });

  it('builds entries from gh comments and the retained report of each head, and writes the ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rove-ledger-'));
    temporary.push(dir);
    const paths = await ensureState(path.join(dir, 'state'));
    const headSha = 'abcdef1234567890abcdef1234567890abcdef12';
    await writeReport(paths, {
      createdAt: '2026-09-02T00:00:00.000Z',
      identity: { headSha, baseSha: 'b'.repeat(40) },
      findings: [{ file: 'scripts/review-gate/gate.mjs', title: 'Seen', priority: 'P3', enforcement: 'advisory', disposition: 'verified' }],
    });
    expect((await reportForHead(paths, headSha.slice(0, 12)))?.findings).toHaveLength(1);
    expect(await reportForHead(paths, 'ffff')).toBeNull();
    // A forced rerun after the reviewer commented does not rewrite what the
    // gate had seen: the report at or before the comment's time wins.
    await writeReport(paths, { createdAt: '2026-09-03T00:00:00.000Z', identity: { headSha, baseSha: 'b'.repeat(40) }, findings: [] });
    expect((await reportForHead(paths, headSha, { before: '2026-09-02T00:00:05Z' }))?.findings).toHaveLength(1);
    expect((await reportForHead(paths, headSha))?.findings).toHaveLength(0);
    expect(await reportForHead(paths, headSha, { before: '2026-09-01T00:00:00Z' })).toBeNull();
    // A run started before the comment but completed after it does not count.
    await writeReport(paths, {
      createdAt: '2026-09-02T00:00:01.000Z',
      identity: { headSha, baseSha: 'b'.repeat(40) },
      stages: [{ name: 'shards', startedAt: '2026-09-02T00:00:01.000Z', ms: 10 * 60 * 1000 }],
      findings: [{ file: 'late.ts', title: 'Late', priority: 'P2', enforcement: 'blocking', disposition: 'verified' }],
    });
    expect((await reportForHead(paths, headSha, { before: '2026-09-02T00:00:05Z' }))?.findings[0].title).toBe('Seen');
    // Overlapping runs: the one that COMPLETED last is the verdict, even if it started earlier.
    await writeReport(paths, {
      createdAt: '2026-09-01T23:00:00.000Z',
      identity: { headSha, baseSha: 'b'.repeat(40) },
      stages: [{ name: 'shards', startedAt: '2026-09-01T23:00:00.000Z', ms: 65 * 60 * 1000 }],
      findings: [{ file: 'slow.ts', title: 'Slow but last', priority: 'P2', enforcement: 'blocking', disposition: 'verified' }],
    });
    expect((await reportForHead(paths, headSha, { before: '2026-09-02T00:06:00Z' }))?.findings[0].title).toBe('Slow but last');
    const ledgerPath = path.join(dir, 'ledger.md');
    await writeFile(ledgerPath, LEDGER, 'utf8');
    const calls: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1].includes('/reviews')) {
        return { stdout: `${JSON.stringify({ id: 77, user: { login: 'coderabbitai[bot]' }, body: '<details><summary>Outside diff range comments (1)</summary></details>', commit_id: headSha, submitted_at: '2026-09-02T00:00:09Z' })}\n`, stderr: '', code: 0 };
      }
      if (args[1].includes('/issues/')) return { stdout: '', stderr: '', code: 0 };
      return {
        stdout: `${JSON.stringify(bot(31, 'scripts/review-gate/gate.mjs', '_🟠 Major_\n\n**Seen by the gate.**'))}\n${JSON.stringify(bot(32, 'docs/x.md', '**Missed ][ here.**'))}\n`,
        stderr: '',
        code: 0,
      };
    };
    const result = await buildLedgerEntries({ repoRoot: process.cwd(), pr: 12, stateRoot: paths.root, run, write: true, heading: 'gate 1.8.1', ledgerPath, branchOf: async () => 'claude/a' });
    expect(calls.map((args) => args[1])).toEqual(['repos/{owner}/{repo}/pulls/12/comments', 'repos/{owner}/{repo}/pulls/12/reviews', 'repos/{owner}/{repo}/issues/12/comments']);
    expect(result.entries.map((entry) => entry.gateSaw)).toEqual(['advisory', 'nothing', 'container: record each finding it holds as its own row']);
    expect(result.written).toMatchObject({ added: 3, prs: 2, rows: 4, open: 4 });
    const written = await readFile(ledgerPath, 'utf8');
    expect(written).toContain('### #12 — gate 1.8.1');
    expect(written).toContain('<!-- ext:31 -->');
    expect(written).toContain('<!-- ext:review-77 -->');
    expect(written).toContain('| 2026-09-02 (gate 1.8.1) | 2 | 4 | 4 |');
    const again = await buildLedgerEntries({ repoRoot: process.cwd(), pr: 12, stateRoot: paths.root, run, write: true, ledgerPath, branchOf: async () => 'claude/a' });
    expect(again.written?.added).toBe(0);
    expect(await readFile(ledgerPath, 'utf8')).toBe(written);
    expect(formatLedgerResult(result)).toContain('gate saw: advisory');
    expect(formatLedgerResult(result)).toContain('Wrote 3 new row(s)');
    // A branch switched while the GitHub reads ran refuses the write.
    let calls2 = 0;
    await expect(buildLedgerEntries({
      repoRoot: process.cwd(), pr: 12, stateRoot: paths.root, run, write: true, ledgerPath,
      branchOf: async () => (calls2++ === 0 ? 'claude/a' : 'claude/b'),
    })).rejects.toThrow(/switched from claude\/a to claude\/b/);
    for (const bad of ['x', '123abc', '1e2', '12.5', '0', '-4', '']) {
      await expect(buildLedgerEntries({ pr: bad, run })).rejects.toThrow(/--pr/);
    }
    // A heading is one line whatever is passed.
    const injected = upsertLedgerSection(LEDGER, 13, 'x\n## Analyses\ny', renderRows(13, [{ id: 41, file: 'q.ts', line: 1, title: 'Q', severity: 'minor', verdict: null }]));
    expect(injected.markdown).toContain('### #13 — x ## Analyses y');
    expect(recomputeCounters(injected.markdown)).toMatchObject({ prs: 2, rows: 2 });
  });
});
