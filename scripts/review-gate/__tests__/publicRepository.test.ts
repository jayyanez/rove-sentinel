// This repository is public and any project can adopt it
// (docs/public-and-generic.md). Names only a maintainer knows stay in the
// ignored file .private-names, so the guard never publishes what it guards.
// Its failures reach public CI logs, so they never print what matched.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const list = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
const pathnames = list('ls-files', '-z');
const tracked = pathnames
  .filter((file) => !/\.(tgz|png)$|^pnpm-lock\.yaml$|^THIRD_PARTY_NOTICES\.txt$/i.test(file));
const THIS_FILE = 'scripts/review-gate/__tests__/publicRepository.test.ts';

// fc00::/7 and fe80::/10, written in full, compressed or ending in IPv4
const HEXTET = '[0-9a-f]{1,4}';
const LOCAL_V6 = new RegExp(`(?<![0-9a-z:])(?:f[cd][0-9a-f]|fe[89ab])[0-9a-f](?:(?::${HEXTET}){7}|(?::${HEXTET}){5}:\\d{1,3}(?:\\.\\d{1,3}){3}|(?::${HEXTET}){0,6}::)`, 'i');

// An address counts as synthetic only whole, so neither a real mailbox at these
// companies nor a real domain that starts like one of these gets through.
const END = String.raw`(?![\w-]|\.\w)`;
// what a local part may hold, but for what delimits an address in prose and code
const LOCAL_CHARACTER = String.raw`[\w.+=!#%&?^~-]`;
const SYNTHETIC_MAILBOX = String.raw`(?:git@github\.com|noreply@anthropic\.com)${END}`;
const SYNTHETIC_DOMAIN = String.raw`(?:(?:[a-z0-9-]+\.)*(?:example(?:\.(?:com|net|org))?|test|invalid)|users\.noreply\.github\.com)${END}`;
const EMAIL = new RegExp(String.raw`(?<!${LOCAL_CHARACTER})(?!${SYNTHETIC_MAILBOX})${LOCAL_CHARACTER}+@(?!${SYNTHETIC_DOMAIN})[a-z0-9-]+\.[a-z]{2,}\b`, 'i');

const PRIVATE: [string, RegExp][] = [
  ['a tailnet address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['a private network address', /\b(?:192\.168|10\.(?!0\.\d{4,5}\b)\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['a unique-local or link-local IPv6 address', LOCAL_V6],
  ['a tailnet name', /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i],
  ['a path on a computer', /\b[A-Z]:[\\/]+Workspaces\b|\b[A-Z]:[\\/]+Users[\\/]+(?!me\b|example\b|runner\b)\w|\/(?:Users|home)\/(?!me\b|example\b|runner\b)\w/i],
  ['an email address', EMAIL]
];

// the maintainer's other repositories, in any spelling; these two are public
const OTHER_REPOSITORY = /\bjayyanez\/(?!rove-sentinel\b|rove-memory\b)[\w.-]+/i;

const privateNames = existsSync('.private-names')
  ? readFileSync('.private-names', 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  : [];
const EVERY_CHECK = [...PRIVATE.map(([, pattern]) => pattern), OTHER_REPOSITORY, ...privateNames];

// what a commit would take: the working file, and what is staged if it differs
const staged = new Set(list('diff', '--cached', '--name-only', '-z', '--diff-filter=d'));
const versions = (file: string) => [
  ...(existsSync(file) ? [readFileSync(file, 'utf8')] : []),
  ...(staged.has(file) ? [execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 2 ** 28 })] : [])
];

// a pathname that fails a check is known by its place in `git ls-files`, never by its text
const place = (file: string, all: string[]) => `tracked pathname #${all.indexOf(file) + 1}`;
const shown = (file: string, all = pathnames) => (EVERY_CHECK.some((check) => check.test(file)) ? place(file, all) : file);

const pathnameHits = (pattern: RegExp, all = pathnames) => all.filter((file) => pattern.test(file)).map((file) => place(file, all));

function contentHits(pattern: RegExp) {
  return tracked.filter((file) => file !== THIS_FILE && versions(file).some((text) => pattern.test(text))).map((file) => shown(file));
}

const hits = (pattern: RegExp) => [...pathnameHits(pattern), ...contentHits(pattern)];

describe('a public repository any project can adopt', () => {
  it.each(PRIVATE)('holds no %s', (_what, pattern) => {
    expect(hits(pattern)).toEqual([]);
  });

  it("names none of the maintainer's other repositories", () => {
    expect(hits(OTHER_REPOSITORY)).toEqual([]);
  });

  it('holds none of the names only a maintainer knows', () => {
    privateNames.forEach((name, index) => {
      expect(hits(name), `entry ${index + 1} of .private-names`).toEqual([]);
    });
  });

  it('never tracks the file of private names', () => {
    expect(pathnames.includes('.private-names')).toBe(false);
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.private-names$/m);
  });
});

describe('what the guard catches', () => {
  it.each([
    'fd00::1', 'fc00::', 'fd7a:115c:a1e0::53', 'fe80::1%eth0', 'FE80::ABCD', 'febf::1', '[fd12:3456::1]:8080',
    'fd12:3456:789a:1:2:3:4:5', 'fe80:0:0:0:1:2:3:4', 'fd00:1:2:3:4:5:192.0.2.1'
  ])('finds the IPv6 address %s', (address) => {
    expect(LOCAL_V6.test(`host ${address} up`)).toBe(true);
  });

  it.each([
    '2001:db8::1', '::1', '::ffff:192.0.2.1', 'fec0::1', 'fd::new', 'fd0::1', 'fe80', 'fd12:3456', 'abfd00::1',
    '0xfe80::1', 'Foo::fd00::Bar'
  ])('leaves %s alone', (text) => {
    expect(LOCAL_V6.test(`host ${text} up`)).toBe(false);
  });

  it.each([
    'someone@github.com', 'someone@anthropic.com', 'someone@noreply.some-company.io', 'agit@github.com',
    'anoreply@anthropic.com', 'git@github.com.some-company.io', 'noreply@anthropic.com.some-company.io',
    'someone@example.some-company.io', 'someone@example.com.some-company.io', 'token:secret@github.com',
    'a=git@github.com', 'a!git@github.com', 'a=noreply@anthropic.com'
  ])('finds the email address %s', (address) => {
    expect(EMAIL.test(`write to ${address}.`)).toBe(true);
  });

  it.each([
    'someone@example.com', 'someone@mail.example.org', 'someone@example.net', 'someone@host.example',
    'someone@site.test', 'someone@site.invalid', 'git@github.com', 'noreply@anthropic.com',
    '123+someone@users.noreply.github.com', 'https://token:secret@example.com/owner/repo.git'
  ])('accepts the synthetic address %s', (address) => {
    expect(EMAIL.test(`write to ${address}.`)).toBe(false);
  });

  it('reads the pathnames of the files it skips for content', () => {
    for (const skipped of ['pnpm-lock.yaml', 'THIRD_PARTY_NOTICES.txt']) {
      expect(tracked.includes(skipped)).toBe(false);
      expect(pathnames.includes(skipped)).toBe(true);
    }
    expect(pathnames.includes(THIS_FILE)).toBe(true);
  });

  it('reports a pathname by its place, keeping the match out of the failure', () => {
    expect(pathnameHits(/a-private-name/i, ['docs/usage.md', 'docs/A-Private-Name/notes.png'])).toEqual(['tracked pathname #2']);
    const leaking = 'docs/someone@some-company.io.md';
    expect(shown(leaking, ['docs/usage.md', leaking])).toBe('tracked pathname #2');
    expect(shown('docs/usage.md', ['docs/usage.md', leaking])).toBe('docs/usage.md');
  });
});
