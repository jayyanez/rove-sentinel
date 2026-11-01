// This repository is public and any project can adopt it
// (docs/public-and-generic.md). Names only a maintainer knows stay in the
// ignored file .private-names, so the guard never publishes what it guards.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((file) => file && existsSync(file) && !/\.(tgz|png|lock|ya?ml)$|^THIRD_PARTY_NOTICES\.txt$/i.test(file));
const THIS_FILE = 'scripts/review-gate/__tests__/publicRepository.test.ts';

const PRIVATE = [
  ['a tailnet address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['a tailnet name', /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i],
  ['a path on a computer', /\b[A-Z]:[\\/]Workspaces\b|\/Users\/(?!me\b|example\b|runner\b)[a-z]/],
  ['an email address', /\b[\w.+-]+@(?!example\.|github\.com|users\.noreply\.github\.com|noreply\.|anthropic\.com)[a-z0-9-]+\.[a-z]{2,}\b/i]
];

// the maintainer's other repositories, in any spelling; these two are public
const OTHER_REPOSITORY = /\bjayyanez\/(?!rove-sentinel\b|rove-memory\b)[\w.-]+/i;

function hits(pattern: RegExp) {
  return tracked.filter((file) => file !== THIS_FILE && pattern.test(readFileSync(file, 'utf8')));
}

describe('a public repository any project can adopt', () => {
  it.each(PRIVATE)('holds no %s', (_what, pattern) => {
    expect(hits(pattern)).toEqual([]);
  });

  it("names none of the maintainer's other repositories", () => {
    expect(hits(OTHER_REPOSITORY)).toEqual([]);
  });

  it('holds none of the names only a maintainer knows', () => {
    if (!existsSync('.private-names')) return;
    const names = readFileSync('.private-names', 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const name of names) {
      expect(hits(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).length, 'a private name is in a tracked file').toBe(0);
    }
  });

  it('never tracks the file of private names', () => {
    expect(tracked).not.toContain('.private-names');
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.private-names$/m);
  });
});
