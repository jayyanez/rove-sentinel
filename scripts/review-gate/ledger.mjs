import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createGateContext } from './gate.mjs';
import { currentBranch } from './git.mjs';
import { runProcess } from './process.mjs';
import { readJson } from './storage.mjs';

// The recall ledger companion (`npx --no-install rove-sentinel ledger`). It is NOT part of the
// review: it reads the retained local reports and the PR's external review
// comments, and pre-fills rows of docs/review-gate-recall-ledger.md so that
// recording what the gate missed costs a minute instead of a transcript
// search. It never changes a verdict, an attestation, or the hook, which is
// why it carries no gate version of its own.

export const LEDGER_PATH = 'docs/review-gate-recall-ledger.md';
export const EXTERNAL_REVIEWERS = ['coderabbitai[bot]'];
const ROWS_HEADING = '## Rows';
const ANALYSES_HEADING = '## Analyses';
// The marker is the row's LAST cell content, so a filename that quotes one
// cannot impersonate it.
const MARKER = /<!-- ext:([a-z]*-?\d+) --> \|\s*$/;

const SEVERITY = [
  [/Critical/i, 'critical'],
  [/Major/i, 'major'],
  [/Minor/i, 'minor'],
  [/Trivial|Nitpick/i, 'trivial'],
];

function stripHtml(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * External reviewer comments (GitHub `pulls/N/comments` rows) → one entry
 * each: the head they were made on, the file, the bold title line the bot
 * leads with, and its severity tag. Other authors' comments are ignored.
 */
export function parseExternalComments(comments, { reviewers = EXTERNAL_REVIEWERS } = {}) {
  const entries = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const login = comment?.user?.login;
    if (!reviewers.includes(login)) continue;
    // A reply inside a thread is conversation, not a finding.
    if (comment.in_reply_to_id) continue;
    const body = String(comment.body || '');
    const visible = stripHtml(body);
    const titleMatch = visible.match(/^\*\*(.+?)\*\*/m);
    const firstLine = visible.split('\n').map((line) => line.trim()).find(Boolean) || '';
    const tagLine = body.split('\n').find((line) => /^_.*_\s*(\|.*)?$/.test(line.trim())) || '';
    const severity = (SEVERITY.find(([pattern]) => pattern.test(tagLine)) || [null, 'unrated'])[1];
    entries.push({
      id: Number(comment.id),
      reviewer: login,
      headSha: String(comment.commit_id || ''),
      file: String(comment.path || '').replace(/\\/g, '/'),
      line: Number.isInteger(comment.line) ? comment.line : (Number.isInteger(comment.original_line) ? comment.original_line : null),
      title: (titleMatch ? titleMatch[1] : firstLine).replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 200),
      severity,
      url: String(comment.html_url || ''),
      createdAt: String(comment.created_at || ''),
    });
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
}

/**
 * Findings an external reviewer parks OUTSIDE inline comments: a review body
 * or an issue comment whose collapsible sections announce out-of-diff
 * findings. One entry per such section, keyed by surface and id, so the
 * author records the findings it holds; the row points at the container.
 */
export function parseExternalContainers(reviews, issueComments, { reviewers = EXTERNAL_REVIEWERS } = {}) {
  const entries = [];
  const scan = (items, surface) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!reviewers.includes(item?.user?.login)) continue;
      const body = String(item.body || '');
      const summaries = [...body.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
        .map((match) => match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
        .filter((summary) => /outside (?:the )?diff|out-of-diff|additional comments|nitpick/i.test(summary));
      if (!summaries.length) continue;
      entries.push({
        id: `${surface}-${item.id}`,
        reviewer: item.user.login,
        headSha: String(item.commit_id || ''),
        file: `(${surface} ${item.id})`,
        line: null,
        title: summaries.join('; ').replace(/\|/g, '/').slice(0, 200),
        severity: 'container',
        url: String(item.html_url || ''),
        createdAt: String(item.submitted_at || item.created_at || ''),
      });
    }
  };
  scan(reviews, 'review');
  scan(issueComments, 'issue');
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const SAW_RANK = { blocker: 4, deferred: 3, advisory: 2, dismissed: 1, nothing: 0 };

function sawOf(finding) {
  if (finding.disposition === 'dismissed') return 'dismissed';
  if (finding.deferral) return 'deferred';
  if (finding.enforcement === 'blocking') return 'blocker';
  return 'advisory';
}

/**
 * What the retained report of the head the comment was made on says about
 * that FILE. Matching by file is the pre-fill, not the rule: the ledger
 * matches by issue, so every gate finding in the file is listed with its
 * verdict and the author decides whether one of them is the same issue.
 */
export function gateVerdictFor(report, entry) {
  const file = String(entry.file || '');
  const matches = (report?.findings || [])
    .filter((finding) => String(finding.file || '').replace(/\\/g, '/') === file)
    .map((finding) => ({ title: String(finding.title || ''), priority: finding.priority, saw: sawOf(finding), line: finding.line ?? null }));
  const saw = matches.reduce((best, match) => (SAW_RANK[match.saw] > SAW_RANK[best] ? match.saw : best), 'nothing');
  return { saw, matches };
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

/** One ledger row per entry; cells the author must decide stay `TODO`. */
export function renderRows(pr, entries) {
  return entries.map((entry) => {
    const where = entry.line ? `${entry.file}:${entry.line}` : entry.file;
    const verdict = entry.verdict || { saw: 'no retained report for that head at or before the comment', matches: [] };
    const sawText = verdict.matches.length
      ? `${verdict.saw} — gate findings in the file: ${verdict.matches.map((match) => `${match.priority} "${cell(match.title)}" (${match.saw})`).join('; ')}`
      : verdict.saw;
    const status = verdict.saw === 'blocker'
      ? 'TODO — same issue as the blocker? then delete this row (no miss)'
      : 'open — TODO: what was corrected; which mechanism would catch the class';
    return `| #${pr} | \`${cell(where)}\` | ${cell(entry.title)} (${entry.severity}) | TODO | ${cell(sawText)} | TODO | ${status} <!-- ext:${entry.id} --> |`;
  });
}

/**
 * Insert or extend the `### #<pr>` section under "## Rows" (before
 * "## Analyses"). Rows already present (by external comment id marker) are
 * not duplicated, so the command is idempotent across re-runs.
 */
export function upsertLedgerSection(markdown, pr, heading, rows) {
  const text = String(markdown);
  const present = new Set([...text.matchAll(/<!-- ext:([a-z]*-?\d+) --> \|[ \t]*$/gm)].map((match) => match[1]));
  const fresh = rows.filter((row) => {
    const match = row.match(MARKER);
    return !(match && present.has(match[1]));
  });
  if (!fresh.length) return { markdown: text, added: 0 };
  const sectionTitle = `### #${pr}`;
  // A heading, at line start — a row's text may quote the same characters —
  // and only in the active region: an analysed PR section moved below
  // "## Analyses" is archived, so a late finding opens a new active section.
  const activeEnd = text.search(new RegExp(`^${ANALYSES_HEADING}`, 'm'));
  const activeText = activeEnd < 0 ? text : text.slice(0, activeEnd);
  const sectionIndex = activeText.search(new RegExp(`^${sectionTitle}(?: |$)`, 'm'));
  if (sectionIndex >= 0) {
    // Append after the section's table (the last table row before the next heading or EOF).
    const rest = text.slice(sectionIndex);
    const titleEnd = rest.indexOf('\n') < 0 ? rest.length : rest.indexOf('\n') + 1;
    const nextHeading = rest.slice(titleEnd).search(/^#{2,3} /m);
    const sectionEnd = nextHeading < 0 ? text.length : sectionIndex + titleEnd + nextHeading;
    const section = text.slice(sectionIndex, sectionEnd).replace(/\s+$/, '');
    const updated = `${section}\n${fresh.join('\n')}\n\n`;
    return { markdown: text.slice(0, sectionIndex) + updated + text.slice(sectionEnd), added: fresh.length };
  }
  const header = [
    `${sectionTitle} — ${String(heading || '').replace(/\s+/g, ' ').trim() || 'triaged'}`,
    '',
    '| PR | Location | External finding | Real? | Gate saw | Class | Status |',
    '|---|---|---|---|---|---|---|',
    ...fresh,
    '',
    '',
  ].join('\n');
  const analysesIndex = text.search(new RegExp(`^${ANALYSES_HEADING}`, 'm'));
  if (analysesIndex < 0) return { markdown: `${text.replace(/\s+$/, '')}\n\n${header}`, added: fresh.length };
  return { markdown: `${text.slice(0, analysesIndex)}${header}${text.slice(analysesIndex)}`, added: fresh.length };
}

/** The counters table recomputed from the rows: PR sections, rows, open rows. */
export function recomputeCounters(markdown) {
  const text = String(markdown);
  // Headings count only at line start: a section title may quote them.
  const rowsStart = text.search(new RegExp(`^${ROWS_HEADING}`, 'm'));
  const analysesStart = text.search(new RegExp(`^${ANALYSES_HEADING}`, 'm'));
  const body = text.slice(rowsStart < 0 ? 0 : rowsStart, analysesStart < 0 ? undefined : analysesStart);
  const sections = (body.match(/^### #\d+/gm) || []).length;
  const rows = body.split('\n').filter((line) => /^\| #\d+ \|/.test(line));
  const open = rows.filter((line) => {
    const cells = line.split('|').map((part) => part.trim());
    return /^open\b/i.test(cells[7] || '');
  }).length;
  const updated = text.replace(
    /^(\| )([^|\n]+)( \| )\d+( \| )\d+( \| )\d+( \|)$/m,
    (whole, a, since, b, c, d, e) => `${a}${since}${b}${sections}${c}${rows.length}${d}${open}${e}`,
  );
  return { markdown: updated, prs: sections, rows: rows.length, open };
}

async function ghJson(repoRoot, args, { run }) {
  const result = await run('gh', args, { cwd: repoRoot, timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024 });
  // One compact JSON object per line (`--jq '.[]'` under --paginate), so a
  // page boundary can never fall inside a comment body.
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function fetchExternalComments(repoRoot, pr, { run = runProcess } = {}) {
  return await ghJson(repoRoot, ['api', `repos/{owner}/{repo}/pulls/${pr}/comments`, '--paginate', '--jq', '.[]'], { run });
}

export async function fetchExternalContainers(repoRoot, pr, { run = runProcess } = {}) {
  const reviews = await ghJson(repoRoot, ['api', `repos/{owner}/{repo}/pulls/${pr}/reviews`, '--paginate', '--jq', '.[]'], { run });
  const issueComments = await ghJson(repoRoot, ['api', `repos/{owner}/{repo}/issues/${pr}/comments`, '--paginate', '--jq', '.[]'], { run });
  return { reviews, issueComments };
}

/**
 * The retained report whose identity head starts with `headSha`: the newest
 * one created at or before `before` (the external comment's time), so a
 * later forced rerun can never rewrite what the gate had seen when the
 * reviewer commented; null when none predates the comment.
 */
export async function reportForHead(paths, headSha, { before = null } = {}) {
  let entries;
  try {
    entries = await readdir(paths.reports, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const prefix = String(headSha || '');
  if (!prefix) return null;
  const limit = before ? Date.parse(before) : NaN;
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const value = await readJson(path.join(paths.reports, entry.name));
    if (!value || !String(value.identity?.headSha || '').startsWith(prefix)) continue;
    // A report counts when it was COMPLETE before the comment: createdAt is
    // set when the run starts, the last stage's end is when its findings
    // existed.
    const completed = reportCompletedAt(value);
    if (Number.isFinite(limit) && (!Number.isFinite(completed) || completed > limit)) continue;
    // The latest COMPLETED report wins (two overlapping runs can finish in
    // the other order); creation time only breaks a tie.
    const bestCompleted = best ? reportCompletedAt(best) : -Infinity;
    if (!best || completed > bestCompleted || (completed === bestCompleted && String(value.createdAt) > String(best.createdAt))) best = value;
  }
  return best;
}

export function reportCompletedAt(report) {
  let end = Date.parse(report?.createdAt);
  for (const stage of Array.isArray(report?.stages) ? report.stages : []) {
    const stageEnd = Date.parse(stage?.startedAt) + (Number(stage?.ms) || 0);
    if (Number.isFinite(stageEnd) && stageEnd > end) end = stageEnd;
  }
  return end;
}

// Replace the ledger through a temporary file and a rename, never by
// truncating the destination in place.
async function atomicWriteText(target, text) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, target);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch (cleanupError) {
      // The write failure is the error worth reporting; the cleanup failure
      // travels with it for diagnosis.
      if (error && typeof error === 'object') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

/**
 * Pre-fill ledger rows for one PR: every external reviewer comment, with what
 * the retained local report of that head says about the file. With `write`,
 * the rows are upserted into the ledger and the counters recomputed.
 */
export async function buildLedgerEntries({
  repoRoot = process.cwd(), pr, stateRoot, run = runProcess, write = false, heading, ledgerPath, reviewers, branchOf = currentBranch,
}) {
  const text = String(pr ?? '').trim();
  if (!/^[1-9]\d{0,8}$/.test(text)) throw new Error('--pr must be a pull request number.');
  const number = Number(text);
  const context = await createGateContext(repoRoot, { stateRoot });
  // The checkout that is written must be the checkout the command started
  // on: the GitHub reads take seconds, and a branch switched meanwhile would
  // receive another branch's rows.
  const startBranch = write ? await branchOf(context.repoRoot) : null;
  const comments = await fetchExternalComments(context.repoRoot, number, { run });
  const containers = await fetchExternalContainers(context.repoRoot, number, { run });
  const reviewerOptions = reviewers ? { reviewers } : {};
  const entries = [
    ...parseExternalComments(comments, reviewerOptions),
    ...parseExternalContainers(containers.reviews, containers.issueComments, reviewerOptions),
  ];
  const reports = new Map();
  for (const entry of entries) {
    const key = `${entry.headSha}@${entry.createdAt}`;
    if (!reports.has(key)) reports.set(key, await reportForHead(context.paths, entry.headSha, { before: entry.createdAt || null }));
    entry.verdict = entry.severity === 'container'
      ? { saw: 'container: record each finding it holds as its own row', matches: [] }
      : (reports.get(key) ? gateVerdictFor(reports.get(key), entry) : null);
  }
  const rows = renderRows(number, entries);
  const target = ledgerPath || path.join(context.repoRoot, LEDGER_PATH);
  let written = null;
  if (write) {
    const liveBranch = await branchOf(context.repoRoot);
    if (liveBranch !== startBranch) {
      throw new Error(`The checkout switched from ${startBranch || '(detached)'} to ${liveBranch || '(detached)'} while collecting; rerun on a settled checkout.`);
    }
    const current = await readFile(target, 'utf8');
    const { markdown, added } = upsertLedgerSection(current, number, heading || `triaged ${new Date().toISOString().slice(0, 10)}`, rows);
    const counted = recomputeCounters(markdown);
    // The ledger is a tracked file in the author's checkout: the write is
    // atomic (temp + rename) so a failure never leaves a truncated file; two
    // invocations in one checkout are the author's own to sequence, and the
    // diff is reviewed like any other.
    if (counted.markdown !== current) await atomicWriteText(target, counted.markdown);
    written = { path: target, added, prs: counted.prs, rows: counted.rows, open: counted.open };
  }
  return {
    pr: number,
    comments: comments.length,
    entries: entries.map(({ verdict, ...entry }) => ({ ...entry, gateSaw: verdict ? verdict.saw : 'no retained report for that head at or before the comment' })),
    rows,
    written,
  };
}

export function formatLedgerResult(result) {
  const lines = [`PR #${result.pr}: ${result.entries.length} external finding(s)/container(s) from ${result.comments} inline review comment(s), the review bodies and the issue comments.`];
  for (const entry of result.entries) {
    lines.push(`- ${entry.file}${entry.line ? `:${entry.line}` : ''} — ${entry.title} [${entry.severity}] — gate saw: ${entry.gateSaw}`);
  }
  if (result.written) {
    lines.push(`Wrote ${result.written.added} new row(s) to ${result.written.path}; counters: ${result.written.prs} PR(s), ${result.written.rows} row(s), ${result.written.open} open. Complete every TODO cell before pushing.`);
  } else if (result.rows.length) {
    lines.push('', 'Rows (pass --write to add them to the ledger):', ...result.rows);
  }
  return lines.join('\n');
}
