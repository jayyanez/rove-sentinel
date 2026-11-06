import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accountKey,
  accountsProviderHold,
  defaultAccountsFile,
  loadAccounts,
  normalizeAccountFolder,
  parseAccounts,
  providerEnvironment,
  rankAccounts,
  readAccountState,
  recordAccountHolds,
  requesterAccountKeys,
} from '../accounts.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { formatGateResult, runGate } from '../gate.mjs';
import { renderGateComment } from '../github.mjs';
import {
  accountsStatus, buildInstallPlan, executeInstallTransaction, explicitAccountsFile, installPrerequisites, verifyPrerequisites,
} from '../install.mjs';
import { subscriptionEnvironment } from '../process.mjs';
import { runReviewer } from '../providers.mjs';
import { ensureState, readAttestation, readReport } from '../storage.mjs';
import { detectSubscriptions, probeAccountSignIns } from '../subscriptions.mjs';
import { ProviderUsageLimitError, markProviderFailure, readProviderHolds } from '../usageLimits.mjs';

// Real repositories and Git worktrees: Windows needs more than the default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

// An account folder on this platform. It need not exist: no test probes it.
const folder = (name: string) => (process.platform === 'win32'
  ? `C:\\Users\\me\\sentinel-accounts\\${name}`
  : `/Users/me/sentinel-accounts/${name}`);

const accountsFile = (claude: string[] = [], codex: string[] = []) => ({
  accounts: {
    ...(claude.length ? { claude: claude.map((label) => ({ label, configDir: folder(`claude-${label}`) })) } : {}),
    ...(codex.length ? { codex: codex.map((label) => ({ label, home: folder(`codex-${label}`) })) } : {}),
  },
});

const configured = (claude: string[] = [], codex: string[] = []) => parseAccounts(accountsFile(claude, codex));

/** No folder of any declared account may appear in `text`. */
function expectNoFolders(text: string) {
  for (const segment of ['sentinel-accounts', 'claude-personal', 'claude-team', 'codex-main', 'codex-spare']) {
    expect(text).not.toContain(segment);
  }
}

describe('the accounts file', () => {
  it('parses labels and absolute folders per provider', () => {
    const parsed = configured(['personal', 'team'], ['main']);
    expect(parsed.claude.map((account: { label: string }) => account.label)).toEqual(['personal', 'team']);
    expect(parsed.claude[1].folder).toBe(folder('claude-team'));
    expect(parsed.codex[0]).toMatchObject({ label: 'main', folder: folder('codex-main'), key: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(parseAccounts({ schemaVersion: 1, accounts: {} })).toBeNull();
    expect(parseAccounts({})).toBeNull();
  });

  it.each([
    ['a non-object', [], /JSON object/],
    ['an unknown top-level key', { accounts: {}, extra: 1 }, /unknown key "extra"/],
    ['another schema', { schemaVersion: 2 }, /schemaVersion must be 1/],
    ['an unknown provider', { accounts: { grok: [] } }, /unknown provider "grok"/],
    ['a list that is not a list', { accounts: { claude: {} } }, /must be a list/],
    ['an entry key of the other provider', { accounts: { claude: [{ label: 'a', home: folder('a') }] } }, /unknown key "home"/],
    ['an extra entry key', { accounts: { codex: [{ label: 'a', home: folder('a'), token: 'x' }] } }, /unknown key "token"/],
    ['a missing label', { accounts: { codex: [{ home: folder('a') }] } }, /needs a "label"/],
    ['a label with a space', { accounts: { codex: [{ label: 'my team', home: folder('a') }] } }, /needs a "label"/],
    ['a relative folder', { accounts: { claude: [{ label: 'a', configDir: 'relative/claude' }] } }, /absolute path of its CLAUDE_CONFIG_DIR/],
    ['a missing folder', { accounts: { codex: [{ label: 'a' }] } }, /absolute path of its CODEX_HOME/],
    ['a duplicate label in another case', { accounts: { claude: [{ label: 'Team', configDir: folder('a') }, { label: 'team', configDir: folder('b') }] } }, /labelled "team"/],
    ['one folder under two labels', { accounts: { claude: [{ label: 'a', configDir: folder('same') }, { label: 'b', configDir: `${folder('same')}${path.sep}` }] } }, /"a" and "b" name the same folder/],
    ['too many accounts', { accounts: { claude: Array.from({ length: 9 }, (_, index) => ({ label: `a${index}`, configDir: folder(`a${index}`) })) } }, /at most 8/],
  ])('refuses %s, without quoting a folder', (_name, value, message) => {
    let error: Error | undefined;
    try { parseAccounts(value); } catch (caught) { error = caught as Error; }
    expect(error?.message).toMatch(message);
    expectNoFolders(error?.message ?? '');
  });

  it('accepts the same label for two providers', () => {
    expect(parseAccounts({ accounts: {
      claude: [{ label: 'main', configDir: folder('claude-main') }], codex: [{ label: 'main', home: folder('codex-main') }],
    } })).toMatchObject({ claude: [{ label: 'main' }], codex: [{ label: 'main' }] });
  });

  it('reads the default place when present, and a named file only when it exists', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'sentinel-accounts-home-'));
    temporaryDirectories.push(home);
    const env = { LOCALAPPDATA: path.join(home, 'local'), XDG_STATE_HOME: path.join(home, 'state') };
    // Nothing configured: no file at the default place.
    expect(await loadAccounts({ env, home })).toBeNull();
    const target = defaultAccountsFile({ env, home });
    expect(path.basename(target)).toBe('accounts.json');
    expect(path.basename(path.dirname(target))).toBe('shared-review-gate');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(accountsFile(['personal'])));
    expect((await loadAccounts({ env, home }))?.claude?.[0].label).toBe('personal');
    // The variable and the flag name another file, which must exist.
    const named = path.join(home, 'elsewhere.json');
    await expect(loadAccounts({ env: { ...env, ROVE_SENTINEL_ACCOUNTS: named }, home })).rejects.toThrow(/named by ROVE_SENTINEL_ACCOUNTS, could not be read \(ENOENT\)/);
    await expect(loadAccounts({ file: named, env, home })).rejects.toThrow(/named by --accounts/);
    await writeFile(named, '{ not json');
    await expect(loadAccounts({ file: named, env, home })).rejects.toThrow(/not JSON/);
    await writeFile(named, JSON.stringify(accountsFile([], ['main'])));
    expect((await loadAccounts({ env: { ...env, ROVE_SENTINEL_ACCOUNTS: named }, home }))?.codex?.[0].label).toBe('main');
  });
});

describe('the author account', () => {
  it('is the requesting process folder, or the CLI default when unset, matched by normalized path', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/Users/me';
    const keys = requesterAccountKeys({}, { home });
    expect(keys.claude).toBe(accountKey(normalizeAccountFolder(path.join(home, '.claude'))));
    expect(keys.codex).toBe(accountKey(normalizeAccountFolder(path.join(home, '.codex'))));
    // A trailing separator and, on Windows, letter case do not make another account.
    const named = requesterAccountKeys({ CLAUDE_CONFIG_DIR: `${folder('claude-team')}${path.sep}` }, { home });
    expect(named.claude).toBe(configured(['team']).claude[0].key);
    const windows = (value: string) => accountKey(normalizeAccountFolder(value, { platform: 'win32' }));
    expect(windows('C:\\Users\\me\\Claude-Team')).toBe(windows('c:\\users\\me\\claude-team\\'));
    const posix = (value: string) => accountKey(normalizeAccountFolder(value, { platform: 'darwin' }));
    expect(posix('/Users/me/Claude')).not.toBe(posix('/Users/me/claude'));
  });
});

describe('choosing an account', () => {
  const list = configured(['personal', 'team', 'spare']).claude;
  const keyOf = (label: string) => list.find((account: { label: string }) => account.label === label).key;
  const hold = (reason: string) => ({ reason, since: new Date().toISOString(), resetAt: null, retryAfter: new Date(Date.now() + 3_600_000).toISOString(), message: 'held' });

  it("never chooses the author's own account while another is usable", () => {
    const ranked = rankAccounts(list, { authorKey: keyOf('personal') });
    expect(ranked.map((account: { label: string }) => account.label)).toEqual(['team', 'spare', 'personal']);
    expect(ranked[2].authorOwn).toBe(true);
  });

  it('prefers an account with no hold, and rotates by last use', () => {
    const lastUsed = { team: new Date(Date.now() - 1000).toISOString(), spare: new Date(Date.now() - 5000).toISOString() };
    expect(rankAccounts(list, { lastUsed }).map((account: { label: string }) => account.label)).toEqual(['personal', 'spare', 'team']);
    expect(rankAccounts(list, { lastUsed: { ...lastUsed, personal: new Date().toISOString() } })[0].label).toBe('spare');
    // A failure hold ranks after every free account, the author's included;
    // a usage limit is never chosen.
    const ranked = rankAccounts(list, { holds: { spare: hold('provider-failure'), team: hold('usage-limit') }, authorKey: keyOf('personal') });
    expect(ranked.map((account: { label: string; held: unknown }) => [account.label, Boolean(account.held)])).toEqual([['personal', false], ['spare', true]]);
    expect(rankAccounts(list, { excluded: ['personal'], signedIn: ['personal', 'spare'] }).map((account: { label: string }) => account.label)).toEqual(['spare']);
  });

  it('holds the provider only when every account it may still use is held', () => {
    expect(accountsProviderHold('claude', list, { personal: hold('usage-limit'), team: hold('usage-limit') })).toBeNull();
    const limited = accountsProviderHold('claude', list, { personal: hold('usage-limit'), team: hold('usage-limit') }, { excluded: ['spare'] });
    expect(limited).toMatchObject({ reason: 'usage-limit', accounts: ['personal', 'team'] });
    expect(accountsProviderHold('claude', list, { personal: hold('usage-limit'), team: hold('provider-failure'), spare: hold('usage-limit') }))
      .toMatchObject({ reason: 'provider-failure' });
  });
});

describe('each reviewer process', () => {
  it('gets only its own account variable, and today environment without one', () => {
    const source = { ANTHROPIC_API_KEY: 'do-not-use', OPENAI_API_KEY: 'do-not-use', PATH: 'bin' };
    const [team] = configured(['team']).claude;
    const env = providerEnvironment('claude', team, source);
    expect(env.CLAUDE_CONFIG_DIR).toBe(folder('claude-team'));
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('bin');
    expect(providerEnvironment('codex', null, source)).toEqual(subscriptionEnvironment(source));
  });

  it('runs the provider CLI with the account the review chose', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sentinel-accounts-run-'));
    temporaryDirectories.push(directory);
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ structured_output: { review_complete: true, effort_request: null, summary: 'ok', candidates: [] } }) }));
    const [codexMain] = configured([], ['main']).codex;
    const providerExecutions: Array<Record<string, unknown>> = [];
    await runReviewer({ provider: 'claude', roleIndex: 0, checkout: directory, runner, bundle: {
      directory, contextPath: path.join(directory, 'ctx.md'), providerExecutions,
      accounts: { claude: { label: 'team', folder: folder('claude-team') }, codex: { label: 'main', folder: codexMain.folder } },
    } });
    const [, , options] = runner.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(folder('claude-team'));
    expect(Object.values(options.env)).not.toContain(codexMain.folder);
    // The execution record names the label alone.
    expect(providerExecutions[0]).toMatchObject({ provider: 'claude', account: 'team' });
    expectNoFolders(JSON.stringify(providerExecutions));
  });
});

describe('subscription detection with accounts', () => {
  const signedIn = (labels: string[], list: Array<{ label: string; folder: string }>) => vi.fn(async (command: string, args: string[], options: { env: Record<string, string> }) => {
    if (args[0] === '--version') return { code: 0, stdout: `${command} 1.0`, stderr: '' };
    const variable = command === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const account = list.find((entry) => entry.folder === options.env[variable]);
    const yes = Boolean(account && labels.includes(account.label));
    return { code: 0, stderr: '', stdout: command === 'claude'
      ? JSON.stringify({ loggedIn: yes, authMethod: 'claude.ai' })
      : yes ? 'Logged in using ChatGPT' : 'Not logged in' };
  });

  it("probes each account with its own folder and lists sign-ins by label", async () => {
    const accounts = configured(['personal', 'team']);
    const run = signedIn(['team'], accounts.claude);
    const result = await detectSubscriptions('repo', { mode: 'claude', run, env: { PATH: 'bin' }, accounts });
    expect(result.selected).toEqual(['claude']);
    expect(result.accounts.claude).toEqual([
      { label: 'personal', signedIn: false, error: 'Claude Code is not authenticated.' },
      { label: 'team', signedIn: true },
    ]);
    const authCalls = run.mock.calls.filter(([, args]) => args[0] === 'auth');
    expect(authCalls.map(([, , options]) => options.env.CLAUDE_CONFIG_DIR).sort()).toEqual([folder('claude-personal'), folder('claude-team')].sort());
    await expect(detectSubscriptions('repo', { mode: 'claude', run: signedIn([], accounts.claude), env: {}, accounts }))
      .rejects.toThrow(/No configured claude account is signed in through its subscription: personal: .* team: /);
  });

  it('probes the inherited login, unchanged, when nothing is configured', async () => {
    const run = signedIn([], []);
    run.mockImplementation(async (command: string, args: string[], options: { env: Record<string, string> }) => {
      expect(options.env.CLAUDE_CONFIG_DIR).toBe('inherited');
      return args[0] === '--version' ? { code: 0, stdout: '1.0', stderr: '' } : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' };
    });
    const result = await detectSubscriptions('repo', { mode: 'claude', run, env: { CLAUDE_CONFIG_DIR: 'inherited' } });
    expect(result).toEqual({ selected: ['claude'], availability: { claude: { available: true, version: '1.0' } } });
  });

  it('status lists each account by label: signed in, hold and last review', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-accounts-status-'));
    temporaryDirectories.push(stateRoot);
    const paths = await ensureState(stateRoot);
    await recordAccountHolds(paths, [{ provider: 'claude', label: 'personal', reason: 'usage-limit', resetAt: Date.now() + 3_600_000, message: 'limit' }]);
    const accounts = configured(['personal', 'team']);
    const status = await accountsStatus({ repoRoot: 'repo', paths }, { load: async () => accounts, run: signedIn(['team'], accounts.claude) });
    expect(status).toMatchObject({ claude: [
      { label: 'personal', signedIn: false, hold: { reason: 'usage-limit' }, lastUsed: null },
      { label: 'team', signedIn: true, hold: null, lastUsed: null },
    ] });
    expectNoFolders(JSON.stringify(status));
    expect(await accountsStatus({ repoRoot: 'repo', paths }, { load: async () => null })).toBeNull();
    expect(await accountsStatus({ repoRoot: 'repo', paths }, { load: async () => { throw new Error('invalid'); } })).toEqual({ error: 'invalid' });
  });
});

// --- Reviews -----------------------------------------------------------------

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A change of two shards: `src/a.ts` and `src/b.ts`, 300 lines each. */
async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-accounts-review-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git');
  await writeFile(path.join(root, 'README.md'), '# base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  for (const name of ['a', 'b']) {
    await writeFile(path.join(root, 'src', `${name}.ts`), Array.from({ length: 300 }, (_, index) => `export const ${name}${index} = ${index};`).join('\n'));
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'two shards');
  const head = git(root, 'rev-parse', 'HEAD');
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-accounts-state-'));
  temporaryDirectories.push(stateRoot);
  return { root, base, head, stateRoot };
}

function policy(providers?: string) {
  return reviewPolicySnapshot({ charter: '# Charter\n', lessons: '# Lessons\n', ...(providers ? { config: { providers } } : {}) });
}

const limit = (provider: 'claude' | 'codex') => new ProviderUsageLimitError(provider, {
  resetAt: Date.now() + 4 * 24 * 3_600_000,
  message: "You've hit your usage limit. Upgrade to Pro or try again in 4 days.",
});

type Call = { provider: string; roleIndex: number; bundle: { accounts?: Record<string, { label: string; folder: string }> } };
const accountOf = (call: Call) => call.bundle.accounts?.[call.provider]?.label ?? null;
const reviewed = ({ provider, roleIndex }: Call) => ({ provider, roleIndex, summary: 'Reviewed.', candidates: [] });

async function review(options: Record<string, unknown>) {
  const { root, base, head, stateRoot } = await makeRepository();
  const progress: string[] = [];
  const calls: Array<{ provider: string; account: string | null }> = [];
  const shardReviewer = options.shardReviewer as (call: Call) => unknown;
  const run = () => runGate({
    repoRoot: root, stateRoot, base, head, author: 'claude', risk: 'high', policy: policy(),
    availableProviders: ['claude', 'codex'],
    scout: async () => ({ summary: 'No hypotheses', hypotheses: [] }),
    deterministicLanes: async () => ({ lanes: [], findings: [] }),
    progress: (line: string) => progress.push(line),
    ...options,
    shardReviewer: async (call: Call) => {
      calls.push({ provider: call.provider, account: accountOf(call) });
      return shardReviewer(call);
    },
  });
  return { run, progress, calls, stateRoot, root, head, paths: await ensureState(stateRoot) };
}

async function exists(target: string) {
  return access(target).then(() => true, () => false);
}

describe('a review with nothing configured', () => {
  it('is the review of today: no account fields, no account state, the provider fallback unchanged', async () => {
    for (const extra of [{}, { accounts: null, requesterAccounts: requesterAccountKeys({}) }]) {
      const { run, progress, paths } = await review({
        ...extra,
        shardReviewer: async (call: Call) => {
          if (call.provider === 'codex') throw limit('codex');
          expect(call.bundle.accounts).toEqual({});
          return reviewed(call);
        },
      });
      const result = await run();
      expect(result).toMatchObject({ status: 'pass', providerSelection: ['claude'], providerFallback: { dropped: ['codex'], reason: 'usage-limit', restarted: true } });
      expect(result).not.toHaveProperty('accounts');
      expect(result).not.toHaveProperty('accountFallbacks');
      const report = await readReport(paths, result.reportId);
      expect(report).not.toHaveProperty('accounts');
      expect(await readProviderHolds(paths)).toMatchObject({ codex: { reason: 'usage-limit' } });
      expect(await exists(paths.accountState)).toBe(false);
      expect(progress.some((line) => /^codex usage limit reached \(retry after .+\); restarting this review with claude only\.$/.test(line))).toBe(true);
      expect(formatGateResult(result)).not.toMatch(/Account/);
    }
  });
});

describe('a review with accounts', () => {
  it("excludes the author's own account, and names the account used by label", async () => {
    const accounts = configured(['personal', 'team']);
    const { run, calls, paths } = await review({
      policy: policy('claude'), accounts,
      requesterAccounts: requesterAccountKeys({ CLAUDE_CONFIG_DIR: folder('claude-personal') }),
      shardReviewer: async (call: Call) => {
        expect(call.bundle.accounts).toEqual({ claude: { label: 'team', folder: folder('claude-team') } });
        return reviewed(call);
      },
    });
    const result = await run();
    expect(result).toMatchObject({ status: 'pass', accounts: { claude: { label: 'team', authorOwn: false } } });
    expect(calls.every((call) => call.account === 'team')).toBe(true);
    expect(formatGateResult(result)).toContain('Accounts: claude "team"');
    expect((await readAccountState(paths)).lastUsed.claude).toHaveProperty('team');
    expectNoFolders(JSON.stringify(result));
    expectNoFolders(await readFile(paths.accountState, 'utf8'));
  });

  it("uses the author's own account as the last resort, and says so everywhere", async () => {
    const accounts = configured(['personal', 'team']);
    const { run, progress, paths, stateRoot } = await review({
      policy: policy('claude'), accounts,
      requesterAccounts: requesterAccountKeys({ CLAUDE_CONFIG_DIR: folder('claude-personal') }),
      shardReviewer: async (call: Call) => reviewed(call),
    });
    await recordAccountHolds(await ensureState(stateRoot), [{ provider: 'claude', label: 'team', reason: 'usage-limit', resetAt: Date.now() + 3_600_000, message: 'limit' }]);
    const result = await run();
    expect(result).toMatchObject({ status: 'pass', accounts: { claude: { label: 'personal', authorOwn: true } } });
    expect(progress).toContain('No other claude account is usable; this review uses the author\'s own claude account "personal".');
    const text = formatGateResult(result);
    expect(text).toContain('Author\'s account: claude reviewed under the author\'s own account "personal"; no other claude account was usable.');
    expect(unescaped(renderGateComment(result))).toContain('the author\'s own account "personal"');
    const report = await readReport(paths, result.reportId);
    expect(report.accounts).toEqual({ claude: { label: 'personal', authorOwn: true } });
    const attestation = await readAttestation(paths, result.identity);
    expect(attestation.accounts).toEqual({ claude: { label: 'personal', authorOwn: true } });
    for (const evidence of [JSON.stringify(result), JSON.stringify(report), JSON.stringify(attestation), text, renderGateComment(result)]) expectNoFolders(evidence);
  });

  it('says the author account is unknown when the request did not carry it', async () => {
    const { run } = await review({ policy: policy('claude'), accounts: configured(['personal']), shardReviewer: async (call: Call) => reviewed(call) });
    expect((await run()).accounts).toEqual({ claude: { label: 'personal', authorOwn: null } });
  });

  it('refuses a malformed author identity from a request', async () => {
    const { run } = await review({
      accounts: configured(['personal']), requesterAccounts: { claude: folder('claude-personal') }, shardReviewer: async (call: Call) => reviewed(call),
    });
    await expect(run()).rejects.toThrow(/author account identity is malformed/);
  });

  it("moves to the provider's next account on a usage limit before the provider is dropped", async () => {
    const accounts = configured([], ['main', 'spare']);
    const { run, progress, calls, paths } = await review({
      accounts,
      shardReviewer: async (call: Call) => {
        if (call.provider === 'codex' && accountOf(call) === 'main') throw limit('codex');
        return reviewed(call);
      },
    });
    const result = await run();
    expect(result.status).toBe('pass');
    // Codex kept reviewing, under its other account: no provider fallback.
    expect(result.providerSelection).toEqual(['claude', 'codex']);
    expect(result).not.toHaveProperty('providerFallback');
    expect(result.accounts).toEqual({ codex: { label: 'spare' } });
    expect(result.accountFallbacks).toEqual([{ provider: 'codex', from: 'main', to: 'spare', reason: 'usage-limit', resetAt: expect.any(String), retryAfter: expect.any(String) }]);
    expect(progress.some((line) => /^codex account "main" usage limit reached \(retry after .+\); restarting this review with another codex account\.$/.test(line))).toBe(true);
    expect(calls.filter((call) => call.provider === 'codex').map((call) => call.account)).toEqual(['main', 'spare']);
    // The hold is the account's, never the provider's.
    expect((await readAccountState(paths)).holds.codex).toMatchObject({ main: { reason: 'usage-limit' } });
    expect(await readProviderHolds(paths)).toEqual({});
    const text = formatGateResult(result);
    expect(text).toContain('Account fallback: codex account "main" left out after its usage limit');
    expect(text).toContain('the review restarted from scratch with "spare"');
    expect(unescaped(renderGateComment(result))).toContain('codex account "main" left out after its usage limit');
    const report = await readReport(paths, result.reportId);
    expect(report.accountFallbacks).toHaveLength(1);
    expectNoFolders(JSON.stringify(report));
  });

  it("moves to the next account after a failure, and drops the provider only when none remains", async () => {
    const accounts = configured([], ['main', 'spare']);
    const { run, progress, calls, paths } = await review({
      accounts,
      shardReviewer: async (call: Call) => {
        if (call.provider === 'codex' && accountOf(call) === 'main') throw markProviderFailure(new Error('codex crashed'));
        if (call.provider === 'codex') throw limit('codex');
        return reviewed(call);
      },
    });
    const result = await run();
    expect(result).toMatchObject({ status: 'pass', providerSelection: ['claude'], providerFallback: { dropped: ['codex'], reason: 'usage-limit', restarted: true } });
    expect(result.accountFallbacks).toEqual([expect.objectContaining({ provider: 'codex', from: 'main', to: 'spare', reason: 'provider-failure' })]);
    expect(progress.some((line) => /^codex account "main" failed twice \(codex crashed\); restarting this review with another codex account\.$/.test(line))).toBe(true);
    expect(progress.some((line) => /^codex account "spare" usage limit reached .*; restarting this review with claude only\.$/.test(line))).toBe(true);
    // Two codex accounts tried (main with its retry), then claude alone.
    expect(calls.filter((call) => call.provider === 'codex').map((call) => call.account)).toEqual(['main', 'main', 'spare']);
    const { holds } = await readAccountState(paths);
    expect(holds.codex).toMatchObject({ main: { reason: 'provider-failure' }, spare: { reason: 'usage-limit' } });
    // The next auto review leaves codex out: every account of it is held.
    expect(formatGateResult(result)).toContain('Provider fallback: codex left out after its usage limit');
  });

  it('switches accounts under an explicit requirement, and never the provider', async () => {
    const { run, calls } = await review({
      policy: policy('codex'), accounts: configured([], ['main', 'spare']),
      shardReviewer: async (call: Call) => {
        if (accountOf(call) === 'main') throw limit('codex');
        return reviewed(call);
      },
    });
    const result = await run();
    expect(result).toMatchObject({ status: 'pass', providerSelection: ['codex'], accounts: { codex: { label: 'spare' } } });
    expect(result).not.toHaveProperty('providerFallback');
    expect(calls.every((call) => call.provider === 'codex')).toBe(true);

    const single = await review({
      policy: policy('codex'), accounts: configured([], ['main']),
      shardReviewer: async (call: Call) => { throw limit(call.provider as 'codex'); },
    });
    await expect(single.run()).rejects.toThrow(/codex account "main" usage limit reached/);
    expect(single.calls.every((call) => call.provider === 'codex')).toBe(true);
    expect(single.progress.some((line) => line.includes('restarting'))).toBe(false);
  });

  it('refuses an explicit requirement when every account is held for its usage limit', async () => {
    const { run, stateRoot } = await review({
      policy: policy('codex'), accounts: configured([], ['main', 'spare']), shardReviewer: async (call: Call) => reviewed(call),
    });
    await recordAccountHolds(await ensureState(stateRoot), ['main', 'spare'].map((label) => ({ provider: 'codex', label, reason: 'usage-limit', resetAt: Date.now() + 3_600_000, message: 'limit' })));
    await expect(run()).rejects.toThrow(/every configured codex account \(main, spare\) is held back by its usage limit/);
  });
});

/** A GitHub comment escapes Markdown; read it as text. */
function unescaped(markdown: string) {
  return markdown.split(String.fromCharCode(92)).join('');
}

// --- Gate review of ce97208 ---------------------------------------------------

describe('gate review of the review accounts (ce97208)', () => {
  it('reads a corrupt account state as empty, and a review goes on, under --force too', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-accounts-corrupt-'));
    temporaryDirectories.push(stateRoot);
    const paths = await ensureState(stateRoot);
    await writeFile(paths.accountState, '{ not json');
    expect(await readAccountState(paths)).toEqual({ holds: { claude: {}, codex: {} }, lastUsed: { claude: {}, codex: {} } });
    for (const force of [false, true]) {
      const { run, paths: reviewPaths } = await review({ policy: policy('claude'), accounts: configured(['team']), force, shardReviewer: async (call: Call) => reviewed(call) });
      await writeFile(reviewPaths.accountState, '{ not json');
      expect((await run()).accounts).toEqual({ claude: { label: 'team', authorOwn: null } });
    }
  });

  it('install verifies the prerequisites with the accounts file, as doctor does', async () => {
    const accounts = configured(['team']);
    const load = vi.fn(async () => accounts);
    const verify = vi.fn(async () => ({ verified: true }));
    const env = { ROVE_SENTINEL_ACCOUNTS: folder('accounts.json') };
    expect(await installPrerequisites('repo', { config: { providers: 'claude' }, accountsFile: undefined, env, load, verify })).toEqual({ verified: true });
    expect(load).toHaveBeenCalledWith({ file: undefined, env });
    expect(verify).toHaveBeenCalledWith('repo', { config: { providers: 'claude' }, accounts });
  });

  it('carries an explicitly named accounts file into the scheduled watcher, and only then', () => {
    expect(explicitAccountsFile({ env: {} })).toBeNull();
    expect(explicitAccountsFile({ env: { ROVE_SENTINEL_ACCOUNTS: 'accounts.json' } })).toBe(path.resolve('accounts.json'));
    expect(explicitAccountsFile({ file: 'mine.json', env: { ROVE_SENTINEL_ACCOUNTS: 'other.json' } })).toBe(path.resolve('mine.json'));
    const windows = (accountsFile?: string) => buildInstallPlan({
      platform: 'win32', repoRoot: 'D:\\project', stateRoot: 'C:\\state', nodePath: 'C:\\node.exe', environment: {}, accountsFile,
    }).wrapper;
    expect(windows('C:\\Users\\me\\accounts.json')).toContain('set "ROVE_SENTINEL_ACCOUNTS=C:\\Users\\me\\accounts.json"');
    expect(windows()).not.toContain('ROVE_SENTINEL_ACCOUNTS');
    const mac = (accountsFile?: string) => buildInstallPlan({
      platform: 'darwin', repoRoot: '/Users/me/project', stateRoot: '/Users/me/state', nodePath: '/usr/local/bin/node',
      home: '/Users/me', uid: 501, environment: {}, accountsFile,
    }).plist;
    expect(mac('/Users/me/accounts & more.json')).toContain('<key>ROVE_SENTINEL_ACCOUNTS</key><string>/Users/me/accounts &amp; more.json</string>');
    expect(mac()).not.toContain('ROVE_SENTINEL_ACCOUNTS');
  });

  it('waits for every account probe before it reports a cleanup failure', async () => {
    const accounts = configured(['personal', 'team'], ['main']);
    const cleanup = Object.assign(new Error('unverified process tree'), { code: 'PROCESS_TREE_CLEANUP_FAILED' });
    const settled: string[] = [];
    const run = vi.fn(async (command: string, args: string[], options: { env: Record<string, string> }) => {
      if (args[0] === '--version') return { code: 0, stdout: '1.0', stderr: '' };
      if (command === 'claude' && options.env.CLAUDE_CONFIG_DIR === folder('claude-personal')) throw cleanup;
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled.push(command === 'claude' ? options.env.CLAUDE_CONFIG_DIR : options.env.CODEX_HOME);
      return { code: 0, stdout: command === 'claude' ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : 'Logged in using ChatGPT', stderr: '' };
    });
    await expect(probeAccountSignIns('repo', accounts, { run, env: {} })).rejects.toBe(cleanup);
    expect(settled.sort()).toEqual([folder('claude-team'), folder('codex-main')].sort());
    settled.length = 0;
    await expect(detectSubscriptions('repo', { run, env: {}, accounts })).rejects.toBe(cleanup);
    expect(settled.sort()).toEqual([folder('claude-team'), folder('codex-main')].sort());
  });

  it('pins the reviewed commit for every restart: a provider restart and an account restart', async () => {
    for (const accounts of [null, configured([], ['main', 'spare'])]) {
      const state = { root: '', moved: false };
      const { run, head, root } = await review({
        head: 'HEAD', accounts,
        shardReviewer: async (call: Call) => {
          if (call.provider === 'codex' && (!accounts || accountOf(call) === 'main')) {
            // The checkout moves on while the first round runs.
            if (!state.moved) {
              git(state.root, 'commit', '--allow-empty', '-m', 'later');
              state.moved = true;
            }
            throw limit('codex');
          }
          return reviewed(call);
        },
      });
      state.root = root;
      const result = await run();
      expect(state.moved).toBe(true);
      expect(result.status).toBe('pass');
      expect(result.identity.headSha).toBe(head);
      expect(result.lineage.branch).toBe('main');
      expect(accounts ? result.accountFallbacks : result.providerFallback).toBeTruthy();
    }
  });

  it('refuses an inherited token that would override a configured account, and only then', async () => {
    expect(() => providerEnvironment('claude', configured(['team']).claude[0], { CLAUDE_CODE_OAUTH_TOKEN: 'secret' }))
      .toThrow(/CLAUDE_CODE_OAUTH_TOKEN is set.*unset it/);
    expect(() => providerEnvironment('codex', configured([], ['main']).codex[0], { CODEX_ACCESS_TOKEN: 'secret' }))
      .toThrow(/CODEX_ACCESS_TOKEN is set/);
    expect(() => providerEnvironment('codex', configured([], ['main']).codex[0], { CODEX_API_KEY: 'secret' }))
      .toThrow(/CODEX_API_KEY is set/);
    expect(providerEnvironment('claude', null, { CLAUDE_CODE_OAUTH_TOKEN: 'secret' }).CLAUDE_CODE_OAUTH_TOKEN).toBe('secret');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'secret');
    try {
      const withAccounts = await review({ policy: policy('claude'), accounts: configured(['team']), shardReviewer: async (call: Call) => reviewed(call) });
      let error: Error | undefined;
      try {
        await withAccounts.run();
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(/CLAUDE_CODE_OAUTH_TOKEN is set.*unset it/);
      expect(error?.message).not.toContain('secret');
      expect(withAccounts.calls).toEqual([]);
      // Without accounts nothing changes, and codex accounts are not affected.
      const without = await review({ policy: policy('claude'), shardReviewer: async (call: Call) => reviewed(call) });
      expect((await without.run()).status).toBe('pass');
      const codexOnly = await review({ policy: policy('codex'), accounts: configured([], ['main']), shardReviewer: async (call: Call) => reviewed(call) });
      expect((await codexOnly.run()).status).toBe('pass');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('doctor probes every configured account, not only those of the required providers', async () => {
    const accounts = configured(['team'], ['main']);
    const run = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: `${command} 1.0`, stderr: '' };
      if (command === 'git' || command === 'gh') return { code: 0, stdout: `${command} ok`, stderr: '' };
      return { code: 0, stdout: command === 'claude' ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) : 'Logged in using ChatGPT', stderr: '' };
    });
    const result = await verifyPrerequisites('repo', { run, env: {}, config: { providers: 'claude' }, accounts });
    expect(result.accounts).toEqual({ claude: [{ label: 'team', signedIn: true }], codex: [{ label: 'main', signedIn: true }] });
    expect(result.providers.selected).toEqual(['claude']);
    expect(await verifyPrerequisites('repo', { run, env: {}, config: { providers: 'claude' } })).not.toHaveProperty('accounts');
  });
});

// --- Gate review of 638f7be ---------------------------------------------------

describe('gate review of the review accounts (638f7be)', () => {
  it('doctor and install wait for every prerequisite probe before a cleanup failure', async () => {
    const cleanup = Object.assign(new Error('unverified process tree'), { code: 'PROCESS_TREE_CLEANUP_FAILED' });
    for (const accounts of [null, configured(['team'], ['main'])]) {
      const settled: string[] = [];
      const run = vi.fn(async (command: string, args: string[]) => {
        if (args[0] === '--version' && command !== 'git') return { code: 0, stdout: `${command} 1.0`, stderr: '' };
        if (command === 'claude') throw cleanup;
        await new Promise((resolve) => setTimeout(resolve, 50));
        settled.push(command);
        if (command === 'git' || command === 'gh') return { code: 0, stdout: `${command} ok`, stderr: '' };
        return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      });
      await expect(verifyPrerequisites('repo', { run, env: {}, config: { providers: 'claude' }, ...(accounts ? { accounts } : {}) })).rejects.toBe(cleanup);
      // git and gh, and the codex account probe when accounts are configured.
      expect(settled.sort()).toEqual(accounts ? ['codex', 'gh', 'git'] : ['gh', 'git']);
    }
  });

  it('gives a detached watcher an explicitly named accounts file, and nothing otherwise', async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sentinel-accounts-detached-'));
    temporaryDirectories.push(stateRoot);
    const paths = await ensureState(stateRoot);
    const file = folder('accounts.json');
    for (const accountsFile of [file, undefined]) {
      const plan = buildInstallPlan({ platform: 'linux', repoRoot: '/home/example/project', stateRoot, accountsFile });
      const startDetached = vi.fn(async () => {});
      await executeInstallTransaction({
        context: { repoRoot: '/home/example/project', stateRoot, paths }, plan, policy: { gateVersion: 'new' }, currentHooks: '.githooks', start: true,
      }, {
        git: vi.fn(async () => ''), startDetached, stop: vi.fn(async () => {}), waitHeartbeat: vi.fn(async () => ({ gateVersion: 'new' })),
      });
      const options = (startDetached.mock.calls[0] as unknown[])[2] as { environment?: Record<string, string> } | undefined;
      if (accountsFile) expect(options?.environment?.ROVE_SENTINEL_ACCOUNTS).toBe(file);
      else expect(options?.environment?.ROVE_SENTINEL_ACCOUNTS).toBeUndefined();
    }
  });

  it('refuses an overriding credential only for a provider the requirement can use', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'secret');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'secret');
    try {
      const accounts = configured(['team'], ['main']);
      const codexOnly = await review({ policy: policy('codex'), accounts, shardReviewer: async (call: Call) => reviewed(call) });
      await expect(codexOnly.run()).rejects.toThrow(/CODEX_ACCESS_TOKEN is set/);
      vi.stubEnv('CODEX_ACCESS_TOKEN', '');
      // Claude accounts and its token do not matter to a codex-only review.
      const passing = await review({ policy: policy('codex'), accounts, shardReviewer: async (call: Call) => reviewed(call) });
      expect(await passing.run()).toMatchObject({ status: 'pass', providerSelection: ['codex'], accounts: { codex: { label: 'main' } } });
      // Under auto both providers can review: the Claude token refuses it.
      const auto = await review({ accounts, shardReviewer: async (call: Call) => reviewed(call) });
      await expect(auto.run()).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN is set/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
