import { runProcess, subscriptionEnvironment, processTreeCleanupFailureCode } from './process.mjs';
import { PROVIDERS, selectProviders } from './modelSettings.mjs';
import { describeProviderHold, heldProviders } from './usageLimits.mjs';
import { ACCOUNT_VARIABLES } from './accounts.mjs';

/** The providers a requirement asks for, less any a restart dropped. */
function wantedProviders(mode, exclude = []) {
  return mode === 'claude' || mode === 'codex' ? [mode] : PROVIDERS.filter((provider) => !exclude.includes(provider));
}

/**
 * Why a review cannot start because of provider holds, or null. `auto`
 * leaves a held provider out, and fails only when every candidate is held
 * for its usage limit; an explicit requirement never falls back.
 */
export function providerHoldRefusal(mode, holds = {}, candidates = wantedProviders(mode)) {
  const held = heldProviders(mode, candidates, holds);
  if (!held.length) return null;
  const reasons = held.map((provider) => describeProviderHold(provider, holds[provider])).join('; ');
  if (mode === 'auto') {
    return held.length === candidates.length
      ? `No review provider is available: ${reasons}. Rerun after that time, or with --force to try them again now.`
      : null;
  }
  return `Provider requirement ${mode} cannot be satisfied: ${reasons}. Sentinel does not fall back to another provider under an explicit requirement; rerun after that time, or with --force to try again now.`;
}

/**
 * Why a provider's sign-in does not satisfy subscription authentication, or
 * null. Only the CLI's own status command runs; no credential is read.
 */
async function authError(provider, { run, repoRoot, env }) {
  const auth = await run(provider, provider === 'claude' ? ['auth', 'status'] : ['login', 'status'],
    { cwd: repoRoot, env, timeoutMs: 30_000, allowFailure: true });
  if (auth.code !== 0) return `${provider} authentication check failed.`;
  if (provider === 'claude') {
    let status;
    try { status = JSON.parse(auth.stdout); }
    catch { return 'Claude Code authentication status returned invalid JSON.'; }
    if (!status || typeof status !== 'object' || Array.isArray(status) || typeof status.loggedIn !== 'boolean' || typeof status.authMethod !== 'string') {
      return 'Claude Code authentication status returned an unexpected shape.';
    }
    if (!status.loggedIn) return 'Claude Code is not authenticated.';
    if (status.authMethod !== 'claude.ai') return 'Claude Code is not authenticated through a Claude subscription.';
    return null;
  }
  return /^Logged in using ChatGPT\s*$/im.test(`${auth.stdout || ''}\n${auth.stderr || ''}`)
    ? null : 'Codex is not authenticated through ChatGPT.';
}

/**
 * Each configured account's sign-in, by provider and label, probed with only
 * that account's variable set: `{ claude: [{ label, signedIn, error? }] }`.
 */
export async function probeAccountSignIns(repoRoot, accounts, { run = runProcess, env = process.env } = {}) {
  const safeEnv = subscriptionEnvironment(env);
  const result = {};
  await Promise.all(Object.entries(accounts ?? {}).map(async ([provider, list]) => {
    result[provider] = await Promise.all(list.map(async (account) => {
      let error;
      try {
        error = await authError(provider, { run, repoRoot, env: { ...safeEnv, [ACCOUNT_VARIABLES[provider]]: account.folder } });
      } catch (failure) {
        if (processTreeCleanupFailureCode(failure)) throw failure;
        error = `${provider} authentication check could not run.`;
      }
      return { label: account.label, signedIn: !error, ...(error ? { error } : {}) };
    }));
  }));
  return result;
}

/**
 * Probe native subscription authentication without a model call or API billing.
 * `holds` are the live provider holds: under `auto` a held provider is
 * unavailable (a failure hold only while another provider is available),
 * and an explicit requirement that names a usage-limited one is refused.
 * `exclude` names providers the restart after a failure dropped. `accounts`
 * are the review accounts to probe, by provider (docs/plans/review-accounts.md):
 * such a provider is available when one of them is signed in, and the result
 * lists each one's sign-in by label. A provider without accounts is probed
 * with the inherited login, as before.
 */
export async function detectSubscriptions(repoRoot, {
  mode = 'auto', run = runProcess, env = process.env, holds = {}, exclude = [], accounts = null,
} = {}) {
  const safeEnv = subscriptionEnvironment({ ...env, ROVE_REVIEW_ALLOW_API_BILLING: undefined });
  delete safeEnv.ROVE_REVIEW_ALLOW_API_BILLING;
  const wanted = wantedProviders(mode, exclude);
  const refusal = providerHoldRefusal(mode, holds, wanted);
  if (refusal) throw new Error(refusal);
  const held = heldProviders(mode, wanted, holds);
  const availability = {};
  const accountStatus = {};
  const probe = async (provider) => {
    try {
      const version = await run(provider, ['--version'], { cwd: repoRoot, env: safeEnv, timeoutMs: 30_000, allowFailure: true });
      if (version.code !== 0) throw new Error(`${provider} version check failed.`);
      const list = accounts?.[provider];
      if (list?.length) {
        const status = (await probeAccountSignIns(repoRoot, { [provider]: list }, { run, env: safeEnv }))[provider];
        accountStatus[provider] = status;
        if (!status.some((account) => account.signedIn)) {
          throw new Error(`No configured ${provider} account is signed in through its subscription: ${status.map((account) => `${account.label}: ${account.error}`).join(' ')}`);
        }
      } else {
        const error = await authError(provider, { run, repoRoot, env: safeEnv });
        if (error) throw new Error(error);
      }
      const versionText = `${version.stdout || version.stderr || ''}`.trim().split(/\r?\n/)[0];
      availability[provider] = { available: true, version: versionText };
    } catch (error) {
      // An optional provider is not allowed to hide an unverified process tree.
      if (processTreeCleanupFailureCode(error)) throw error;
      availability[provider] = { available: false, error: error?.message || String(error) };
    }
  };
  await Promise.all(wanted.filter((provider) => !held.includes(provider)).map(probe));
  // A failure hold never costs the review its last provider.
  if (mode === 'auto' && !wanted.some((provider) => availability[provider]?.available)) {
    await Promise.all(held.filter((provider) => holds[provider]?.reason === 'provider-failure').map(probe));
  }
  for (const provider of held) {
    availability[provider] ??= { available: false, error: describeProviderHold(provider, holds[provider]), hold: holds[provider] };
  }
  let selected;
  try { selected = selectProviders(mode, wanted.filter((provider) => availability[provider]?.available)); }
  catch (error) {
    const details = wanted.filter((provider) => !availability[provider]?.available)
      .map((provider) => availability[provider]?.error).join(' ');
    throw new Error(`${error.message} ${details}`.trim());
  }
  return { selected, availability, ...(Object.keys(accountStatus).length ? { accounts: accountStatus } : {}) };
}
