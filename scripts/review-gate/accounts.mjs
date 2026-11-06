import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LIMITS } from './constants.mjs';
import { atomicWriteJson, readJson, removeStoredJson, stateRootFor } from './storage.mjs';
import { subscriptionEnvironment } from './process.mjs';
import { providerHoldRecord, strongerHold, validHoldRecord } from './usageLimits.mjs';

/**
 * Review accounts: several logins of the same provider CLI, declared by the
 * user in a machine-local file and chosen among per review. See
 * docs/plans/review-accounts.md.
 *
 * A folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) is a path on one person's
 * machine: it is read from the accounts file, compared as a digest of its
 * normalized form, and set only in a reviewer process's environment. Only a
 * label ever reaches a report, an attestation, a comment or a log.
 */

export const ACCOUNT_PROVIDERS = Object.freeze(['claude', 'codex']);
export const ACCOUNT_VARIABLES = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });
const FOLDER_KEYS = Object.freeze({ claude: 'configDir', codex: 'home' });
// Each CLI's folder when its variable is unset (its own documentation).
const DEFAULT_FOLDERS = Object.freeze({ claude: '.claude', codex: '.codex' });
export const ACCOUNTS_FILE_VARIABLE = 'ROVE_SENTINEL_ACCOUNTS';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const ACCOUNT_KEY = /^[0-9a-f]{32}$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Labels are object keys: never read an inherited property such as `constructor`.
const own = (object, key) => (isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined);

/** The accounts file's default place: beside the per-repository state folders. */
export function defaultAccountsFile({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(pathApi.dirname(stateRootFor('accounts', { platform, env, home })), 'accounts.json');
}

function isAbsoluteFolder(value, platform) {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
  return path.posix.isAbsolute(value);
}

/** A folder resolved, its links followed when it exists, and case-folded on Windows. */
export function normalizeAccountFolder(folder, { platform = process.platform, realpath = realpathSync.native } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let resolved = pathApi.resolve(folder);
  try {
    if (platform === process.platform) resolved = pathApi.resolve(realpath(resolved));
  } catch {
    // A folder that does not exist yet is compared as written.
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The digest a folder is compared by; the folder itself never travels. */
export function accountKey(normalizedFolder) {
  return createHash('sha256').update(normalizedFolder).digest('hex').slice(0, 32);
}

/**
 * The accounts file's contents, validated strictly, or null when it declares
 * none. `{ claude: [{ label, folder, key }], codex: [...] }`. An error never
 * quotes a folder.
 */
export function parseAccounts(value, { platform = process.platform, realpath } = {}) {
  const fail = (detail) => { throw new Error(`Sentinel's accounts file is invalid: ${detail}`); };
  const name = (key) => JSON.stringify(String(key).slice(0, 40));
  if (!isObject(value)) fail('it must be a JSON object.');
  for (const key of Object.keys(value)) {
    if (!['schemaVersion', 'accounts'].includes(key)) fail(`unknown key ${name(key)}; it takes "schemaVersion" and "accounts".`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) fail('schemaVersion must be 1.');
  const accounts = value.accounts ?? {};
  if (!isObject(accounts)) fail('"accounts" must be an object of claude and codex lists.');
  for (const key of Object.keys(accounts)) {
    if (!ACCOUNT_PROVIDERS.includes(key)) fail(`unknown provider ${name(key)}; accounts are declared for claude and codex.`);
  }
  const parsed = {};
  for (const provider of ACCOUNT_PROVIDERS) {
    const list = own(accounts, provider);
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > LIMITS.maxAccountsPerProvider) {
      fail(`"${provider}" must be a list of at most ${LIMITS.maxAccountsPerProvider} accounts.`);
    }
    const folderKey = FOLDER_KEYS[provider];
    const labels = new Map();
    const folders = new Map();
    parsed[provider] = list.map((entry, index) => {
      const where = `${provider} account ${index + 1}`;
      if (!isObject(entry)) fail(`${where} must be an object with "label" and "${folderKey}".`);
      for (const key of Object.keys(entry)) {
        if (key !== 'label' && key !== folderKey) fail(`${where} has an unknown key ${name(key)}; a ${provider} account takes "label" and "${folderKey}".`);
      }
      const { label } = entry;
      if (typeof label !== 'string' || !LABEL.test(label)) {
        fail(`${where} needs a "label" of 1 to 32 letters, digits, ".", "_" or "-", starting with a letter or a digit.`);
      }
      if (labels.has(label.toLowerCase())) fail(`two ${provider} accounts are labelled "${label}"; labels are unique per provider.`);
      labels.set(label.toLowerCase(), label);
      const folder = entry[folderKey];
      // eslint-disable-next-line no-control-regex
      if (typeof folder !== 'string' || folder.length > 1024 || /[\u0000-\u001f]/.test(folder) || !isAbsoluteFolder(folder, platform)) {
        fail(`${provider} account "${label}" needs "${folderKey}": the absolute path of its ${ACCOUNT_VARIABLES[provider]} folder.`);
      }
      const key = accountKey(normalizeAccountFolder(folder, { platform, realpath }));
      if (folders.has(key)) fail(`${provider} accounts "${folders.get(key)}" and "${label}" name the same folder.`);
      folders.set(key, label);
      return Object.freeze({ label, folder, key });
    });
    if (!parsed[provider].length) delete parsed[provider];
  }
  return Object.keys(parsed).length ? parsed : null;
}

/**
 * The user's accounts: from `file` (the `--accounts` flag), else the file
 * `ROVE_SENTINEL_ACCOUNTS` names, else the default place. A file named
 * explicitly must exist; the default one may be absent (no accounts).
 */
export async function loadAccounts({
  file, env = process.env, platform = process.platform, home = os.homedir(), read = readFile, realpath,
} = {}) {
  const named = file || env[ACCOUNTS_FILE_VARIABLE] || null;
  const source = file ? '--accounts' : ACCOUNTS_FILE_VARIABLE;
  const target = named ? path.resolve(named) : defaultAccountsFile({ platform, env, home });
  let text;
  try {
    text = await read(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !named) return null;
    throw new Error(`Sentinel's accounts file${named ? `, named by ${source},` : ''} could not be read (${error?.code || 'error'}).`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Sentinel's accounts file is invalid: it is not JSON.");
  }
  return parseAccounts(value, { platform, realpath });
}

/**
 * The account of the process that asks for a review, per provider: the digest
 * of its `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, or of the CLI's default folder
 * when the variable is unset. A request queued for the watcher carries this,
 * never a path.
 */
export function requesterAccountKeys(env = process.env, { platform = process.platform, home = os.homedir(), realpath } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return Object.fromEntries(ACCOUNT_PROVIDERS.map((provider) => [provider, accountKey(normalizeAccountFolder(
    env[ACCOUNT_VARIABLES[provider]] || pathApi.join(home, DEFAULT_FOLDERS[provider]), { platform, realpath },
  ))]));
}

/** A requester identity from a request, checked; null when none was sent. */
export function checkedRequesterAccounts(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || Object.keys(value).some((key) => !ACCOUNT_PROVIDERS.includes(key) || !ACCOUNT_KEY.test(value[key]))) {
    throw new Error("The review request's author account identity is malformed.");
  }
  return value;
}

/**
 * A reviewer process's environment: the subscription environment with only
 * its account's variable set. Without an account it is today's environment.
 */
export function providerEnvironment(provider, account = null, source = process.env) {
  const env = subscriptionEnvironment(source);
  if (account?.folder && ACCOUNT_VARIABLES[provider]) env[ACCOUNT_VARIABLES[provider]] = account.folder;
  return env;
}

// --- Account holds and rotation ------------------------------------------
//
// `account-state.json` in the repository's state folder: per provider and
// label, the live hold (`usage-limit` or `provider-failure`, the same records
// as a provider hold) and when the account last reviewed. Keyed by label,
// never by folder.

function emptyState() {
  return { holds: {}, lastUsed: {} };
}

async function readRawState(paths) {
  let value;
  try {
    value = await readJson(paths.accountState, null);
  } catch {
    // A corrupt record holds nothing back.
    return emptyState();
  }
  const state = emptyState();
  for (const provider of ACCOUNT_PROVIDERS) {
    const holds = own(own(value, 'holds'), provider);
    const used = own(own(value, 'lastUsed'), provider);
    state.holds[provider] = Object.fromEntries(Object.entries(isObject(holds) ? holds : {})
      .filter(([label, record]) => LABEL.test(label) && validHoldRecord(record))
      .map(([label, record]) => [label, { reason: 'usage-limit', ...record }]));
    state.lastUsed[provider] = Object.fromEntries(Object.entries(isObject(used) ? used : {})
      .filter(([label, at]) => LABEL.test(label) && typeof at === 'string' && Number.isFinite(Date.parse(at))));
  }
  return state;
}

async function writeState(paths, state) {
  const empty = ACCOUNT_PROVIDERS.every((provider) => !Object.keys(state.holds[provider] ?? {}).length
    && !Object.keys(state.lastUsed[provider] ?? {}).length);
  if (empty) await removeStoredJson(paths.accountState);
  else await atomicWriteJson(paths.accountState, state);
}

/** Live account holds and the last use of each account, by provider and label. */
export async function readAccountState(paths, { now = Date.now() } = {}) {
  const state = await readRawState(paths);
  for (const provider of ACCOUNT_PROVIDERS) {
    state.holds[provider] = Object.fromEntries(Object.entries(state.holds[provider])
      .filter(([, record]) => Date.parse(record.retryAfter) > now));
  }
  return state;
}

/** One account's hold in holds by provider, or undefined. */
export function accountHoldOf(holds, provider, label) {
  return own(own(holds, provider), label);
}

/** Record holds of accounts (`{ provider, label, reason, resetAt, message }`); the stronger hold wins. */
export async function recordAccountHolds(paths, hits, { now = Date.now() } = {}) {
  const state = await readAccountState(paths, { now });
  const added = [];
  for (const hit of hits) {
    if (!ACCOUNT_PROVIDERS.includes(hit?.provider) || !LABEL.test(hit?.label ?? '')) continue;
    const record = providerHoldRecord(hit, { now });
    const holds = state.holds[hit.provider];
    if (strongerHold(record, own(holds, hit.label))) {
      holds[hit.label] = record;
      added.push(hit);
    }
  }
  if (added.length) await writeState(paths, state);
  return state.holds;
}

/** Accounts that just completed work have their holds removed. */
export async function clearAccountHolds(paths, accounts) {
  const state = await readRawState(paths);
  let changed = false;
  for (const { provider, label } of accounts) {
    if (own(state.holds[provider], label)) {
      delete state.holds[provider][label];
      changed = true;
    }
  }
  if (changed) await writeState(paths, state);
}

/** The accounts a round starts with: the rotation's record. */
export async function markAccountsUsed(paths, accounts, { now = Date.now() } = {}) {
  if (!accounts.length) return;
  const state = await readRawState(paths);
  for (const { provider, label } of accounts) state.lastUsed[provider][label] = new Date(now).toISOString();
  await writeState(paths, state);
}

// --- Choosing an account ---------------------------------------------------

/**
 * The accounts a review may use for one provider, best first. Left out: an
 * account this review already fell back from (`excluded`), one not signed in
 * (`signedIn`, when probed), and one held for its usage limit. Ranked: free
 * accounts other than the author's, then the author's own (the owner's last
 * resort), then accounts held for a failure; within a rank the least
 * recently used, then the file's order. No CLI documents a supported way to
 * read a subscription's remaining allowance, so the rotation is Sentinel's
 * own record.
 */
export function rankAccounts(list = [], {
  holds = {}, lastUsed = {}, authorKey = null, excluded = [], signedIn = null,
} = {}) {
  const usable = list.filter((account) => !excluded.includes(account.label)
    && (!signedIn || signedIn.includes(account.label))
    && own(holds, account.label)?.reason !== 'usage-limit');
  const rank = (account) => (own(holds, account.label) ? 2 : 0) + (authorKey !== null && account.key === authorKey ? 1 : 0);
  const used = (account) => Date.parse(own(lastUsed, account.label) ?? '') || 0;
  return usable
    .map((account, index) => ({ account, index }))
    .sort((a, b) => rank(a.account) - rank(b.account) || used(a.account) - used(b.account) || a.index - b.index)
    .map(({ account }) => ({ ...account, authorOwn: authorKey !== null && account.key === authorKey, held: own(holds, account.label) ?? null }));
}

/**
 * A provider-wide hold derived from its accounts, for the provider selection
 * of docs/plans/provider-usage-limit-fallback.md: held only when every
 * account the review may still use is held. Its reason is a usage limit when
 * all of them are limited, otherwise a failure; its retry time is the
 * soonest of them. Null when one is free, or none remains.
 */
export function accountsProviderHold(provider, list = [], holds = {}, { excluded = [] } = {}) {
  const remaining = list.filter((account) => !excluded.includes(account.label));
  const records = remaining.map((account) => own(holds, account.label));
  if (!remaining.length || records.some((record) => !record)) return null;
  const limited = records.every((record) => record.reason === 'usage-limit');
  const pool = limited ? records : records.filter((record) => record.reason === 'provider-failure');
  const soonest = pool.reduce((best, record) => (Date.parse(record.retryAfter) < Date.parse(best.retryAfter) ? record : best));
  return {
    ...soonest,
    reason: limited ? 'usage-limit' : 'provider-failure',
    accounts: remaining.map((account) => account.label),
    message: `every configured ${provider} account is held (${remaining.map((account) => account.label).join(', ')})`,
  };
}

/** "claude account \"team\" usage limit reached; retry after …" */
export function describeAccountHold(provider, label, record) {
  return record.reason === 'provider-failure'
    ? `${provider} account "${label}" failed a recent review and is held back; retry after ${record.retryAfter}`
    : `${provider} account "${label}" usage limit reached; retry after ${record.retryAfter}`;
}

/** The lines a result, a report's reader or a comment shows about accounts. */
export function formatAccounts(result) {
  const lines = [];
  const selection = isObject(result?.accounts) ? result.accounts : null;
  if (selection && Object.keys(selection).length) {
    lines.push(`Accounts: ${Object.entries(selection).map(([provider, account]) => `${provider} "${account.label}"`).join(', ')}`);
  }
  for (const fallback of Array.isArray(result?.accountFallbacks) ? result.accountFallbacks : []) {
    const why = fallback.reason === 'provider-failure' ? 'it failed and its retry failed' : 'its usage limit';
    lines.push(`Account fallback: ${fallback.provider} account "${fallback.from}" left out after ${why} (retry after ${fallback.retryAfter ?? 'unknown'}); the review restarted from scratch with "${fallback.to}".`);
  }
  for (const [provider, account] of Object.entries(selection ?? {})) {
    if (account.authorOwn === true) {
      lines.push(`Author's account: ${provider} reviewed under the author's own account "${account.label}"; no other ${provider} account was usable.`);
    }
  }
  return lines;
}
